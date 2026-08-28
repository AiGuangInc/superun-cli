import { Command } from "commander";
import { readFileSync } from "node:fs";
import { loadApp, resolveRef, setActiveOverride, setEnvironmentOverride } from "./config/app.js";
import { registerApp } from "./commands/app-config.js";
import { registerCompletion } from "./commands/completion.js";
import { registerDb } from "./commands/db.js";
import { buildFnCommands } from "./commands/fn.js";
import { registerLogin } from "./commands/login.js";
import { registerWhoami } from "./commands/whoami.js";
import { ensureManifest } from "./discovery/functions-manifest.js";

const VERSION = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

/** 从 argv 里取 `-a/--app <ref>`(命令树需在 parse 前据此定位 app)。 */
function peekAppRef(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-a" || a === "--app") return argv[i + 1];
    if (a.startsWith("--app=")) return a.slice("--app=".length);
  }
  return undefined;
}

/** 从 argv 里取 `-e/--env <environment>`。 */
function peekEnvironment(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-e" || a === "--env") return argv[i + 1];
    if (a.startsWith("--env=")) return a.slice("--env=".length);
  }
  return undefined;
}

/** 本次调用的顶层命令是否为 fn(跳过前导全局选项)。 */
function commandIsFn(argv: string[]): boolean {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-a" || a === "--app" || a === "-e" || a === "--env") {
      i++;
      continue;
    }
    if (a.startsWith("--app=") || a.startsWith("--env=")) continue;
    if (a.startsWith("-")) continue;
    return a === "fn";
  }
  return false;
}

export async function createProgram(): Promise<Command> {
  const program = new Command();
  program
    .name("superun")
    .description("A universal, configuration-driven CLI for any Supabase-compatible backend; run db and fn as the current user")
    .version(VERSION)
    .option("-a, --app <ref>", "target a registered app (name or id) for this command, overriding the active project")
    .option("-e, --env <environment>", "target production or debug for this command, overriding the project's default");

  program.hook("preAction", () => {
    const ref = program.opts().app as string | undefined;
    if (ref) setActiveOverride(resolveRef(ref) ?? ref);
    const environment = program.opts().env as string | undefined;
    if (environment) setEnvironmentOverride(environment);
  });

  registerApp(program); // 顶层 init + app 组(list/use/remove/show/set/where/refresh)
  registerLogin(program);
  registerWhoami(program);
  registerDb(program);
  registerCompletion(program); // 隐藏:completion / __complete

  // fn 命令树按缓存的 manifest 动态生成(tag → 函数 → 调用)
  const fnCmd = program.command("fn").description("Edge Functions, grouped by tag: superun fn <tag> <function>");
  if (commandIsFn(process.argv.slice(2))) {
    try {
      const ref = peekAppRef(process.argv.slice(2));
      if (ref) setActiveOverride(resolveRef(ref) ?? ref);
      const environment = peekEnvironment(process.argv.slice(2));
      if (environment) setEnvironmentOverride(environment);
      const app = loadApp();
      await ensureManifest(app); // 无缓存则懒拉一次
      buildFnCommands(fnCmd, app);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      fnCmd
        .allowUnknownOption(true)
        .argument("[args...]")
        .action(() => {
          console.error("Error:", msg);
          process.exit(1);
        });
    }
  }

  return program;
}
