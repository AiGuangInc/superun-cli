/** 验证失效识别、真实登录协议复用、MCP 授权后续接和业务防重。@author xiuyu.yi */
import assert from "node:assert/strict";
import { before, after, beforeEach, test } from "node:test";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createSuperunMcpServer } from "../dist/commands/mcp.js";
import { AuthorizationManager } from "../dist/auth/authorization.js";
import { loginWithBrowser, loginWithPassword } from "../dist/auth/strategies.js";
import { loadSession, saveSession, clearSession, decodeJwt } from "../dist/auth/session.js";
import { request } from "../dist/transport/client.js";

const originalEnv = Object.fromEntries(
  ["SUPERUN_HOME", "XDG_CACHE_HOME", "SUPERUN_NO_OPEN"].map((key) => [key, process.env[key]]),
);
const privatePoll = "private-poll-must-not-leak";
const now = () => Math.floor(Date.now() / 1000);
const jwt = (sub, exp = now() + 3600, oauth = true) =>
  "head." +
  Buffer.from(
    JSON.stringify({ sub, email: `${sub}@example.test`, ...(oauth ? { client_id: "client-1" } : {}), exp }),
  ).toString("base64url") +
  ".signature";
let root, baseUrl, httpServer, app, client, mcpServer;
let outcome, refreshMode, requestFailure, expiresIn, nextSubject, starts, polls, refreshes, writes, businessRequests;
let grants = new Map();
let issued = new Map();
let refreshWait, refreshStarted;

const jsonFile = (file, value) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
};
const value = (result) => result.structuredContent?.result ?? JSON.parse(result.content[0].text);
const expired = (sub = "user-1", seconds = -10) => ({
  access_token: jwt(sub, now() + seconds),
  refresh_token: "old-refresh",
  expires_at: now() + seconds,
  strategy: "browser",
});

