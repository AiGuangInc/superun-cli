import { existsSync } from "node:fs";
import { join } from "node:path";
import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import type { Command } from "commander";
import * as z from "zod/v4";
import { decodeJwt, loadSession, type Session } from "../auth/session.js";
import { loadApp, type AppConfig } from "../config/app.js";
import { FunctionsTree, type CompiledFn } from "../config/functions.js";
import { ensureManifest } from "../discovery/functions-manifest.js";
import { getPgrestSpec, listTables } from "../discovery/pgrest.js";
import { request } from "../transport/client.js";
import { validateInput } from "../validate.js";

const SERVER_VERSION = "0.1.0";
const DEFAULT_ROW_LIMIT = 50;
const MAX_ROW_LIMIT = 200;
const MAX_TOOL_RESULT_BYTES = 1024 * 1024;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

const filterOperatorSchema = z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "like", "ilike", "is"]);
const scalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const identifierSchema = z
  .string()
  .min(1)
  .regex(IDENTIFIER, "must be a simple database identifier (letters, numbers, and underscores)");

const queryRowsSchema = z.object({
  table: z.string().min(1).describe("An exposed table name returned by list_tables"),
  columns: z.array(identifierSchema).min(1).max(30).optional().describe("Columns to return; omit for all columns"),
  filters: z
    .array(
      z.object({
        column: identifierSchema,
        operator: filterOperatorSchema,
        value: scalarSchema,
      }),
    )
    .max(10)
    .optional()
    .describe("AND filters. Use gte/lte for date or numeric ranges."),
  order: z
    .object({
      column: identifierSchema,
      direction: z.enum(["asc", "desc"]).default("asc"),
    })
    .optional(),
  limit: z.number().int().min(1).max(MAX_ROW_LIMIT).default(DEFAULT_ROW_LIMIT),
});

function display(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value ?? null, null, 2);
}

function toolResult(value: unknown): CallToolResult {
  const normalized = value ?? null;
  const output = display(normalized);
  const bytes = Buffer.byteLength(output, "utf8");
  if (bytes > MAX_TOOL_RESULT_BYTES) {
    return oversizedResult(bytes);
  }
  return {
    content: [{ type: "text", text: output }],
    structuredContent: { result: normalized as any },
  };
}

function oversizedResult(bytes: number): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text:
          `MCP result exceeds the ${MAX_TOOL_RESULT_BYTES}-byte safety limit (${bytes} bytes). ` +
          "Reduce columns and/or limit, or narrow the request.",
      },
    ],
    isError: true,
  };
}

