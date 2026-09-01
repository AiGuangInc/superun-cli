import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { assertSafeFunctionName, FunctionsTree } from "../dist/config/functions.js";
import { refreshFunctions } from "../dist/discovery/functions-manifest.js";
import { compileFromDoc } from "../dist/manifest-compile.js";

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

function operation() {
  return {
    post: {
      summary: "test",
      responses: { "200": { description: "ok" } },
    },
  };
}

function manifest(path) {
  return {
    openapi: "3.1.0",
    info: { title: "function name security test", version: "1.0.0" },
    paths: { [path]: operation() },
  };
}

test("function names preserve compatible route spelling while rejecting unsafe cache paths", () => {
  for (const name of [
    "create-order",
    "_cli-manifest",
    "api/runtime-tick",
    "v2/orders_1",
    "Orders/Create",
    "reports/v1.1",
    "api/.well-known",
    "café/run",
  ]) {
    assert.equal(assertSafeFunctionName(name), name);
  }
  for (const name of [
    "",
    ".",
    "..",
    "../escape",
    "api/../escape",
    "api//escape",
    "/absolute",
    "api\\escape",
    "Index",
    "con",
    "CON",
    "con.txt",
    "api/nul",
    "api/NUL.log",
    "foo/aux",
    "index",
    "api/trailing.",
    "api/trailing ",
    "api/invalid:name",
    "api/bad<name",
    'api/bad"name',
    "api/bad|name",
    "api/star*",
    "api/value?query",
    "api/value#fragment",
    "api/%2e%2e/escape",
    "api/control\u0000name",
  ]) {
    assert.throws(() => assertSafeFunctionName(name), /Unsafe function name/);
  }
  assert.throws(() => assertSafeFunctionName(1), /Unsafe function name/);
});

test("manifest compilation rejects traversal before cache generation", async () => {
  await assert.rejects(() => compileFromDoc(manifest("/../../escape")), /Unsafe function name/);
  const compiled = await compileFromDoc(manifest("/api/runtime-tick"));
  assert.equal(compiled.functions["api/runtime-tick"].name, "api/runtime-tick");

  const compatible = await compileFromDoc(manifest("/Orders/v1.1"));
  assert.equal(compatible.functions["Orders/v1.1"].name, "Orders/v1.1");

  const ignoredUnsafePath = manifest("/safe");
  ignoredUnsafePath.paths["/../../ignored"] = { parameters: [] };
  const ignoredCompiled = await compileFromDoc(ignoredUnsafePath);
  assert.equal(ignoredCompiled.functions.safe.name, "safe");

  const nestedIndex = await compileFromDoc(manifest("/Index/run"));
  assert.equal(nestedIndex.functions["Index/run"].name, "Index/run");

  const collision = manifest("/Orders/Create");
  collision.paths["/orders/create"] = operation();
  await assert.rejects(() => compileFromDoc(collision), /cache path collision.*case-insensitive filesystem/);

  await assert.rejects(() => compileFromDoc(manifest("/index.json/run")), /cache path collision.*manifest index/);

  const fileDirectoryCollision = manifest("/foo");
  fileDirectoryCollision.paths["/foo.json/bar"] = operation();
  await assert.rejects(
    () => compileFromDoc(fileDirectoryCollision),
    /cache path collision.*function path "foo".*case-insensitive filesystem/,
  );
  const reverseFileDirectoryCollision = manifest("/foo.json/bar");
  reverseFileDirectoryCollision.paths["/foo"] = operation();
  await assert.rejects(
    () => compileFromDoc(reverseFileDirectoryCollision),
    /cache path collision.*function path "foo.json\/bar".*case-insensitive filesystem/,
  );

  const prototypeName = await compileFromDoc(manifest("/__proto__"));
  assert.equal(Object.getPrototypeOf(prototypeName.functions), null);
  assert.equal(Object.hasOwn(prototypeName.functions, "__proto__"), true);
  assert.deepEqual(Object.keys(prototypeName.functions), ["__proto__"]);
  assert.equal(prototypeName.functions.__proto__.name, "__proto__");
});

test("FunctionsTree remains compatible with mixed-case and dotted caches from older releases", () => {
  const appDir = mkdtempSync(join(tmpdir(), "superun-functions-compatible-cache-test-"));
  try {
    const functions = [
      { name: "Orders/Create", group: "orders", summary: "mixed case", verifyJwt: false },
      { name: "reports/v1.1", group: "reports", summary: "dotted route", verifyJwt: false },
    ];
    writeJson(join(appDir, "functions", "index.json"), {
      schemaVersion: 1,
      groups: [{ name: "orders" }, { name: "reports" }],
      functions,
    });
    for (const fn of functions) {
      writeJson(join(appDir, "functions", `${fn.name}.json`), {
        ...fn,
        method: "post",
      });
    }

    const tree = new FunctionsTree(appDir);
    assert.equal(tree.resolveLeaf("Orders/Create").name, "Orders/Create");
    assert.equal(tree.resolveLeaf("reports/v1.1").name, "reports/v1.1");
  } finally {
    rmSync(appDir, { recursive: true, force: true });
  }
});

