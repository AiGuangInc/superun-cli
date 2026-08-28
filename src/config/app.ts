import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { configRoot } from "../paths.js";

export interface AppConfig {
  /** 本地注册键(= 别名 slug 或 URL 主机名 slug),用于本地目录 / 会话 / 缓存。 */
  id: string;
  /** 友好别名(可选)。 */
  name?: string;
  /** Supabase API base URL —— 官方(*.supabase.co)或任意自建实例均可。 */
  baseUrl: string;
  anonKey: string;
  /** 本次命令实际使用的环境。 */
  environment: AppEnvironment;
  /** 会话与其他用户级缓存的隔离键；production 保持旧 id，debug 使用独立子键。 */
  scopeId: string;
  /** Edge Function / OAuth 等项目内运行时缓存目录，按环境隔离。 */
  runtimeDir: string;
  /** 项目已配置的运行目标。 */
  targets: {
    production: AppTarget;
    debug?: AppTarget;
  };
  /** edge function OpenAPI manifest 来源(URL / 本地文件 / 函数名)。 */
  manifest?: string;
  /** 浏览器登录(OAuth2 授权码 + PKCE)的授权端点。 */
  authorizeUrl?: string;
  /** 浏览器登录的 token 端点。 */
  tokenUrl?: string;
  /** 预注册的 OAuth client_id(配了就不走 DCR 自助注册)。 */
  oauthClientId?: string;
  /** 配置目录的绝对路径。 */
  dir: string;
}

export type AppEnvironment = "production" | "debug";

export interface AppTarget {
  baseUrl: string;
  anonKey: string;
}

/** 本次命令的 app 覆盖(由 `-a/--app` 设置,见 program.ts),优先级高于活跃 app。 */
let overrideId: string | null = null;
export function setActiveOverride(id: string | null): void {
  overrideId = id;
}

/** 本次命令的环境覆盖(由 `-e/--env` 设置)。 */
let overrideEnvironment: AppEnvironment | null = null;

export function normalizeEnvironment(value: unknown, label = "environment"): AppEnvironment {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (normalized === "production" || normalized === "prod") return "production";
  if (normalized === "debug" || normalized === "test" || normalized === "testing") return "debug";
  throw new Error(`${label} must be production or debug: ${value || "(empty)"}`);
}

export function setEnvironmentOverride(environment: string | null): void {
  overrideEnvironment = environment == null ? null : normalizeEnvironment(environment, "--env");
}

/** 配置发现顺序:APP_CLI_DIR(env) → `-a/--app` 覆盖 → 向上找 `.app-cli/` → 活跃 app。 */
export function findAppDir(start = process.cwd()): string {
  const env = process.env.APP_CLI_DIR;
  if (env) return resolve(env);

  if (overrideId) {
    const d = appDirFor(overrideId);
    if (existsSync(join(d, "app.json"))) return d;
    throw new Error(`App specified by --app is not registered: ${overrideId}`);
  }

  let cur = resolve(start);
  for (;;) {
    if (existsSync(join(cur, ".app-cli", "app.json"))) return join(cur, ".app-cli");
    if (existsSync(join(cur, "app.json")) && existsSync(join(cur, "functions"))) return cur;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }

  const active = getActive();
  if (active) {
    const d = appDirFor(active);
    if (existsSync(join(d, "app.json"))) return d;
  }
  throw new Error(
    `No .app-cli/app.json found searching upward from ${resolve(start)}, and no active project.` +
      `\n  - Register one with \`superun init --url <Supabase URL> --anon-key <key>\`` +
      `\n  - Or select a registered one with \`superun use <name|id>\`` +
      `\n  - Or cd into a directory containing .app-cli, or set APP_CLI_DIR`,
  );
}

// ---- 全局 app 注册表(跨平台配置根下,见 paths.ts)----

export function homeRoot(): string {
  return configRoot();
}

export function appsRoot(): string {
  return join(homeRoot(), "apps");
}

export function appDirFor(id: string): string {
  return join(appsRoot(), id);
}

export function getActive(): string | null {
  const f = join(homeRoot(), "active");
  if (!existsSync(f)) return null;
  return readFileSync(f, "utf8").trim() || null;
}

export function setActive(id: string): void {
  mkdirSync(homeRoot(), { recursive: true });
  writeFileSync(join(homeRoot(), "active"), id + "\n");
}

/** 删除一个 app:配置目录 + 其 session 缓存;若是活跃 app 则清除活跃指针。 */
export function removeApp(id: string): void {
  rmSync(appDirFor(id), { recursive: true, force: true });
  rmSync(join(configRoot(), "sessions", id), { recursive: true, force: true });
  if (getActive() === id) {
    const f = join(homeRoot(), "active");
    if (existsSync(f)) rmSync(f);
  }
}

