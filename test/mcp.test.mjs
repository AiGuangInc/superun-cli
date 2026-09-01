import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createSuperunMcpServer } from "../dist/commands/mcp.js";
import { clearSession, saveSession } from "../dist/auth/session.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APP_ID = "mcp-test";
const APP_NAME = "shop";
const ANON_KEY = "anon-key-must-not-leak";
const DEBUG_ANON_KEY = "debug-anon-key-must-not-leak";
const ACCESS_TOKEN = [
  "header",
  Buffer.from(JSON.stringify({ sub: "user-1", email: "user@example.com", role: "authenticated", exp: 4102444800 })).toString(
    "base64url",
  ),
  "signature",
].join(".");
const DEBUG_ACCESS_TOKEN = [
  "header",
  Buffer.from(
    JSON.stringify({ sub: "debug-user", email: "debug@example.com", role: "authenticated", exp: 4102444800 }),
  ).toString("base64url"),
  "signature",
].join(".");
const TOOL_NAMES = [
  "project_status",
  "list_tables",
  "query_rows",
  "list_function_groups",
  "list_functions",
  "describe_function",
  "call_function",
];

let root;
let appDir;
let baseUrl;
let httpServer;
let mcpServer;
let client;
let requests = [];
const oldEnv = {
  SUPERUN_HOME: process.env.SUPERUN_HOME,
  XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
};

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

