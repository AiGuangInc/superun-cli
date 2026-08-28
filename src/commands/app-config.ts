import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import {
  appDirFor,
  findAppDir,
  getActive,
  listAppMetas,
  loadApp,
  normalizeEnvironment,
  removeApp,
  resolveRef,
  setActive,
} from "../config/app.js";
import { refreshFunctions } from "../discovery/functions-manifest.js";

async function ask(q: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(q)).trim();
  } finally {
    rl.close();
  }
}

/** 文件系统安全的注册键 slug。 */
function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "app"
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function normalizeUrl(url: unknown, label: string): string {
  const value = String(url ?? "").trim();
  if (!/^https?:\/\//.test(value)) throw new Error(`${label} must be an http(s) address: ${value || "(empty)"}`);
  return value.replace(/\/+$/, "");
}

function masked(key: string): string {
  return key.slice(0, 12) + "…";
}

/** 顶层 `init`(注册新 app)+ `app` 组(list/use/remove/show/set/where/refresh)。 */
export function registerApp(program: Command): void {
  program
    .command("init")
    .description("configure a Supabase project and set it active; prompts interactively when no arguments are given")
    .option("--url <baseUrl>", "Supabase API base URL (official *.supabase.co or any self-hosted instance)")
    .option("--anon-key <key>", "anon key")
    .option("--debug-url <baseUrl>", "debug Supabase API base URL")
    .option("--debug-anon-key <key>", "debug anon key")
    .option("--environment <environment>", "default target environment (production or debug; debug is the default when configured)")
    .option("--name <alias>", "friendly alias (usable later with app use / -a)")
    .option("--id <id>", "local registration key (defaults to the alias or URL host)")
    .option("--manifest <src>", "Edge Function OpenAPI manifest source (URL / file / function name)")
    .option("--oauth-client-id <id>", "pre-registered OAuth client_id (skips DCR when set; see `superun login --help`)")
    .option("--authorize-url <url>", "override the authorization endpoint (when using your own OAuth AS)")
    .option("--token-url <url>", "override the token endpoint (when using your own OAuth AS)")
    .option("--import <dir>", "optional: copy in a pre-compiled functions directory")
    .action(async (opts) => {
      const url = normalizeUrl(opts.url ?? (await ask("Supabase URL: ")), "url");
      const anonKey = opts.anonKey ?? (await ask("anon key: "));
      if (!anonKey) throw new Error("anon key is required");

      const hasDebugUrl = opts.debugUrl !== undefined;
      const hasDebugAnonKey = opts.debugAnonKey !== undefined;
      if (hasDebugUrl !== hasDebugAnonKey) {
        throw new Error("debug environment requires both --debug-url and --debug-anon-key");
      }
      const debugUrl = hasDebugUrl ? normalizeUrl(opts.debugUrl, "debug url") : undefined;
      const debugAnonKey = hasDebugAnonKey ? String(opts.debugAnonKey) : undefined;
      if (hasDebugAnonKey && !debugAnonKey) throw new Error("debug anon key is required");
      const environment = opts.environment
        ? normalizeEnvironment(opts.environment, "--environment")
        : debugUrl
          ? "debug"
          : "production";
      if (environment === "debug" && (!debugUrl || !debugAnonKey)) {
        throw new Error("debug environment requires both --debug-url and --debug-anon-key");
      }

      const id = slug(opts.id ?? opts.name ?? hostOf(url));
      const dir = appDirFor(id);
      mkdirSync(dir, { recursive: true });
      const app: Record<string, string> = { id, url, anonKey };
      if (opts.environment !== undefined || debugUrl) app.environment = environment;
      if (debugUrl && debugAnonKey) {
        app.debugUrl = debugUrl;
        app.debugAnonKey = debugAnonKey;
      }
      if (opts.name) app.name = opts.name;
      if (opts.manifest) app.manifest = opts.manifest;
      if (opts.authorizeUrl) app.authorizeUrl = opts.authorizeUrl;
      if (opts.tokenUrl) app.tokenUrl = opts.tokenUrl;
      writeFileSync(join(dir, "app.json"), JSON.stringify(app, null, 2) + "\n");

      if (opts.import) {
        const src = resolve(opts.import);
        if (!existsSync(join(src, "index.json"))) {
          throw new Error(`--import directory has no index.json (it should point to a compiled functions/): ${src}`);
        }
        const runtimeDir = environment === "debug" ? join(dir, "environments", "debug") : dir;
        cpSync(src, join(runtimeDir, "functions"), { recursive: true });
        console.log("✓ Imported functions");
      }

      setActive(id);
      const targetUrl = environment === "debug" ? debugUrl! : url;
      console.log(`✓ Configured and set active: ${opts.name ? `${opts.name} (${id})` : id} [${environment}]  →  ${targetUrl}`);
      console.log("  Run superun from any directory. With multiple apps, switch using `superun app use <name|id>` and list them with `superun app list`");
    });

  const app = program.command("app").description("manage configured apps (multi-project: add/remove/inspect/edit, switch, refresh functions)");
  app.action(() => app.help());

  app
    .command("list")
    .description("list configured apps (* marks the active one)")
    .action(() => {
      const active = getActive();
      const metas = listAppMetas();
      if (!metas.length) {
        console.log("(none; run `superun init` first)");
        return;
      }
      console.log("  alias\tid\tenvironment\turl");
      for (const m of metas) {
        const mark = m.id === active ? "*" : " ";
        console.log(`${mark} ${m.name ?? "-"}\t${m.id}\t${m.environment}\t${m.baseUrl}`);
      }
    });

  app
    .command("use <ref>")
    .description("switch the active app (name or id)")
    .action((ref: string) => {
      const id = resolveRef(ref);
      if (!id) throw new Error(`App not found: ${ref} (run \`superun app list\` to see registered apps)`);
      setActive(id);
      console.log(`✓ Active app → ${id}`);
    });

  app
    .command("remove <ref>")
    .alias("rm")
    .description("remove a configured app (along with its session cache)")
    .action((ref: string) => {
      const id = resolveRef(ref);
      if (!id) throw new Error(`App not found: ${ref} (run \`superun app list\` to see registered apps)`);
      removeApp(id);
      console.log(`✓ Removed ${id}`);
    });

  app
    .command("show")
    .description("show the configuration of the current (or -a specified) app")
    .action(() => {
      const a = loadApp();
      console.log(
        JSON.stringify(
          {
            id: a.id,
            name: a.name ?? null,
            environment: a.environment,
            url: a.baseUrl,
            targets: {
              production: { url: a.targets.production.baseUrl, anonKey: masked(a.targets.production.anonKey) },
              debug: a.targets.debug
                ? { url: a.targets.debug.baseUrl, anonKey: masked(a.targets.debug.anonKey) }
                : "(not configured)",
            },
            manifest: a.manifest ?? "(default /functions/v1/_cli-manifest)",
            browserLogin: {
              clientId: a.oauthClientId ?? "(none → cache/DCR)",
              authorizeUrl: a.authorizeUrl ?? "(default: project OAuth server)",
              tokenUrl: a.tokenUrl ?? "(default: project OAuth server)",
            },
            anonKey: masked(a.anonKey),
            dir: a.dir,
            runtimeDir: a.runtimeDir,
          },
          null,
          2,
        ),
      );
    });

  app
    .command("set")
    .description("update configuration fields of the current (or -a specified) app; only the fields you pass are changed")
    .option("--name <alias>", "change the alias")
    .option("--anon-key <key>", "change the anon key")
    .option("--url <baseUrl>", "change the base URL")
    .option("--debug-anon-key <key>", "change the debug anon key")
    .option("--debug-url <baseUrl>", "change the debug base URL")
    .option("--environment <environment>", "change the default target environment (production or debug)")
    .option("--manifest <src>", "change the manifest source")
    .option("--oauth-client-id <id>", "change the pre-registered OAuth client_id")
    .option("--authorize-url <url>", "change the OAuth authorization endpoint")
    .option("--token-url <url>", "change the OAuth token endpoint")
    .action((opts) => {
      const f = join(findAppDir(), "app.json");
      const raw = JSON.parse(readFileSync(f, "utf8")) as Record<string, unknown>;
      const changed: string[] = [];
      if (opts.name !== undefined) (raw.name = opts.name), changed.push("name");
      if (opts.anonKey !== undefined) {
        if (!opts.anonKey) throw new Error("anon key is required");
        raw.anonKey = opts.anonKey;
        changed.push("anonKey");
      }
      if (opts.url !== undefined) (raw.url = normalizeUrl(opts.url, "url")), changed.push("url");
      if (opts.debugAnonKey !== undefined) {
        if (!opts.debugAnonKey) throw new Error("debug anon key is required");
        raw.debugAnonKey = opts.debugAnonKey;
        changed.push("debugAnonKey");
      }
      if (opts.debugUrl !== undefined) (raw.debugUrl = normalizeUrl(opts.debugUrl, "debug url")), changed.push("debugUrl");
      if (opts.environment !== undefined) {
        raw.environment = normalizeEnvironment(opts.environment, "--environment");
        changed.push("environment");
      } else if (opts.debugUrl !== undefined && opts.debugAnonKey !== undefined) {
        raw.environment = "debug";
        changed.push("environment");
      }
      if (opts.manifest !== undefined) (raw.manifest = opts.manifest), changed.push("manifest");
      if (opts.oauthClientId !== undefined) (raw.oauthClientId = opts.oauthClientId), changed.push("oauthClientId");
      if (opts.authorizeUrl !== undefined) (raw.authorizeUrl = opts.authorizeUrl), changed.push("authorizeUrl");
      if (opts.tokenUrl !== undefined) (raw.tokenUrl = opts.tokenUrl), changed.push("tokenUrl");
      if (!changed.length) {
        throw new Error(
          "No fields to change (--name/--anon-key/--url/--debug-anon-key/--debug-url/--environment/--manifest/--oauth-client-id/--authorize-url/--token-url)",
        );
      }
      const debugUrl = raw.debugUrl as string | undefined;
      const debugAnonKey = raw.debugAnonKey as string | undefined;
      if (Boolean(debugUrl) !== Boolean(debugAnonKey)) {
        throw new Error("debug environment requires both --debug-url and --debug-anon-key");
      }
      if (raw.environment && normalizeEnvironment(raw.environment, "app.json environment") === "debug" && !debugUrl) {
        throw new Error("debug environment is selected but debug URL/key are not configured");
      }
      writeFileSync(f, JSON.stringify(raw, null, 2) + "\n");
      console.log(`✓ Updated ${raw.id ?? ""}: ${changed.join(", ")}`);
      if (changed.includes("manifest") || changed.includes("url") || changed.includes("debugUrl") || changed.includes("environment")) {
        console.log("  (manifest/target changed; run `superun app refresh` to re-fetch functions for the selected environment)");
      }
    });

  app
    .command("where")
    .description("show which configuration directory will be used (for debugging \"config not found\")")
    .action(() => {
      try {
        console.log(findAppDir());
      } catch (e) {
        console.log(e instanceof Error ? e.message : String(e));
        process.exitCode = 1;
      }
    });

  app
    .command("refresh")
    .description("fetch Edge Function descriptions (OpenAPI) from the backend and compile them into a local cache for fn")
    .option("--manifest <urlOrPathOrName>", "override the manifest source (http(s) URL / local file / function name)")
    .action(async (opts) => {
      const a = loadApp();
      const { source, count } = await refreshFunctions(a, opts.manifest);
      console.log(`✓ Refreshed ${count} function(s) for ${a.environment} (source: ${source})`);
    });
}
