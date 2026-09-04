import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Command } from "commander";
import { compareSemver } from "../update-check.js";

const execFileAsync = promisify(execFile);
const USE_SHELL = process.platform === "win32";
const SKILL_RAW_URL = "https://raw.githubusercontent.com/AiGuangInc/superun-cli/main/skills/superun/SKILL.md";
export const AUTO_UPGRADE_RESTARTED_ENV = "SUPERUN_AUTO_UPGRADE_RESTARTED";

export interface UpgradeOptions {
  minimumVersion?: string;
  /** 自动强更时所有进度写 stderr，避免污染 db JSON、completion 或 MCP stdout。 */
  automatic?: boolean;
}

export interface UpgradeResult {
  version: string;
  cliEntryPath: string;
}

async function resolveGlobalCliEntry(packageName: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("npm", ["root", "-g"], { shell: USE_SHELL });
    const entry = join(stdout.trim(), packageName, "dist", "cli.js");
    if (existsSync(entry)) return entry;
  } catch {
    // 回落到当前入口；重跑保护会阻止旧版本无限循环。
  }
  return process.argv[1];
}

export async function runUpgrade(
  packageName: string,
  currentVersion: string,
  options: UpgradeOptions = {},
): Promise<UpgradeResult> {
  const log = options.automatic ? console.error : console.log;
  log("Checking for the latest version...");

  let latest: string;
  try {
    const { stdout } = await execFileAsync("npm", ["view", packageName, "version"], {
      shell: USE_SHELL,
    });
    latest = stdout.trim();
  } catch {
    throw new Error("Version check failed. Verify your network and npm registry");
  }

  const target = options.minimumVersion && compareSemver(options.minimumVersion, latest) > 0
    ? options.minimumVersion
    : latest;

  if (compareSemver(target, currentVersion) <= 0) {
    log(`Already up to date (v${currentVersion})`);
    return { version: currentVersion, cliEntryPath: process.argv[1] };
  }

  log(`New version available: v${currentVersion} → v${target}, upgrading...`);
  const code = await new Promise<number>((resolve) => {
    const child = spawn("npm", ["install", "-g", `${packageName}@${target}`], {
      stdio: options.automatic
        ? ["inherit", process.stderr, process.stderr]
        : "inherit",
      shell: USE_SHELL,
    });
    child.on("close", (exitCode) => resolve(exitCode ?? 1));
    child.on("error", () => resolve(1));
  });

  if (code !== 0) {
    throw new Error(`Upgrade failed. Run manually: npm install -g ${packageName}@latest`);
  }

  log(`Upgraded to v${target}`);
  log(`Update the superun skill: ${SKILL_RAW_URL}`);
  return {
    version: target,
    cliEntryPath: await resolveGlobalCliEntry(packageName),
  };
}

export async function rerunCurrentCommand(cliEntryPath: string): Promise<never> {
  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, [cliEntryPath, ...process.argv.slice(2)], {
      stdio: "inherit",
      env: {
        ...process.env,
        [AUTO_UPGRADE_RESTARTED_ENV]: "1",
      },
    });
    child.once("close", (code) => resolve(code ?? 1));
    child.once("error", reject);
  });
  process.exit(exitCode);
}

export function registerUpgrade(
  program: Command,
  packageName: string,
  currentVersion: string,
): void {
  program
    .command("upgrade")
    .description("upgrade superun CLI to the latest version from npm")
    .action(async () => {
      await runUpgrade(packageName, currentVersion);
    });
}
