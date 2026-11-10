/** 验证安全密码输入、服务端身份验收及公开查询的实际命令行为。@author xiuyu.yi */
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createSuperunMcpServer } from "../dist/commands/mcp.js";
import { verifyUserIdentity } from "../dist/auth/identity.js";
import { clearSession, loadSession, saveSession } from "../dist/auth/session.js";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const PASSWORD = "test-password-only-keep-private";
const originalHome = process.env.SUPERUN_HOME;
const token = (sub = "user-1") => "head." + Buffer.from(JSON.stringify({ sub, role: "authenticated" })).toString("base64url") + ".signature";
const jsonFile = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
};
let root, app, httpServer, client, mcpServer;
let requests, user, userStatus, passwordStatus, refreshes;

function cli(args, input = "") {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, "--app", app.id, "--env", "production", ...args], {
      env: { ...process.env, SUPERUN_HOME: root, APP_CLI_DIR: app.dir },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr, args: child.spawnargs }));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

before(async () => {
  root = mkdtempSync(join(tmpdir(), "superun-identity-password-"));
  process.env.SUPERUN_HOME = root;
  httpServer = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const url = new URL(req.url, app.baseUrl);
    requests.push({ path: url.pathname, authorization: req.headers.authorization });
    res.setHeader("content-type", "application/json");
    if (url.pathname === "/auth/v1/user") {
      res.statusCode = userStatus;
      res.end(JSON.stringify(user));
    } else if (url.pathname === "/auth/v1/token") {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (url.searchParams.get("grant_type") === "refresh_token") refreshes++;
      else assert.deepEqual(body, { email: "user@example.test", password: PASSWORD });
      res.statusCode = passwordStatus;
      res.end(JSON.stringify(passwordStatus === 200
        ? { access_token: token(), refresh_token: "private-refresh", expires_in: 3600 }
        : { error: "bad_password", reflected_input: PASSWORD }));
    } else if (url.pathname === "/rest/v1/public_items") {
      res.end("[]");
    } else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
  const dir = join(root, "apps", "identity-test");
  app = { id: "identity-test", scopeId: "identity-test", baseUrl, anonKey: "public-key", environment: "production", dir, runtimeDir: dir, targets: { production: { baseUrl, anonKey: "public-key" } } };
  jsonFile(join(dir, "app.json"), { id: app.id, url: baseUrl, anonKey: app.anonKey, environment: "production" });
  jsonFile(join(root, "update-policy.json"), { checkedAt: Date.now(), latestVersion: "0.1.7" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  mcpServer = createSuperunMcpServer(app);
  await mcpServer.connect(s);
  client = new Client({ name: "identity-test", version: "1" });
  await client.connect(c);
});

beforeEach(() => {
  requests = [];
  refreshes = 0;
  userStatus = passwordStatus = 200;
  user = { id: "user-1", email: "user@example.test", role: "authenticated", is_anonymous: false };
  saveSession(app.scopeId, { access_token: token(), strategy: "token" });
});

after(async () => {
  await client.close();
  await mcpServer.close();
  await new Promise((resolve) => httpServer.close(resolve));
  if (originalHome === undefined) delete process.env.SUPERUN_HOME;
  else process.env.SUPERUN_HOME = originalHome;
  rmSync(root, { recursive: true, force: true });
});

test("真实 CLI 从 stdin 接收密码，argv 和输出不包含密码，原密码登录仍可用", async () => {
  const result = await cli(["login", "--password", "--email", "user@example.test", "--password-stdin"], PASSWORD + "\n");
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.args.some((arg) => arg.includes(PASSWORD)), false);
  assert.equal((result.stdout + result.stderr).includes(PASSWORD), false);
  assert.equal(loadSession(app.scopeId).strategy, "password");
  const legacy = await cli(["login", "--password", "--email", "user@example.test", "--pass", PASSWORD]);
  assert.equal(legacy.code, 0, legacy.stderr);
});

test("空输入、多行、超长输入和冲突参数不发送登录请求", async () => {
  const args = ["login", "--password", "--email", "user@example.test", "--password-stdin"];
  for (const input of ["", "line1\nline2", "x".repeat(16 * 1024 + 1)]) {
    const result = await cli(args, input);
    assert.equal(result.code, 1);
  }
  for (const extra of [["--pass", PASSWORD], ["--browser"], ["--managed"], ["--token", token()]]) {
    const result = await cli([...args, ...extra], PASSWORD);
    assert.equal(result.code, 1);
    assert.equal(result.stderr.includes(PASSWORD), false);
  }
  assert.deepEqual(requests, []);
});

test("认证服务即使回显密码，CLI 登录失败也不暴露该响应", async () => {
  passwordStatus = 400;
  const previous = loadSession(app.scopeId);
  const result = await cli(["login", "--password", "--email", "user@example.test", "--password-stdin"], PASSWORD);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /HTTP 400/);
  assert.equal((result.stdout + result.stderr).includes(PASSWORD), false);
  assert.deepEqual(loadSession(app.scopeId), previous);
});

