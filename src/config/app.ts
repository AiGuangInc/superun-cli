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

/** 本次命令的 app 覆盖(由 `-a/--app` 设置,见 program.ts),优先级高于活跃 app。 */
let overrideId: string | null = null;
export function setActiveOverride(id: string | null): void {
  overrideId = id;
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
}

export function listAppMetas(): AppMeta[] {
  return listApps().map((id) => {
    try {
      const raw = JSON.parse(readFileSync(join(appDirFor(id), "app.json"), "utf8")) as Record<string, unknown>;
      return { id, name: raw.name as string | undefined, baseUrl: ((raw.url ?? raw.baseUrl) as string | undefined) ?? "" };
    } catch {
      return { id, baseUrl: "" };
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
  const anonKey = process.env.APP_CLI_ANON_KEY ?? (raw.anonKey as string | undefined);
  const baseUrl = ((raw.url ?? raw.baseUrl) as string | undefined)?.replace(/\/+$/, "");
  if (!baseUrl) throw new Error("app.json is missing url");
  if (!anonKey) throw new Error("app.json is missing anonKey (or set APP_CLI_ANON_KEY)");
  return {
    id,
    name: raw.name as string | undefined,
    baseUrl,
    anonKey,
    manifest: raw.manifest as string | undefined,
    authorizeUrl: raw.authorizeUrl as string | undefined,
    tokenUrl: raw.tokenUrl as string | undefined,
    oauthClientId: raw.oauthClientId as string | undefined,
    dir,
  };
}