test("refreshFunctions rejects unsafe or conflicting manifests before replacing the old cache", async () => {
  const root = mkdtempSync(join(tmpdir(), "superun-functions-refresh-test-"));
  const appDir = join(root, "app");
  const oldIndex = { schemaVersion: 1, groups: [], functions: [] };
  const maliciousManifest = join(root, "malicious.openapi.json");
  try {
    writeJson(join(appDir, "functions", "index.json"), oldIndex);
    writeFileSync(join(appDir, "functions", "sentinel"), "keep\n");
    writeJson(maliciousManifest, manifest("/../../escape"));
    const app = {
      id: "test",
      baseUrl: "http://127.0.0.1:9",
      anonKey: "anon",
      environment: "production",
      scopeId: "test",
      runtimeDir: appDir,
      targets: { production: { baseUrl: "http://127.0.0.1:9", anonKey: "anon" } },
      dir: appDir,
    };

    await assert.rejects(() => refreshFunctions(app, maliciousManifest), /Unsafe function name/);
    assert.deepEqual(JSON.parse(readFileSync(join(appDir, "functions", "index.json"), "utf8")), oldIndex);
    assert.equal(readFileSync(join(appDir, "functions", "sentinel"), "utf8"), "keep\n");
    assert.equal(existsSync(join(root, "escape.json")), false);

    const conflictingManifest = manifest("/foo");
    conflictingManifest.paths["/foo.json/bar"] = operation();
    writeJson(maliciousManifest, conflictingManifest);
    await assert.rejects(() => refreshFunctions(app, maliciousManifest), /cache path collision/);
    assert.deepEqual(JSON.parse(readFileSync(join(appDir, "functions", "index.json"), "utf8")), oldIndex);
    assert.equal(readFileSync(join(appDir, "functions", "sentinel"), "utf8"), "keep\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refreshFunctions writes and resolves prototype-like function names consistently", async () => {
  const root = mkdtempSync(join(tmpdir(), "superun-functions-prototype-name-test-"));
  const appDir = join(root, "app");
  const manifestFile = join(root, "prototype.openapi.json");
  try {
    writeJson(manifestFile, manifest("/__proto__"));
    const app = {
      id: "test",
      baseUrl: "http://127.0.0.1:9",
      anonKey: "anon",
      environment: "production",
      scopeId: "test",
      runtimeDir: appDir,
      targets: { production: { baseUrl: "http://127.0.0.1:9", anonKey: "anon" } },
      dir: appDir,
    };

    const refreshed = await refreshFunctions(app, manifestFile);
    assert.equal(refreshed.count, 1);
    assert.equal(existsSync(join(appDir, "functions", "__proto__.json")), true);
    assert.equal(new FunctionsTree(appDir).resolveLeaf("__proto__").name, "__proto__");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refreshFunctions writes only the selected debug runtime cache", async () => {
  const root = mkdtempSync(join(tmpdir(), "superun-functions-debug-refresh-test-"));
  const appDir = join(root, "app");
  const debugRuntimeDir = join(appDir, "environments", "debug");
  const manifestFile = join(root, "debug.openapi.json");
  const productionIndex = { schemaVersion: 1, groups: [], functions: [] };
  try {
    writeJson(join(appDir, "functions", "index.json"), productionIndex);
    writeFileSync(join(appDir, "functions", "sentinel"), "production-only\n");
    writeJson(manifestFile, manifest("/debug/run"));
    const app = {
      id: "test",
      baseUrl: "http://127.0.0.1:9/debug",
      anonKey: "debug-anon",
      environment: "debug",
      scopeId: "test/debug",
      runtimeDir: debugRuntimeDir,
      targets: {
        production: { baseUrl: "http://127.0.0.1:9", anonKey: "anon" },
        debug: { baseUrl: "http://127.0.0.1:9/debug", anonKey: "debug-anon" },
      },
      dir: appDir,
    };

    const refreshed = await refreshFunctions(app, manifestFile);
    assert.equal(refreshed.count, 1);
    assert.equal(new FunctionsTree(debugRuntimeDir).resolveLeaf("debug/run").name, "debug/run");
    assert.deepEqual(JSON.parse(readFileSync(join(appDir, "functions", "index.json"), "utf8")), productionIndex);
    assert.equal(readFileSync(join(appDir, "functions", "sentinel"), "utf8"), "production-only\n");
    assert.equal(existsSync(join(appDir, "functions", "debug", "run.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("FunctionsTree rejects traversal from a hand-edited cache", () => {
  const appDir = mkdtempSync(join(tmpdir(), "superun-functions-cache-test-"));
  try {
    writeJson(join(appDir, "secret.json"), { secret: "must-not-be-readable" });
    writeJson(join(appDir, "functions", "index.json"), {
      schemaVersion: 1,
      groups: [{ name: "default" }],
      functions: [
        { name: "../secret", group: "default", summary: "malicious", verifyJwt: false },
        { name: "safe/run", group: "safe", summary: "tampered leaf", verifyJwt: false },
        { name: "safe/other", group: "safe", summary: "mismatched leaf", verifyJwt: false },
      ],
    });
    writeJson(join(appDir, "functions", "safe", "run.json"), {
      name: "../../escape",
      group: "safe",
      method: "post",
      verifyJwt: false,
      summary: "tampered",
    });
    writeJson(join(appDir, "functions", "safe", "other.json"), {
      name: "safe/different",
      group: "safe",
      method: "post",
      verifyJwt: false,
      summary: "mismatched",
    });
    writeJson(join(appDir, "functions", "orphan.json"), {
      name: "orphan",
      group: "default",
      method: "post",
      verifyJwt: false,
      summary: "not indexed",
    });
    const tree = new FunctionsTree(appDir);
    assert.equal(tree.listFunctions()[0].name, "../secret", "the test cache must contain the malicious entry");
    for (const ref of ["../secret", "default/../secret"]) {
      assert.throws(() => tree.resolveLeaf(ref), /Unsafe function name/);
    }
    assert.throws(() => tree.resolveLeaf("safe/run"), /Unsafe function name/);
    assert.throws(() => tree.resolveLeaf("safe/other"), /leaf name does not match/);
    assert.throws(() => tree.resolveLeaf("orphan"), /Unknown function/);
    assert.throws(() => tree.resolveLeaf("missing"), /Unknown function/);
  } finally {
    rmSync(appDir, { recursive: true, force: true });
  }
});