test("whoami 默认仍只读本地，显式 verify 才请求认证服务并确认真实用户", async () => {
  const local = await cli(["whoami", "--json"]);
  assert.equal(local.code, 0);
  assert.equal(JSON.parse(local.stdout).verified, undefined);
  assert.deepEqual(requests, []);
  const result = await cli(["whoami", "--verify", "--json"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).verified, true);
  assert.equal(JSON.parse(result.stdout).identity.isAnonymous, false);
  assert.deepEqual(requests, [{ path: "/auth/v1/user", authorization: `Bearer ${token()}` }]);
});

test("MCP 保留本地状态默认行为，服务端验证必须显式启用", async () => {
  const local = await client.callTool({ name: "project_status", arguments: {} });
  assert.equal(local.structuredContent.result.verified, undefined);
  assert.deepEqual(requests, []);
  const result = await client.callTool({ name: "project_status", arguments: { verifyIdentity: true } });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.result.verified, true);
  assert.equal(result.structuredContent.result.identity.sub, "user-1");
  assert.equal(JSON.stringify(result).includes(token()), false);
});

test("CLI 和 MCP 都拒绝把匿名用户及失效登录算作已验证", async () => {
  for (const anonymous of [{ ...user, is_anonymous: true }, { ...user, role: "anon" }]) {
    user = anonymous;
    const command = await cli(["whoami", "--verify", "--json"]);
    assert.equal(command.code, 1);
    assert.equal(JSON.parse(command.stderr).reason, "anonymous_identity");
    const tool = await client.callTool({ name: "project_status", arguments: { verifyIdentity: true } });
    assert.equal(tool.isError, true);
    assert.equal(tool.structuredContent.result.nextAction, "start_authorization");
    assert.equal(tool.structuredContent.result.verified, undefined);
  }
  userStatus = 401;
  user = { error_code: "bad_jwt" };
  await assert.rejects(verifyUserIdentity(app), (error) => error.code === "AUTH_REQUIRED");
});

test("没有会话时身份验收失败，原有公开空结果查询仍可成功", async () => {
  clearSession(app.scopeId);
  const result = await cli(["whoami", "--verify", "--json"]);
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stderr).reason, "no_session");
  assert.deepEqual(requests, []);
  const query = await cli(["db", "select", "public_items", "--limit", "1"]);
  assert.equal(query.code, 0, query.stderr);
  assert.match(query.stdout, /HTTP 200\n\[\]/);
  assert.equal(requests[0].authorization, undefined);
});

test("认证服务异常或身份信息不完整时不输出验证成功，凭据保持不变", async () => {
  const previous = loadSession(app.scopeId);
  for (const [status, body] of [[503, {}], [200, {}], [200, { id: "user-1", role: "authenticated" }]]) {
    userStatus = status;
    user = body;
    const result = await cli(["whoami", "--verify", "--json"]);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.deepEqual(loadSession(app.scopeId), previous);
  }
});

test("服务端身份校验沿用已有自动续期，并拒绝换号后沿用旧身份", async () => {
  saveSession(app.scopeId, { access_token: token(), refresh_token: "old-refresh", expires_at: 1, strategy: "password" });
  assert.equal((await verifyUserIdentity(app)).sub, "user-1");
  assert.equal(refreshes, 1);
  assert.equal(loadSession(app.scopeId).refresh_token, "private-refresh");
  user.id = "other-user";
  await assert.rejects(verifyUserIdentity(app), (error) => error.reason === "session_changed");
});