function toolError(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  const bytes = Buffer.byteLength(message, "utf8");
  if (bytes > MAX_TOOL_RESULT_BYTES) return oversizedResult(bytes);
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

async function runTool(fn: () => Promise<unknown> | unknown): Promise<CallToolResult> {
  try {
    return toolResult(await fn());
  } catch (error) {
    return toolError(error);
  }
}

function requireSession(app: AppConfig): Session {
  const session = loadSession(app.scopeId);
  if (!session) {
    throw new Error(
      `This tool requires login. Run \`superun --app ${app.id} --env ${app.environment} login --browser\` first.`,
    );
  }
  return session;
}

function summarizeTable(spec: any, table: string): Record<string, unknown> {
  const schema = spec?.definitions?.[table] ?? spec?.components?.schemas?.[table];
  const required = new Set<string>(Array.isArray(schema?.required) ? schema.required : []);
  const properties = schema?.properties;
  if (!properties || typeof properties !== "object") return { name: table };

  const columns = Object.entries(properties).map(([name, raw]) => {
    const property = raw as Record<string, any>;
    const ref = typeof property.$ref === "string" ? property.$ref.split("/").at(-1) : undefined;
    return {
      name,
      type: property.type ?? ref ?? "unknown",
      ...(property.format ? { format: property.format } : {}),
      required: required.has(name),
    };
  });
  return { name: table, columns };
}

function filterExpression(operator: z.infer<typeof filterOperatorSchema>, value: z.infer<typeof scalarSchema>): string {
  if ((operator === "like" || operator === "ilike") && typeof value !== "string") {
    throw new Error(`${operator} filters require a string value`);
  }
  const encoded = value === null ? "null" : String(value);
  return `${operator}.${encoded}`;
}

function queryForRows(args: z.infer<typeof queryRowsSchema>): Record<string, string> {
  const query: Record<string, string> = {
    select: args.columns?.join(",") ?? "*",
    limit: String(args.limit),
  };
  for (const filter of args.filters ?? []) {
    if (query[filter.column] !== undefined) {
      throw new Error(`Only one filter per column is supported; duplicate column: ${filter.column}`);
    }
    query[filter.column] = filterExpression(filter.operator, filter.value);
  }
  if (args.order) query.order = `${args.order.column}.${args.order.direction}`;
  return query;
}

async function functionTree(app: AppConfig): Promise<FunctionsTree> {
  await ensureManifest(app);
  return new FunctionsTree(app.runtimeDir);
}

/** Resolve only names advertised by the compiled manifest; never turn untrusted input into a file path. */
function resolveListedFunction(tree: FunctionsTree, ref: string): CompiledFn {
  const functions = tree.listFunctions();
  const hit = functions.find(fn => fn.name === ref) ?? functions.find(fn => `${fn.group}/${fn.name}` === ref);
  if (!hit) throw new Error(`Unknown function "${ref}". Use list_functions to choose an exposed function.`);
  return tree.resolveLeaf(hit.name);
}

function hasNonEmptyInput(input: unknown): boolean {
  if (input === undefined || input === null) return false;
  if (typeof input === "object" && !Array.isArray(input)) return Object.keys(input as Record<string, unknown>).length > 0;
  return true;
}

function httpResult(status: number, body: unknown): CallToolResult {
  const value = { status, data: body ?? null };
  const result = toolResult(value);
  if (status >= 400) {
    return { ...result, isError: true };
  }
  return result;
}

/** Build the fixed MCP surface for one already-resolved superun app. */
export function createSuperunMcpServer(app: AppConfig): McpServer {
  const server = new McpServer(
    { name: `superun-${app.id}`, version: SERVER_VERSION },
    {
      instructions:
        "Operate only the configured superun project. Discover tables/functions before using them. " +
        "Database access is read-only and limited. call_function may change business data and requires userConfirmed=true only after " +
        "the user has approved that exact function and exact input in the current conversation.",
    },
  );

  server.registerTool(
    "project_status",
    {
      title: "Project status",
      description: "Show the configured project and local credential/cache state without claiming backend connectivity or exposing credentials.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () =>
      runTool(() => {
        const session = loadSession(app.scopeId);
        const claims = session ? decodeJwt(session.access_token) : null;
        return {
          id: app.id,
          name: app.name ?? null,
          environment: app.environment,
          url: app.baseUrl,
          credentialPresent: !!session,
          identity: session
            ? {
                strategy: session.strategy ?? null,
                sub: claims?.sub ?? null,
                email: claims?.email ?? null,
                role: claims?.role ?? null,
                expiresAt: session.expires_at ?? claims?.exp ?? null,
              }
            : null,
          functionManifestCached: existsSync(join(app.runtimeDir, "functions", "index.json")),
        };
      }),
  );

  server.registerTool(
    "list_tables",
    {
      title: "List project tables",
      description:
        "List PostgREST-exposed tables. Pass a table name to return its compact column schema. Requires the current superun login.",
      inputSchema: z.object({
        table: z.string().min(1).optional().describe("Optional table name to inspect"),
        refresh: z.boolean().default(false).describe("Refresh the cached PostgREST schema"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ table, refresh }) =>
      runTool(async () => {
        const session = requireSession(app);
        const spec = await getPgrestSpec(app, session, refresh);
        const tables = listTables(spec);
        if (!table) return { tables };
        if (!tables.includes(table)) throw new Error(`Unknown or unexposed table: ${table}`);
        return { table: summarizeTable(spec, table) };
      }),
  );

  server.registerTool(
    "query_rows",
    {
      title: "Query project rows",
      description:
        `Read rows from one exposed table as the logged-in user with RLS enforced. ` +
        `This tool only sends GET requests; it cannot insert, update, delete, or call database RPCs. Maximum ${MAX_ROW_LIMIT} rows.`,
      inputSchema: queryRowsSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async args => {
      try {
        const session = requireSession(app);
        const spec = await getPgrestSpec(app, session);
        const tables = listTables(spec);
        if (!tables.includes(args.table)) throw new Error(`Unknown or unexposed table: ${args.table}`);
        const { status, body } = await request(app, session, {
          method: "GET",
          path: `/rest/v1/${encodeURIComponent(args.table)}`,
          query: queryForRows(args),
          auth: true,
        });
        return httpResult(status, body);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "list_function_groups",
    {
      title: "List function groups",
      description: "List Edge Function groups discovered from the project's OpenAPI manifest.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () =>
      runTool(async () => {
        const tree = await functionTree(app);
        return { groups: tree.listGroups() };
      }),
  );

  server.registerTool(
    "list_functions",
    {
      title: "List business functions",
      description: "List Edge Functions, optionally within one group. This only reads the local function manifest.",
      inputSchema: z.object({ group: z.string().min(1).optional() }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ group }) =>
      runTool(async () => {
        const tree = await functionTree(app);
        return { functions: tree.listFunctions(group) };
      }),
  );

  server.registerTool(
    "describe_function",
    {
      title: "Describe a business function",
      description: "Return one Edge Function's method, authentication requirement, and input/output JSON schemas before calling it.",
      inputSchema: z.object({ name: z.string().min(1).describe("Function name or group/name reference") }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ name }) =>
      runTool(async () => {
        const tree = await functionTree(app);
        return { function: resolveListedFunction(tree, name) };
      }),
  );

  server.registerTool(
    "call_function",
    {
      title: "Call a business function",
      description:
        "Call one project Edge Function after inspecting its contract. This may change business data or trigger side effects. " +
        "Set userConfirmed=true only after the user has explicitly approved this exact function and exact input in the current conversation.",
      inputSchema: z.object({
        name: z.string().min(1).describe("Function name or group/name reference"),
        input: z.unknown().optional().describe("JSON request body matching describe_function.input"),
        userConfirmed: z
          .literal(true)
          .describe(
            "Set true only after the user explicitly confirms this exact function and exact input in the current conversation",
          ),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ name, input, userConfirmed }) => {
      try {
        // Defense in depth: keep the confirmation gate before manifest discovery or any other possible HTTP request.
        if (userConfirmed !== true) {
          throw new Error(
            "call_function requires userConfirmed=true after the user approves the exact function and exact input in the current conversation",
          );
        }
        const tree = await functionTree(app);
        const fn = resolveListedFunction(tree, name);
        const session = loadSession(app.scopeId);
        if (fn.verifyJwt && !session) {
          throw new Error(
            `Function "${name}" requires login (verifyJwt=true); run \`superun --app ${app.id} --env ${app.environment} login --browser\` first`,
          );
        }

        const method = (fn.method ?? "post").toUpperCase();
        if ((method === "GET" || method === "HEAD") && hasNonEmptyInput(input)) {
          throw new Error(`Function "${name}" uses ${method}; MCP does not send request bodies or infer query parameters for ${method}. Call it without input.`);
        }

        const body = input ?? {};
        if (fn.input) {
          const check = validateInput(fn.input, body);
          if (!check.ok) throw new Error(`Input validation failed:\n${check.errors.map(error => `- ${error}`).join("\n")}`);
        }

        const { status, body: responseBody } = await request(app, session, {
          method,
          path: `/functions/v1/${fn.name}`,
          ...(method === "GET" || method === "HEAD" ? {} : { body }),
          auth: fn.verifyJwt,
        });
        return httpResult(status, responseBody);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  return server;
}

export function registerMcp(program: Command): void {
  program
    .command("mcp")
    .description("serve the selected project as a local stdio MCP server (for WorkBuddy and other MCP hosts)")
    .action(() => {
      const app = loadApp();
      serveStdio(() => createSuperunMcpServer(app), {
        onerror: error => console.error("MCP error:", error.message),
      });
    });
}