export function listApps(): string[] {
  const r = appsRoot();
  if (!existsSync(r)) return [];
  return readdirSync(r, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(r, d.name, "app.json")))
    .map((d) => d.name);
}

export interface AppMeta {
  id: string;
  name?: string;
  baseUrl: string;
  environment: AppEnvironment;
  debugConfigured: boolean;
}

export function listAppMetas(): AppMeta[] {
  return listApps().map((id) => {
    try {
      const raw = JSON.parse(readFileSync(join(appDirFor(id), "app.json"), "utf8")) as Record<string, unknown>;
      const productionUrl = ((raw.url ?? raw.baseUrl) as string | undefined) ?? "";
      const debugUrl = raw.debugUrl as string | undefined;
      const hasDebugConfig = Boolean(debugUrl || raw.debugAnonKey);
      const debugConfigured = Boolean(debugUrl && raw.debugAnonKey);
      const environment = raw.environment
        ? normalizeEnvironment(raw.environment, "app.json environment")
        : hasDebugConfig
          ? "debug"
          : "production";
      return {
        id,
        name: raw.name as string | undefined,
        baseUrl: environment === "debug" && debugUrl ? debugUrl : productionUrl,
        environment,
        debugConfigured,
      };
    } catch {
      return { id, baseUrl: "", environment: "production", debugConfigured: false };
    }
  });
}

/** 把一个引用(id 或别名)解析成注册键 id;解析不到返回 null。 */
export function resolveRef(ref: string): string | null {
  if (existsSync(join(appDirFor(ref), "app.json"))) return ref;
  for (const m of listAppMetas()) if (m.name && m.name === ref) return m.id;
  return null;
}

export function loadApp(start?: string): AppConfig {
  const dir = findAppDir(start);
  const raw = JSON.parse(readFileSync(join(dir, "app.json"), "utf8")) as Record<string, unknown>;
  const id = (raw.id as string | undefined) ?? basename(dir);
  const production: AppTarget = {
    baseUrl: ((raw.url ?? raw.baseUrl) as string | undefined)?.replace(/\/+$/, "") ?? "",
    anonKey: process.env.APP_CLI_ANON_KEY ?? (raw.anonKey as string | undefined) ?? "",
  };
  if (!production.baseUrl) throw new Error("app.json is missing url");
  if (!production.anonKey) throw new Error("app.json is missing anonKey (or set APP_CLI_ANON_KEY)");

  const debugUrl = (process.env.APP_CLI_DEBUG_URL ?? (raw.debugUrl as string | undefined))?.replace(/\/+$/, "");
  const debugAnonKey = process.env.APP_CLI_DEBUG_ANON_KEY ?? (raw.debugAnonKey as string | undefined);
  const hasDebugConfig = Boolean(debugUrl || debugAnonKey);
  const debug = debugUrl && debugAnonKey ? { baseUrl: debugUrl, anonKey: debugAnonKey } : undefined;
  const configuredEnvironment = raw.environment
    ? normalizeEnvironment(raw.environment, "app.json environment")
    : undefined;
  const environment =
    overrideEnvironment ??
    (process.env.APP_CLI_ENVIRONMENT
      ? normalizeEnvironment(process.env.APP_CLI_ENVIRONMENT, "APP_CLI_ENVIRONMENT")
      : configuredEnvironment ?? (hasDebugConfig ? "debug" : "production"));
  if (environment === "debug" && !debug) {
    const missing = [!debugUrl && "debugUrl/APP_CLI_DEBUG_URL", !debugAnonKey && "debugAnonKey/APP_CLI_DEBUG_ANON_KEY"]
      .filter(Boolean)
      .join(" and ");
    throw new Error(`Debug environment is selected but missing ${missing}`);
  }
  const target = environment === "debug" ? debug! : production;
  return {
    id,
    name: raw.name as string | undefined,
    baseUrl: target.baseUrl,
    anonKey: target.anonKey,
    environment,
    scopeId: environment === "production" ? id : `${id}/debug`,
    runtimeDir: environment === "production" ? dir : join(dir, "environments", "debug"),
    targets: { production, ...(debug ? { debug } : {}) },
    manifest: raw.manifest as string | undefined,
    authorizeUrl: raw.authorizeUrl as string | undefined,
    tokenUrl: raw.tokenUrl as string | undefined,
    oauthClientId: raw.oauthClientId as string | undefined,
    dir,
  };
}