before(async () => {
  root = mkdtempSync(join(tmpdir(), "superun-reauthorization-"));
  process.env.SUPERUN_HOME = join(root, "config");
  process.env.XDG_CACHE_HOME = join(root, "cache");
  process.env.SUPERUN_NO_OPEN = "1";
  httpServer = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString();
    const url = new URL(req.url, baseUrl);
    const prefix = url.pathname.startsWith("/debug/") ? "/debug" : "";
    const path = url.pathname.slice(prefix.length);
    const target = baseUrl + prefix;
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (path === "/functions/v1/superun-oauth/requests") {
      starts++;
      if (requestFailure) return send(503, { error: "unavailable" });
      const input = JSON.parse(text);
      const id = `request-${starts}`;
      grants.set(id, { challenge: input.code_challenge, prefix });
      const redirect = target + "/functions/v1/superun-oauth/callback";
      const auth = new URL(target + "/auth/v1/oauth/authorize");
      auth.search = new URLSearchParams({
        response_type: "code",
        client_id: "client-1",
        redirect_uri: redirect,
        state: id,
        code_challenge: input.code_challenge,
        code_challenge_method: "S256",
      });
      return send(201, {
        request_id: id,
        poll_token: privatePoll,
        client_id: "client-1",
        redirect_uri: redirect,
        authorization_url: auth.href,
        expires_in: expiresIn,
        interval: 1,
      });
    }
    if (path === "/functions/v1/superun-oauth/poll") {
      polls++;
      const input = JSON.parse(text);
      assert.equal(input.poll_token, privatePoll);
      if (outcome === "denied") return send(403, { error: "access_denied" });
      if (outcome === "expired") return send(410, { error: "expired_request" });
      if (outcome !== "authorized") return send(202, { status: "pending" });
      return send(200, { status: "authorized", code: input.request_id });
    }
    if (path === "/auth/v1/oauth/token" || path === "/auth/v1/token") {
      const oauth = path.includes("/oauth/");
      const input = new URLSearchParams(oauth ? text : JSON.parse(text));
      if (oauth) assert.equal(input.get("client_id"), "client-1");
      else input.set("grant_type", url.searchParams.get("grant_type"));
      if (input.get("grant_type") === "refresh_token") {
        refreshes++;
        if (refreshMode === "delayed") {
          refreshStarted?.();
          await refreshWait;
        }
        if (refreshMode === "temporary") return send(503, { error: "unavailable" });
        if (refreshMode === "network") return req.socket.destroy();
        if (refreshMode === "client-invalid") return send(400, { error: "invalid_client" });
        if (refreshMode === "invalid") return send(400, { error: "invalid_grant" });
      } else if (input.get("grant_type") === "authorization_code") {
        assert.equal(input.get("grant_type"), "authorization_code");
        const grant = grants.get(input.get("code"));
        if (grant)
          assert.equal(createHash("sha256").update(input.get("code_verifier")).digest("base64url"), grant.challenge);
      } else assert.equal(input.get("grant_type"), "password");
      const token = jwt(nextSubject, now() + 3600, oauth);
      issued.set(prefix, token);
      return send(200, { access_token: token, refresh_token: "new-refresh-must-not-leak", expires_in: 3600 });
    }
    if (path === "/rest/v1/") return send(200, { paths: { "/records": { get: {} } } });
    if (path === "/rest/v1/records" || path === "/functions/v1/records/create") {
      businessRequests++;
      if (["business401", "business401-jwt-message"].includes(requestFailure))
        return send(401, {
          code: "APP_RULE_DENIED",
          message: requestFailure === "business401" ? "业务拒绝" : "JWT expired",
        });
      if (requestFailure === "forbidden") return send(403, { message: "权限不足" });
      if (req.headers.authorization !== `Bearer ${issued.get(prefix)}`)
        return send(401, { code: "PGRST301", message: "JWT expired" });
      if (path.endsWith("/create")) {
        writes++;
        return send(200, { id: "created-1" });
      }
      return send(200, [{ id: "record-1" }]);
    }
    send(404, {});
  });
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
  const dir = join(process.env.SUPERUN_HOME, "apps", "reauthorize");
  app = {
    id: "reauthorize",
    scopeId: "reauthorize",
    baseUrl,
    anonKey: "public-key",
    environment: "production",
    runtimeDir: dir,
    dir,
    targets: { production: { baseUrl, anonKey: "public-key" } },
  };
  jsonFile(join(dir, "app.json"), { id: app.id, url: baseUrl, anonKey: app.anonKey, environment: "production" });
  jsonFile(join(dir, "functions/index.json"), {
    schemaVersion: 1,
    groups: [{ name: "records" }],
    functions: [{ name: "records/create", group: "records", verifyJwt: true }],
  });
  jsonFile(join(dir, "functions/records/create.json"), {
    name: "records/create",
    group: "records",
    method: "post",
    verifyJwt: true,
    input: { type: "object", required: ["label"], properties: { label: { type: "string" } } },
  });
});

beforeEach(() => {
  outcome = "pending";
  refreshMode = "invalid";
  requestFailure = false;
  expiresIn = 300;
  nextSubject = "user-1";
  starts = 0;
  polls = 0;
  refreshes = 0;
  writes = 0;
  businessRequests = 0;
  grants.clear();
  issued.clear();
  refreshWait = undefined;
  refreshStarted = undefined;
  saveSession(app.scopeId, expired());
});

