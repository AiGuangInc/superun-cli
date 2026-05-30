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

/** 顶层 `init`(注册新 app)+ `app` 组(list/use/remove/show/set/where/refresh)。 */
export function registerApp(program: Command): void {
  program
    .command("init")
    .description("configure a Supabase project and set it active; prompts interactively when no arguments are given")
    .option("--url <baseUrl>", "Supabase API base URL (official *.supabase.co or any self-hosted instance)")
    .option("--anon-key <key>", "anon key")
    .option("--name <alias>", "friendly alias (usable later with app use / -a)")
    .option("--id <id>", "local registration key (defaults to the alias or URL host)")
    .option("--manifest <src>", "Edge Function OpenAPI manifest source (URL / file / function name)")
    .option("--oauth-client-id <id>", "pre-registered OAuth client_id (skips DCR when set; see `superun login --help`)")
    .option("--authorize-url <url>", "override the authorization endpoint (when using your own OAuth AS)")
    .option("--token-url <url>", "override the token endpoint (when using your own OAuth AS)")
    .option("--import <dir>", "optional: copy in a pre-compiled functions directory")
    .action(async (opts) => {
      let url: string = opts.url ?? (await ask("Supabase URL: "));
      if (!/^https?:\/\//.test(url)) throw new Error(`url must be an http(s) address: ${url || "(empty)"}`);
      url = url.replace(/\/+$/, "");
      const anonKey = opts.anonKey ?? (await ask("anon key: "));
      if (!anonKey) throw new Error("anon key is required");

      const id = slug(opts.id ?? opts.name ?? hostOf(url));
      const dir = appDirFor(id);
      mkdirSync(dir, { recursive: true });
      const app: Record<string, string> = { id, url, anonKey };
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
        cpSync(src, join(dir, "functions"), { recursive: true });
        console.log("✓ Imported functions");
      }

      setActive(id);
      console.log(`✓ Configured and set active: ${opts.name ? `${opts.name} (${id})` : id}  →  ${url}`);
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
      console.log("  alias\tid\turl");
      for (const m of metas) {
        const mark = m.id === active ? "*" : " ";
        console.log(`${mark} ${m.name ?? "-"}\t${m.id}\t${m.baseUrl}`);
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
            url: a.baseUrl,
            manifest: a.manifest ?? "(default /functions/v1/_cli-manifest)",
            browserLogin: {
              clientId: a.oauthClientId ?? "(none → cache/DCR)",
              authorizeUrl: a.authorizeUrl ?? "(default: project OAuth server)",
              tokenUrl: a.tokenUrl ?? "(default: project OAuth server)",
            },
            anonKey: a.anonKey.slice(0, 12) + "…",
            dir: a.dir,
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
    .option("--manifest <src>", "change the manifest source")
    .option("--oauth-client-id <id>", "change the pre-registered OAuth client_id")
    .option("--authorize-url <url>", "change the OAuth authorization endpoint")
    .option("--token-url <url>", "change the OAuth token endpoint")
    .action((opts) => {
      const f = join(findAppDir(), "app.json");
      const raw = JSON.parse(readFileSync(f, "utf8")) as Record<string, unknown>;
      const changed: string[] = [];
      if (opts.name !== undefined) (raw.name = opts.name), changed.push("name");
      if (opts.anonKey !== undefined) (raw.anonKey = opts.anonKey), changed.push("anonKey");
      if (opts.url !== undefined) (raw.url = String(opts.url).replace(/\/+$/, "")), changed.push("url");
      if (opts.manifest !== undefined) (raw.manifest = opts.manifest), changed.push("manifest");
      if (opts.oauthClientId !== undefined) (raw.oauthClientId = opts.oauthClientId), changed.push("oauthClientId");
      if (opts.authorizeUrl !== undefined) (raw.authorizeUrl = opts.authorizeUrl), changed.push("authorizeUrl");
      if (opts.tokenUrl !== undefined) (raw.tokenUrl = opts.tokenUrl), changed.push("tokenUrl");
      if (!changed.length) {
        throw new Error("No fields to change (--name/--anon-key/--url/--manifest/--oauth-client-id/--authorize-url/--token-url)");
      }
      writeFileSync(f, JSON.stringify(raw, null, 2) + "\n");
      console.log(`✓ Updated ${raw.id ?? ""}: ${changed.join(", ")}`);
      if (changed.includes("manifest") || changed.includes("url")) {
        console.log("  (manifest/url changed; run `superun app refresh` to re-fetch functions)");
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
      console.log(`✓ Refreshed ${count} function(s) (source: ${source})`);
    });
}
