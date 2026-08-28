import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { loadApp } from "../config/app.js";
import { loadSession } from "../auth/session.js";
import { getPgrestSpec, listRpcs, listTables } from "../discovery/pgrest.js";
import { request } from "../transport/client.js";

function collect(v: string, acc: string[]): string[] {
  acc.push(v);
  return acc;
}

/** ["col=val", ...] → { col: "eq.val" }(PostgREST 等值过滤)。 */
function eqToQuery(eqs: string[]): Record<string, string> {
  const q: Record<string, string> = {};
  for (const e of eqs) {
    const i = e.indexOf("=");
    if (i < 0) throw new Error(`--eq expects col=val, received: ${e}`);
    q[e.slice(0, i)] = `eq.${e.slice(i + 1)}`;
  }
  return q;
}

function readBody(opts: { data?: string; file?: string }): unknown {
  if (opts.file) return JSON.parse(readFileSync(opts.file, "utf8"));
  if (opts.data) return JSON.parse(opts.data);
  return undefined;
}

function printResult(status: number, body: any): void {
  console.log(`HTTP ${status}`);
  console.log(typeof body === "string" ? body : JSON.stringify(body, null, 2));
  if (status >= 400) process.exitCode = 1;
}

export function registerDb(program: Command): void {
  const db = program
    .command("db")
    .description("PostgREST: table introspection, CRUD, and RPC (as the current session, with RLS enforced)");

  db.command("tables")
    .description("fetch the /rest/v1/ OpenAPI and list exposed tables and RPCs")
    .option("--refresh", "force a cache refresh")
    .action(async (opts) => {
      const app = loadApp();
      const spec = await getPgrestSpec(app, loadSession(app.scopeId), !!opts.refresh);
      const tables = listTables(spec);
      const rpcs = listRpcs(spec);
      console.log("# tables");
      for (const t of tables) console.log(t);
      if (rpcs.length) {
        console.log("# rpc");
        for (const r of rpcs) console.log(r);
      }
    });

  db.command("select <table>")
    .description("query rows (GET /rest/v1/<table>)")
    .option("--eq <col=val>", "equality filter, repeatable", collect, [])
    .option("--select <cols>", "columns to return, comma-separated", "*")
    .option("--order <col[.desc]>", "ordering")
    .option("--limit <n>", "limit the number of rows")
    .action(async (table: string, opts) => {
      const app = loadApp();
      const query: Record<string, string> = { select: opts.select, ...eqToQuery(opts.eq) };
      if (opts.order) query.order = opts.order;
      if (opts.limit) query.limit = String(opts.limit);
      const { status, body } = await request(app, loadSession(app.scopeId), {
        path: `/rest/v1/${table}`,
        query,
        auth: true,
      });
      printResult(status, body);
    });

  db.command("insert <table>")
    .description("insert rows (POST /rest/v1/<table>) and return the inserted rows")
    .option("--data <json>", "row object or array as JSON")
    .option("--file <path>", "read JSON from a file")
    .action(async (table: string, opts) => {
      const app = loadApp();
      const body = readBody(opts);
      if (body === undefined) throw new Error("provide the data to insert via --data or --file");
      const { status, body: res } = await request(app, loadSession(app.scopeId), {
        method: "POST",
        path: `/rest/v1/${table}`,
        body,
        auth: true,
        headers: { Prefer: "return=representation" },
      });
      printResult(status, res);
    });

  db.command("update <table>")
    .description("update rows (PATCH /rest/v1/<table>); requires at least one --eq by default to prevent updating the whole table")
    .option("--eq <col=val>", "equality filter, repeatable", collect, [])
    .option("--data <json>", "fields to update as JSON")
    .option("--file <path>", "read JSON from a file")
    .option("--all", "allow updating the whole table without a filter (dangerous)")
    .action(async (table: string, opts) => {
      const app = loadApp();
      const filters = eqToQuery(opts.eq);
      if (!Object.keys(filters).length && !opts.all) {
        throw new Error("update requires at least one --eq; pass --all to update the whole table");
      }
      const body = readBody(opts);
      if (body === undefined) throw new Error("provide the fields to update via --data or --file");
      const { status, body: res } = await request(app, loadSession(app.scopeId), {
        method: "PATCH",
        path: `/rest/v1/${table}`,
        query: filters,
        body,
        auth: true,
        headers: { Prefer: "return=representation" },
      });
      printResult(status, res);
    });

  db.command("delete <table>")
    .description("delete rows (DELETE /rest/v1/<table>); requires at least one --eq by default to prevent deleting the whole table")
    .option("--eq <col=val>", "equality filter, repeatable", collect, [])
    .option("--all", "allow deleting the whole table without a filter (dangerous)")
    .action(async (table: string, opts) => {
      const app = loadApp();
      const filters = eqToQuery(opts.eq);
      if (!Object.keys(filters).length && !opts.all) {
        throw new Error("delete requires at least one --eq; pass --all to delete the whole table");
      }
      const { status, body: res } = await request(app, loadSession(app.scopeId), {
        method: "DELETE",
        path: `/rest/v1/${table}`,
        query: filters,
        auth: true,
        headers: { Prefer: "return=representation" },
      });
      printResult(status, res);
    });

  db.command("rpc <name>")
    .description("call a Postgres function (POST /rest/v1/rpc/<name>)")
    .option("--data <json>", "arguments object as JSON")
    .option("--file <path>", "read JSON from a file")
    .action(async (name: string, opts) => {
      const app = loadApp();
      const { status, body: res } = await request(app, loadSession(app.scopeId), {
        method: "POST",
        path: `/rest/v1/rpc/${name}`,
        body: readBody(opts) ?? {},
        auth: true,
      });
      printResult(status, res);
    });
}
