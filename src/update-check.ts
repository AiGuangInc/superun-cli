import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { configRoot } from "./paths.js";

const TIMEOUT_MS = 3000;
const CACHE_FILE = "update-policy.json";

interface UpdatePolicyCache {
  checkedAt: number;
  latestVersion?: string;
  requiredVersion?: string;
}

interface RegistryDistTags {
  latest?: unknown;
  required?: unknown;
}

interface LoadedUpdatePolicy {
  policy: UpdatePolicyCache;
  refreshed: boolean;
}

function exactSemver(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(normalized)
    ? normalized
    : undefined;
}

export function compareSemver(a: string, b: string): number {
  const pa = a.split("-")[0].split(".").map(Number);
  const pb = b.split("-")[0].split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

function isSameLocalDay(a: number, b: number): boolean {
  const left = new Date(a);
  const right = new Date(b);
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
}

function policyPath(): string {
  return join(configRoot(), CACHE_FILE);
}

async function readPolicyCache(): Promise<UpdatePolicyCache | undefined> {
  try {
    const parsed = JSON.parse(await readFile(policyPath(), "utf8")) as Partial<UpdatePolicyCache>;
    if (typeof parsed.checkedAt !== "number") return undefined;
    return {
      checkedAt: parsed.checkedAt,
      latestVersion: exactSemver(parsed.latestVersion),
      requiredVersion: exactSemver(parsed.requiredVersion),
    };
  } catch {
    return undefined;
  }
}

async function writePolicyCache(cache: UpdatePolicyCache): Promise<void> {
  try {
    const root = configRoot();
    await mkdir(root, { recursive: true });
    const target = policyPath();
    const temporary = join(root, `.${CACHE_FILE}.${process.pid}.tmp`);
    await writeFile(temporary, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
    await rename(temporary, target);
  } catch {
    // 更新策略缓存不能阻断用户命令；下次运行会重新检查。
  }
}

async function loadUpdatePolicy(packageName: string): Promise<LoadedUpdatePolicy> {
  const cached = await readPolicyCache();
  const now = Date.now();
  if (cached && isSameLocalDay(now, cached.checkedAt)) {
    return { policy: cached, refreshed: false };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const url = `https://registry.npmjs.org/-/package/${encodeURIComponent(packageName)}/dist-tags`;
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`npm registry returned HTTP ${response.status}`);

    const tags = (await response.json()) as RegistryDistTags;
    const policy: UpdatePolicyCache = {
      checkedAt: now,
      latestVersion: exactSemver(tags.latest),
      requiredVersion: exactSemver(tags.required),
    };
    await writePolicyCache(policy);
    return { policy, refreshed: true };
  } catch {
    // registry 故障时沿用已知强更下限；没有缓存则 fail-open，避免全局不可用。
    const policy: UpdatePolicyCache = {
      checkedAt: now,
      latestVersion: cached?.latestVersion,
      requiredVersion: cached?.requiredVersion,
    };
    await writePolicyCache(policy);
    return { policy, refreshed: false };
  } finally {
    clearTimeout(timer);
  }
}

/** 每天首次运行时读取 npm 策略；返回值表示必须自动升级到的最低版本。 */
export async function checkUpdatePolicy(
  packageName: string,
  currentVersion: string,
): Promise<string | undefined> {
  const { policy, refreshed } = await loadUpdatePolicy(packageName);

  if (policy.requiredVersion && compareSemver(policy.requiredVersion, currentVersion) > 0) {
    return policy.requiredVersion;
  }

  if (refreshed && policy.latestVersion && compareSemver(policy.latestVersion, currentVersion) > 0) {
    // stderr 保持 db JSON、completion 和 MCP stdout 可被程序安全消费。
    console.error(`New superun CLI version v${policy.latestVersion} available (current v${currentVersion}). Run superun upgrade to update`);
  }

  return undefined;
}