after(async () => {
  await client?.close().catch(() => {});
  await mcpServer?.close().catch(() => {});
  await new Promise((resolve) => httpServer.close(resolve));
  for (const [key, previous] of Object.entries(originalEnv)) {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
  rmSync(root, { recursive: true, force: true });
});

test("MCP：登录失效到重新登录，再继续同一写任务，业务只执行一次", async () => {
  const [c, s] = InMemoryTransport.createLinkedPair();
  mcpServer = createSuperunMcpServer(app);
  await mcpServer.connect(s);
  client = new Client({ name: "authorization-test", version: "1" });
  await client.connect(c);
  const args = { name: "records/create", input: { label: "原任务" }, userConfirmed: true };
  const failure = await client.callTool({ name: "call_function", arguments: args });
  assert.equal(failure.isError, true);
  assert.equal(value(failure).code, "AUTH_REQUIRED");
  assert.equal(value(failure).safeToRetry, true);
  assert.equal(businessRequests, 0);
  const start = value(await client.callTool({ name: "start_authorization", arguments: { mode: "managed" } }));
  assert.equal(start.status, "pending");
  assert(start.expiresAt > now() && start.expiresAt <= now() + 300);
  const duplicate = value(await client.callTool({ name: "start_authorization", arguments: { mode: "managed" } }));
  assert.equal(duplicate.authorizationId, start.authorizationId);
  assert.equal(starts, 1);
  assert(!JSON.stringify(start).includes(privatePoll));
  assert(!JSON.stringify(start).includes("old-refresh"));
  outcome = "authorized";
  const completed = value(
    await client.callTool({
      name: "authorization_status",
      arguments: { authorizationId: start.authorizationId, waitSeconds: 3 },
    }),
  );
  assert.equal(completed.status, "authorized");
  assert.equal(completed.canContinueTask, true);
  assert.equal(completed.identity.sub, "user-1");
  assert(!JSON.stringify(completed).includes("new-refresh"));
  assert.equal(writes, 0, "授权流程不能自动重放业务操作");
  const resumed = await client.callTool({ name: "call_function", arguments: args });
  assert.equal(resumed.isError, undefined);
  assert.equal(value(resumed).status, 200);
  assert.equal(writes, 1);
  await client.callTool({ name: "authorization_status", arguments: { authorizationId: start.authorizationId } });
  assert.equal(writes, 1);
  const rows = await client.callTool({ name: "query_rows", arguments: { table: "records" } });
  assert.equal(value(rows).status, 200, "同一 MCP 连接直接读取新会话");
  await client.close();
  await mcpServer.close();
});

test("续期故障保留凭据并提供重新登录，403 和业务 401 不触发登录", async () => {
  const original = loadSession(app.scopeId);
  refreshMode = "temporary";
  await assert.rejects(request(app, original, { path: "/rest/v1/records", auth: true }), (error) => {
    assert.equal(error.code, "AUTH_TEMPORARY_FAILURE");
    assert.equal(error.toJSON().nextAction, "start_authorization");
    assert.equal(error.toJSON().safeToRetry, true);
    assert.match(error.message, /重新登录/);
    assert.deepEqual(error.toJSON().loginCommands.managed.args, [
      "--app",
      app.id,
      "--env",
      "production",
      "login",
      "--managed",
    ]);
    return true;
  });
  assert.deepEqual(loadSession(app.scopeId), original);
  assert.equal(businessRequests, 0);
  refreshMode = "client-invalid";
  await assert.rejects(request(app, original, { path: "/rest/v1/records", auth: true }), (error) => {
    assert.equal(error.code, "AUTH_REFRESH_FAILED");
    assert.equal(error.toJSON().nextAction, "start_authorization");
    assert.match(error.message, /重新登录/);
    return true;
  });
  assert.deepEqual(loadSession(app.scopeId), original);
  assert.equal(businessRequests, 0);
  saveSession(app.scopeId, { ...original, expires_at: now() + 3600 });
  for (const failure of ["business401", "business401-jwt-message", "forbidden"]) {
    requestFailure = failure;
    const before = refreshes;
    const result = await request(app, loadSession(app.scopeId), {
      path: "/functions/v1/records/create",
      method: "POST",
      body: { label: "任务" },
      auth: true,
    });
    assert.equal(result.status, failure.startsWith("business401") ? 401 : 403);
    assert.equal(refreshes, before);
  }
  assert.equal(writes, 0);
});

test("MCP：续期遇到网络、服务或配置错误后，重新登录可在同一连接继续任务", async () => {
  const [c, s] = InMemoryTransport.createLinkedPair();
  const server = createSuperunMcpServer(app);
  const connection = new Client({ name: "login-fallback", version: "1" });
  await server.connect(s);
  await connection.connect(c);
  try {
    const args = { name: "records/create", input: { label: "原任务" }, userConfirmed: true };
    for (const mode of ["network", "temporary", "client-invalid"]) {
      saveSession(app.scopeId, expired());
      refreshMode = mode;
      outcome = "pending";
      const previous = loadSession(app.scopeId);
      const failure = value(await connection.callTool({ name: "call_function", arguments: args }));
      assert.equal(failure.code, mode === "client-invalid" ? "AUTH_REFRESH_FAILED" : "AUTH_TEMPORARY_FAILURE");
      assert.equal(failure.nextAction, "start_authorization");
      assert.equal(failure.safeToRetry, true);
      assert.deepEqual(loadSession(app.scopeId), previous);
      const beforeWrites = writes;
      const start = value(await connection.callTool({ name: "start_authorization", arguments: { mode: "managed" } }));
      assert.equal(start.status, "pending");
      outcome = "authorized";
      const completed = value(
        await connection.callTool({
          name: "authorization_status",
          arguments: { authorizationId: start.authorizationId, waitSeconds: 3 },
        }),
      );
      assert.equal(completed.status, "authorized");
      assert.equal(completed.canContinueTask, true);
      assert.equal(writes, beforeWrites);
      const result = value(await connection.callTool({ name: "call_function", arguments: args }));
      assert.equal(result.status, 200);
      assert.equal(writes, beforeWrites + 1);
    }
  } finally {
    await connection.close();
    await server.close();
  }
});

test("重新登录服务也失败时返回终态、保留凭据，不自动再次发起", async () => {
  requestFailure = true;
  const previous = loadSession(app.scopeId);
  const manager = new AuthorizationManager(app);
  try {
    const start = await manager.start("managed");
    assert.equal(start.status, "failed");
    assert.match(start.message, /登录失败/);
    assert.equal(start.canContinueTask, false);
    const status = await manager.status(start.authorizationId, 1);
    assert.equal(status.status, "failed");
    assert.equal(status.nextAction, undefined);
    assert.equal(starts, 1);
    assert.equal(polls, 0);
    assert.deepEqual(loadSession(app.scopeId), previous);
  } finally {
    manager.close();
  }
});

test("写请求发出后才发现登录失效时，明确要求先核验结果", async () => {
  const session = { ...expired(), expires_at: now() + 3600 };
  await assert.rejects(
    request(app, session, {
      path: "/functions/v1/records/create",
      method: "POST",
      body: { label: "任务" },
      auth: true,
    }),
    (error) => {
      assert.equal(error.code, "AUTH_REQUIRED");
      assert.equal(error.safeToRetry, false);
      return true;
    },
  );
  assert.equal(businessRequests, 1);
  assert.equal(writes, 0);
});

test("原有密码登录、新旧浏览器及托管会话仍可提前刷新和在认证 401 后续期", async () => {
  refreshMode = "valid";
  const password = await loginWithPassword(app, "user-1@example.test", "demo-password");
  assert.equal(password.strategy, "password");
  assert.equal(password.oauth, undefined);
  for (const mode of ["password", "browser-legacy", "browser", "managed"]) {
    for (const reactive of [false, true]) {
      const session = {
        ...expired(),
        strategy: mode === "browser-legacy" ? "browser" : mode,
        ...(mode === "password" ? { access_token: jwt("user-1", now() - 10, false) } : {}),
        expires_at: reactive ? now() + 3600 : now() - 10,
        ...(["browser", "managed"].includes(mode)
          ? { oauth: { client_id: "client-1", token_url: baseUrl + "/auth/v1/oauth/token" } }
          : {}),
      };
      saveSession(app.scopeId, session);
      const count = refreshes;
      const result = await request(app, session, { path: "/rest/v1/records", auth: true });
      assert.equal(result.status, 200, `${mode}/${reactive}`);
      assert.equal(refreshes - count, 1);
      const saved = loadSession(app.scopeId);
      assert.equal(saved.refresh_token, "new-refresh-must-not-leak");
      if (mode === "password") assert.equal(saved.oauth, undefined);
      else assert.equal(saved.oauth.client_id, "client-1");
    }
  }
});

test("首次未登录时 MCP 返回可执行的项目和环境参数", async () => {
  clearSession(app.scopeId);
  const [c, s] = InMemoryTransport.createLinkedPair();
  const server = createSuperunMcpServer(app);
  await server.connect(s);
  const connection = new Client({ name: "no-session", version: "1" });
  await connection.connect(c);
  try {
    const result = value(await connection.callTool({ name: "query_rows", arguments: { table: "records" } }));
    assert.equal(result.code, "AUTH_REQUIRED");
    assert.deepEqual(result.loginCommands.managed.args, ["--app", app.id, "--env", "production", "login", "--managed"]);
  } finally {
    await connection.close();
    await server.close();
  }
});

test("重新授权成其他账号后，提示确认账号，不自动继续原任务", async () => {
  const manager = new AuthorizationManager(app);
  try {
    const start = await manager.start("managed");
    nextSubject = "another-user";
    outcome = "authorized";
    const status = await manager.status(start.authorizationId, 3);
    assert.equal(status.status, "authorized");
    assert.equal(status.requiresAccountConfirmation, true);
    assert.equal(status.canContinueTask, false);
    assert.equal(writes, 0);
  } finally {
    manager.close();
  }
});

test("用户拒绝或授权过期时保留旧会话，不自动再次发起", async () => {
  for (const state of ["denied", "expired"]) {
    outcome = state;
    const previous = loadSession(app.scopeId);
    const manager = new AuthorizationManager(app);
    try {
      const start = await manager.start("managed");
      const status = await manager.status(start.authorizationId, 3);
      assert.equal(status.status, state);
      assert.equal(status.canContinueTask, false);
      assert.deepEqual(loadSession(app.scopeId), previous);
    } finally {
      manager.close();
    }
  }
  assert.equal(starts, 2);
});

test("到期定时器和连接关闭都会结束等待，不遗留轮询", async () => {
  expiresIn = 1;
  const manager = new AuthorizationManager(app);
  const start = await manager.start("managed");
  assert.equal((await manager.status(start.authorizationId, 2)).status, "expired");
  manager.close();
  expiresIn = 300;
  const cancelled = new AuthorizationManager(app);
  const next = await cancelled.start("managed");
  cancelled.close();
  assert.equal((await cancelled.status(next.authorizationId)).status, "cancelled");
  const count = polls;
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(polls, count);
});

test("授权等待期间用户退出登录，迟到的授权结果不能重新写回凭据", async () => {
  const manager = new AuthorizationManager(app);
  try {
    const start = await manager.start("managed");
    clearSession(app.scopeId);
    outcome = "authorized";
    assert.equal((await manager.status(start.authorizationId, 3)).status, "cancelled");
    assert.equal(loadSession(app.scopeId), null);
  } finally {
    manager.close();
  }
});

test("测试环境授权只写自己的会话，未知授权 ID 不可查询", async () => {
  const production = loadSession(app.scopeId);
  const debug = {
    ...app,
    environment: "debug",
    scopeId: app.id + "/debug",
    baseUrl: baseUrl + "/debug",
    runtimeDir: join(app.dir, "environments/debug"),
  };
  const manager = new AuthorizationManager(debug);
  try {
    const start = await manager.start("managed");
    outcome = "authorized";
    const status = await manager.status(start.authorizationId, 3);
    assert.equal(status.environment, "debug");
    assert.equal(status.status, "authorized");
    assert.equal(decodeJwt(loadSession(debug.scopeId).access_token).sub, "user-1");
    assert.deepEqual(loadSession(app.scopeId), production);
    assert.equal((await manager.status("other-request")).code, "AUTHORIZATION_NOT_FOUND");
  } finally {
    manager.close();
  }
});

test("浏览器登录仍可独立使用，并且可被 MCP 关闭时取消", async () => {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  let callback;
  const previous = console.error;
  console.error = (message) => {
    const auth = new URL(String(message).match(/http:\/\/\S+/)[0]);
    const redirect = new URL(auth.searchParams.get("redirect_uri"));
    redirect.searchParams.set("code", "browser-code");
    redirect.searchParams.set("state", auth.searchParams.get("state"));
    callback = fetch(redirect).then((response) => response.text());
  };
  try {
    const session = await loginWithBrowser(app, {
      port,
      authorizeUrl: baseUrl + "/auth/v1/oauth/authorize",
      tokenUrl: baseUrl + "/auth/v1/oauth/token",
      clientId: "client-1",
    });
    await callback;
    assert.equal(session.oauth.client_id, "client-1");
  } finally {
    console.error = previous;
  }
  const controller = new AbortController();
  let ready;
  const readyPromise = new Promise((resolve) => {
    ready = resolve;
  });
  const login = loginWithBrowser(app, {
    port,
    authorizeUrl: baseUrl + "/auth/v1/oauth/authorize",
    tokenUrl: baseUrl + "/auth/v1/oauth/token",
    clientId: "client-1",
    signal: controller.signal,
    onAuthorizationReady: ready,
  });
  await readyPromise;
  controller.abort();
  await assert.rejects(login, (error) => error.status === "cancelled");
});

test("浏览器拒绝授权和错误 state 仍会失败并释放回调端口", async () => {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  for (const denied of [true, false]) {
    let callback;
    const login = loginWithBrowser(app, {
      port,
      authorizeUrl: baseUrl + "/auth/v1/oauth/authorize",
      tokenUrl: baseUrl + "/auth/v1/oauth/token",
      clientId: "client-1",
      onAuthorizationReady: ({ url }) => {
        const auth = new URL(url);
        const redirect = new URL(auth.searchParams.get("redirect_uri"));
        redirect.searchParams.set("state", denied ? auth.searchParams.get("state") : "wrong-state");
        if (denied) redirect.searchParams.set("error", "access_denied");
        else redirect.searchParams.set("code", "demo");
        callback = fetch(redirect).then((response) => response.text());
      },
    });
    await assert.rejects(login, (error) => (denied ? error.status === "denied" : /State mismatch/.test(error.message)));
    await callback;
  }
});

test("真实 CLI 将需要授权作为结构化错误输出，保持失败退出码", async () => {
  jsonFile(join(process.env.SUPERUN_HOME, "update-policy.json"), { checkedAt: Date.now(), latestVersion: "0.1.6" });
  const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  const result = await new Promise((resolve) => {
    execFile(
      process.execPath,
      [cli, "--app", app.id, "--env", "production", "db", "select", "records"],
      {
        env: {
          PATH: process.env.PATH,
          SUPERUN_HOME: process.env.SUPERUN_HOME,
          XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
        },
      },
      (error, stdout, stderr) => resolve({ exitCode: error?.code, stdout, stderr }),
    );
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, "");
  const output = JSON.parse(result.stderr.trim());
  assert.equal(output.code, "AUTH_REQUIRED");
  assert.equal(output.environment, "production");
  assert(!result.stderr.includes("old-refresh"));
  assert.equal(businessRequests, 0);
});

test("MCP 断开会取消尚未完成的登录，不在断开后覆盖会话", async () => {
  const [c, s] = InMemoryTransport.createLinkedPair();
  const server = createSuperunMcpServer(app);
  await server.connect(s);
  const connection = new Client({ name: "close-authorization", version: "1" });
  await connection.connect(c);
  await connection.callTool({ name: "start_authorization", arguments: { mode: "managed" } });
  const previous = loadSession(app.scopeId);
  await connection.close();
  await server.close();
  const count = polls;
  outcome = "authorized";
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(polls, count);
  assert.deepEqual(loadSession(app.scopeId), previous);
});

test("迟到的旧续期不能覆盖用户换号或退出后的会话", async () => {
  for (const logout of [false, true]) {
    const original = expired();
    saveSession(app.scopeId, original);
    refreshMode = "delayed";
    let release;
    refreshWait = new Promise((resolve) => {
      release = resolve;
    });
    const started = new Promise((resolve) => {
      refreshStarted = resolve;
    });
    const pending = request(app, original, { path: "/rest/v1/records", auth: true });
    const rejected = assert.rejects(pending, (error) => {
      assert.equal(error.code, "AUTH_REFRESH_FAILED");
      assert.equal(error.reason, "session_changed");
      assert.equal(error.toJSON().nextAction, "confirm_account");
      assert.equal(error.toJSON().loginCommands, undefined);
      return true;
    });
    await started;
    const changed = { access_token: jwt("another-user"), strategy: "browser" };
    if (logout) clearSession(app.scopeId);
    else saveSession(app.scopeId, changed);
    release();
    await rejected;
    assert.deepEqual(loadSession(app.scopeId), logout ? null : changed);
  }
  assert.equal(businessRequests, 0);
});
