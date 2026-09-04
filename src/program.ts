import { Command } from "commander";
import { readFileSync } from "node:fs";
import { loadApp, resolveRef, setActiveOverride, setEnvironmentOverride } from "./config/app.js";
import { registerApp } from "./commands/app-config.js";
import { registerCompletion } from "./commands/completion.js";
import { registerDb } from "./commands/db.js";
import { buildFnCommands } from "./commands/fn.js";
import { registerLogin } from "./commands/login.js";
import { registerMcp } from "./commands/mcp.js";
import {
  AUTO_UPGRADE_RESTARTED_ENV,
  registerUpgrade,
  rerunCurrentCommand,
  runUpgrade,
} from "./commands/upgrade.js";
import { registerWhoami } from "./commands/whoami.js";
import { ensureManifest } from "./discovery/functions-manifest.js";
import { checkUpdatePolicy } from "./update-check.js";

const PACKAGE = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  name: string;
  version: string;
};

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

/** 解析顶层命令，跳过带值的全局选项。 */
function topLevelCommand(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-a" || a === "--app" || a === "-e" || a === "--env") {
      i++;
      continue;
    }
    if (a.startsWith("--app=") || a.startsWith("--env=")) continue;
    if (a === "--") return argv[i + 1];
    if (a.startsWith("-")) continue;
    return a;
  }
  return undefined;
}

function shouldSkipUpdateCheck(argv: string[]): boolean {
  if (argv.some((arg) => arg === "--help" || arg === "-h" || arg === "--version" || arg === "-V")) {
    return true;
  }
  const command = topLevelCommand(argv);
  return !command || ["upgrade", "help", "completion", "__complete"].includes(command);
}

async function ensureCliVersion(argv: string[]): Promise<void> {
  if (shouldSkipUpdateCheck(argv)) return;

  const requiredVersion = await checkUpdatePolicy(PACKAGE.name, PACKAGE.version);
  if (!requiredVersion) return;

  if (process.env[AUTO_UPGRADE_RESTARTED_ENV] === "1") {
    throw new Error(
      `The installed version is still below required v${requiredVersion} after auto-upgrade. `
      + `Run npm install -g ${PACKAGE.name}@latest manually`,
    );
  }

  console.error(
    `superun CLI v${PACKAGE.version} is below required v${requiredVersion}; `
    + "upgrading automatically before continuing the original command",
  );
  const result = await runUpgrade(PACKAGE.name, PACKAGE.version, {
    minimumVersion: requiredVersion,
    automatic: true,
  });
  await rerunCurrentCommand(result.cliEntryPath);
}

export async function createProgram(): Promise<Command> {
  await ensureCliVersion(process.argv.slice(2));

  const program = new Command();
  program
    .name("superun")
    .description("A universal, configuration-driven CLI for any Supabase-compatible backend; run db and fn as the current user")
    .version(PACKAGE.version)
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
  registerMcp(program);
  registerUpgrade(program, PACKAGE.name, PACKAGE.version);
  registerCompletion(program); // 隐藏:completion / __complete

  // fn 命令树按缓存的 manifest 动态生成(tag → 函数 → 调用)
  const fnCmd = program.command("fn").description("Edge Functions, grouped by tag: superun fn <tag> <function>");
  if (topLevelCommand(process.argv.slice(2)) === "fn") {
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