function valueOf(result) {
  const text = result.content.find(block => block.type === "text")?.text;
  assert.equal(typeof text, "string");
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function assertToolRejected(params, pattern) {
  try {
    const result = await client.callTool(params);
    assert.equal(result.isError, true);
    assert.match(String(valueOf(result)), pattern);
  } catch (error) {
    assert.match(error instanceof Error ? error.message : String(error), pattern);
  }
}

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

before(async () => {
  root = mkdtempSync(join(tmpdir(), "superun-mcp-test-"));
  process.env.SUPERUN_HOME = join(root, "config");
  process.env.XDG_CACHE_HOME = join(root, "cache");

  httpServer = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks).toString("utf8");
    const url = new URL(req.url, baseUrl);
    requests.push({
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: req.headers,
      body: rawBody ? JSON.parse(rawBody) : null,
    });

    res.setHeader("content-type", "application/json");
    if (url.pathname === "/rest/v1/" || url.pathname === "/debug/rest/v1/") {
      res.end(
        JSON.stringify({
          swagger: "2.0",
          paths: { "/orders": { get: {} }, "/large_rows": { get: {} }, "/rpc/dangerous": { post: {} } },
          definitions: {
            orders: {
              type: "object",
              required: ["id"],
              properties: {
                id: { type: "integer", format: "int8" },
                status: { type: "string" },
                created_at: { type: "string", format: "date-time" },
              },
            },
          },
        }),
      );
      return;
    }
    if ((url.pathname === "/rest/v1/orders" || url.pathname === "/debug/rest/v1/orders") && req.method === "GET") {
      res.end(JSON.stringify([{ id: 7, status: "paid" }]));
      return;
    }
    if (url.pathname === "/rest/v1/large_rows" && req.method === "GET") {
      res.end(JSON.stringify([{ value: "x".repeat(1024 * 1024) }]));
      return;
    }
    if (url.pathname === "/functions/v1/orders/create" && req.method === "POST") {
      res.end(JSON.stringify({ orderId: "order-7" }));
      return;
    }
    if (url.pathname === "/debug/functions/v1/debug-only/verify" && req.method === "POST") {
      res.end(JSON.stringify({ environment: "debug", verified: true }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise((resolveListen, rejectListen) => {
    httpServer.once("error", rejectListen);
    httpServer.listen(0, "127.0.0.1", resolveListen);
  });
  const address = httpServer.address();
  assert.equal(typeof address, "object");
  baseUrl = `http://127.0.0.1:${address.port}`;

  appDir = join(process.env.SUPERUN_HOME, "apps", APP_ID);
  writeJson(join(appDir, "app.json"), {
    id: APP_ID,
    name: APP_NAME,
    url: baseUrl,
    anonKey: ANON_KEY,
  });
  writeJson(join(appDir, "functions", "index.json"), {
    schemaVersion: 1,
    groups: [
      { name: "orders", description: "Order operations" },
      { name: "reports", description: "Read reports" },
    ],
    functions: [
      { name: "orders/create", group: "orders", summary: "Create an order", verifyJwt: true },
      { name: "reports/read", group: "reports", summary: "Read a report", verifyJwt: false },
    ],
  });
  writeJson(join(appDir, "functions", "orders", "create.json"), {
    name: "orders/create",
    group: "orders",
    method: "post",
    verifyJwt: true,
    summary: "Create an order",
    input: {
      type: "object",
      additionalProperties: false,
      required: ["sku", "qty"],
      properties: { sku: { type: "string" }, qty: { type: "integer", minimum: 1 } },
    },
    output: { type: "object", properties: { orderId: { type: "string" } } },
  });
  writeJson(join(appDir, "functions", "reports", "read.json"), {
    name: "reports/read",
    group: "reports",
    method: "get",
    verifyJwt: false,
    summary: "Read a report",
  });
  writeJson(join(appDir, "secret.json"), { secret: "must-not-be-readable" });
  saveSession(APP_ID, { access_token: ACCESS_TOKEN, strategy: "token" });

  const app = {
    id: APP_ID,
    name: APP_NAME,
    baseUrl,
    anonKey: ANON_KEY,
    environment: "production",
    scopeId: APP_ID,
    runtimeDir: appDir,
    targets: { production: { baseUrl, anonKey: ANON_KEY } },
    dir: appDir,
  };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  mcpServer = createSuperunMcpServer(app);
  await mcpServer.connect(serverTransport);
  client = new Client({ name: "superun-mcp-test", version: "1.0.0" });
  await client.connect(clientTransport);
});

after(async () => {
  await client?.close().catch(() => {});
  await mcpServer?.close().catch(() => {});
  await new Promise(resolveClose => httpServer?.close(resolveClose));
  restoreEnv("SUPERUN_HOME", oldEnv.SUPERUN_HOME);
  restoreEnv("XDG_CACHE_HOME", oldEnv.XDG_CACHE_HOME);
  if (root) rmSync(root, { recursive: true, force: true });
});

test("publishes exactly the seven guarded MCP tools", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map(tool => tool.name),
    TOOL_NAMES,
  );
  assert.equal(tools.find(tool => tool.name === "call_function").annotations.destructiveHint, true);
  for (const tool of tools.filter(tool => tool.name !== "call_function")) {
    assert.equal(tool.annotations.readOnlyHint, true, `${tool.name} must be read-only`);
  }
  assert.equal(tools.some(tool => /insert|update|delete|rpc/i.test(tool.name)), false);
  assert.equal(tools.find(tool => tool.name === "query_rows").inputSchema.properties.limit.maximum, 200);
  const callFunctionSchema = tools.find(tool => tool.name === "call_function").inputSchema;
  assert.equal(callFunctionSchema.required.includes("userConfirmed"), true);
  assert.equal(callFunctionSchema.properties.userConfirmed.const, true);
  assert.match(callFunctionSchema.properties.userConfirmed.description, /exact function and exact input.*current conversation/i);
});

test("reports project and identity state without leaking credentials", async () => {
  const result = await client.callTool({ name: "project_status", arguments: {} });
  assert.equal(result.isError, undefined);
  const value = valueOf(result);
  assert.deepEqual(value.identity, {
    strategy: "token",
    sub: "user-1",
    email: "user@example.com",
    role: "authenticated",
    expiresAt: 4102444800,
  });
  assert.equal(value.id, APP_ID);
  assert.equal(value.name, APP_NAME);
  assert.equal(value.environment, "production");
  assert.equal(value.credentialPresent, true);
  assert.equal("loggedIn" in value, false);
  assert.equal(result.content[0].text.includes(ANON_KEY), false);
  assert.equal(result.content[0].text.includes(ACCESS_TOKEN), false);
});

test("discovers tables and queries rows with GET, login, RLS identity, and bounded inputs", async () => {
  requests = [];
  const tablesResult = await client.callTool({
    name: "list_tables",
    arguments: { table: "orders", refresh: true },
  });
  assert.equal(tablesResult.isError, undefined);
  assert.deepEqual(valueOf(tablesResult).table.columns, [
    { name: "id", type: "integer", format: "int8", required: true },
    { name: "status", type: "string", required: false },
    { name: "created_at", type: "string", format: "date-time", required: false },
  ]);

  const queryResult = await client.callTool({
    name: "query_rows",
    arguments: {
      table: "orders",
      columns: ["id", "status"],
      filters: [{ column: "status", operator: "eq", value: "paid" }],
      order: { column: "id", direction: "desc" },
      limit: 25,
    },
  });
  assert.deepEqual(valueOf(queryResult), { status: 200, data: [{ id: 7, status: "paid" }] });
  const rowRequest = requests.at(-1);
  assert.equal(rowRequest.method, "GET");
  assert.equal(rowRequest.path, "/rest/v1/orders");
  assert.deepEqual(rowRequest.query, { select: "id,status", limit: "25", status: "eq.paid", order: "id.desc" });
  assert.equal(rowRequest.headers.authorization, `Bearer ${ACCESS_TOKEN}`);
  assert.equal(rowRequest.headers.apikey, ANON_KEY);

  const oversized = await client.callTool({ name: "query_rows", arguments: { table: "large_rows", limit: 1 } });
  assert.equal(oversized.isError, true);
  assert.match(valueOf(oversized), /exceeds the .* safety limit.*Reduce columns and\/or limit/s);
  assert.equal(oversized.structuredContent, undefined);
  assert.ok(Buffer.byteLength(oversized.content[0].text, "utf8") < 1024 * 1024);

  const beforeUnknown = requests.length;
  const rpcResult = await client.callTool({ name: "query_rows", arguments: { table: "rpc/dangerous" } });
  assert.equal(rpcResult.isError, true);
  assert.match(valueOf(rpcResult), /Unknown or unexposed table/);
  assert.equal(requests.length, beforeUnknown, "RPC paths must never be requested by query_rows");

  clearSession(APP_ID);
  const loggedOut = await client.callTool({ name: "query_rows", arguments: { table: "orders" } });
  assert.equal(loggedOut.isError, true);
  assert.match(valueOf(loggedOut), /requires login/);
  saveSession(APP_ID, { access_token: ACCESS_TOKEN, strategy: "token" });
});

test("discovers and validates business functions before making an authenticated call", async () => {
  const groups = valueOf(await client.callTool({ name: "list_function_groups", arguments: {} }));
  assert.deepEqual(groups.groups, [
    { name: "orders", description: "Order operations" },
    { name: "reports", description: "Read reports" },
  ]);
  const functions = valueOf(await client.callTool({ name: "list_functions", arguments: { group: "orders" } }));
  assert.equal(functions.functions[0].name, "orders/create");
  const described = valueOf(
    await client.callTool({ name: "describe_function", arguments: { name: "orders/create" } }),
  );
  assert.equal(described.function.verifyJwt, true);
  assert.deepEqual(described.function.input.required, ["sku", "qty"]);

  const beforeInvalid = requests.length;
  const invalid = await client.callTool({
    name: "call_function",
    arguments: { name: "orders/create", input: { sku: "sku-1", qty: 0 }, userConfirmed: true },
  });
  assert.equal(invalid.isError, true);
  assert.match(valueOf(invalid), /Input validation failed/);
  assert.equal(requests.length, beforeInvalid, "invalid input must not reach the backend");

  for (const confirmation of [undefined, false]) {
    const beforeUnconfirmed = requests.length;
    const argumentsValue = { name: "orders/create", input: { sku: "sku-1", qty: 2 } };
    if (confirmation !== undefined) argumentsValue.userConfirmed = confirmation;
    await assertToolRejected(
      { name: "call_function", arguments: argumentsValue },
      /userConfirmed|expected true|required/i,
    );
    assert.equal(requests.length, beforeUnconfirmed, "unconfirmed calls must be rejected before any HTTP request");
  }

  const called = await client.callTool({
    name: "call_function",
    arguments: { name: "orders/create", input: { sku: "sku-1", qty: 2 }, userConfirmed: true },
  });
  assert.deepEqual(valueOf(called), { status: 200, data: { orderId: "order-7" } });
  const fnRequest = requests.at(-1);
  assert.equal(fnRequest.method, "POST");
  assert.equal(fnRequest.path, "/functions/v1/orders/create");
  assert.deepEqual(fnRequest.body, { sku: "sku-1", qty: 2 });
  assert.equal(fnRequest.headers.authorization, `Bearer ${ACCESS_TOKEN}`);

  for (const toolName of ["describe_function", "call_function"]) {
    for (const unsafeName of ["../secret", "unknown/function"]) {
      const rejected = await client.callTool({
        name: toolName,
        arguments: { name: unsafeName, ...(toolName === "call_function" ? { userConfirmed: true } : {}) },
      });
      assert.equal(rejected.isError, true);
      assert.match(valueOf(rejected), /Unknown function/);
      assert.equal(JSON.stringify(rejected).includes("must-not-be-readable"), false);
    }
  }

  const beforeGetInput = requests.length;
  const getWithInput = await client.callTool({
    name: "call_function",
    arguments: { name: "reports/read", input: { range: "today" }, userConfirmed: true },
  });
  assert.equal(getWithInput.isError, true);
  assert.match(valueOf(getWithInput), /uses GET/);
  assert.equal(requests.length, beforeGetInput, "GET input must be rejected instead of silently discarded");
});

test("the real CLI stdio entry completes an MCP handshake without stdout noise", async () => {
  const env = Object.fromEntries(
    Object.entries({
      PATH: process.env.PATH,
      SYSTEMROOT: process.env.SYSTEMROOT,
      SUPERUN_HOME: process.env.SUPERUN_HOME,
      XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
    }).filter(([, value]) => value !== undefined),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(REPO_ROOT, "dist", "cli.js"), "--app", APP_NAME, "mcp"],
    cwd: REPO_ROOT,
    env,
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", chunk => {
    stderr += chunk.toString();
  });
  const stdioClient = new Client({ name: "superun-stdio-smoke", version: "1.0.0" });
  try {
    await stdioClient.connect(transport);
    const { tools } = await stdioClient.listTools();
    assert.deepEqual(
      tools.map(tool => tool.name),
      TOOL_NAMES,
    );
    assert.equal(stderr, "");
  } finally {
    await stdioClient.close().catch(() => {});
  }
});

test("the real CLI keeps debug MCP credentials, cache, and backend target isolated", async () => {
  writeJson(join(appDir, "app.json"), {
    id: APP_ID,
    name: APP_NAME,
    url: baseUrl,
    anonKey: ANON_KEY,
    debugUrl: `${baseUrl}/debug`,
    debugAnonKey: DEBUG_ANON_KEY,
    environment: "production",
  });
  writeJson(join(appDir, "environments", "debug", "functions", "index.json"), {
    schemaVersion: 1,
    groups: [{ name: "debug-only", description: "Debug operations" }],
    functions: [
      {
        name: "debug-only/verify",
        group: "debug-only",
        summary: "Verify debug isolation",
        verifyJwt: true,
      },
    ],
  });
  writeJson(join(appDir, "environments", "debug", "functions", "debug-only", "verify.json"), {
    name: "debug-only/verify",
    group: "debug-only",
    method: "post",
    verifyJwt: true,
    summary: "Verify debug isolation",
    input: {
      type: "object",
      additionalProperties: false,
      required: ["value"],
      properties: { value: { type: "string" } },
    },
  });
  saveSession(`${APP_ID}/debug`, { access_token: DEBUG_ACCESS_TOKEN, strategy: "token" });

  const env = Object.fromEntries(
    Object.entries({
      PATH: process.env.PATH,
      SYSTEMROOT: process.env.SYSTEMROOT,
      SUPERUN_HOME: process.env.SUPERUN_HOME,
      XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
    }).filter(([, value]) => value !== undefined),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(REPO_ROOT, "dist", "cli.js"), "--app", APP_NAME, "--env", "debug", "mcp"],
    cwd: REPO_ROOT,
    env,
    stderr: "pipe",
  });
  const debugClient = new Client({ name: "superun-debug-stdio-smoke", version: "1.0.0" });
  try {
    await debugClient.connect(transport);

    const status = valueOf(await debugClient.callTool({ name: "project_status", arguments: {} }));
    assert.equal(status.environment, "debug");
    assert.equal(status.url, `${baseUrl}/debug`);
    assert.equal(status.identity.sub, "debug-user");
    assert.equal(status.functionManifestCached, true);

    const groups = valueOf(await debugClient.callTool({ name: "list_function_groups", arguments: {} }));
    assert.deepEqual(groups.groups, [{ name: "debug-only", description: "Debug operations" }]);

    requests = [];
    const tables = await debugClient.callTool({ name: "list_tables", arguments: { refresh: true } });
    assert.equal(tables.isError, undefined);
    const schemaRequest = requests.at(-1);
    assert.equal(schemaRequest.path, "/debug/rest/v1/");
    assert.equal(schemaRequest.headers.apikey, DEBUG_ANON_KEY);
    assert.equal(schemaRequest.headers.authorization, `Bearer ${DEBUG_ACCESS_TOKEN}`);

    requests = [];
    const called = valueOf(
      await debugClient.callTool({
        name: "call_function",
        arguments: { name: "debug-only/verify", input: { value: "debug" }, userConfirmed: true },
      }),
    );
    assert.deepEqual(called, { status: 200, data: { environment: "debug", verified: true } });
    const functionRequest = requests.at(-1);
    assert.equal(functionRequest.path, "/debug/functions/v1/debug-only/verify");
    assert.equal(functionRequest.headers.apikey, DEBUG_ANON_KEY);
    assert.equal(functionRequest.headers.authorization, `Bearer ${DEBUG_ACCESS_TOKEN}`);
  } finally {
    await debugClient.close().catch(() => {});
  }
});
