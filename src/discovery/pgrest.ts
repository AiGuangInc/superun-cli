import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig } from "../config/app.js";
import type { Session } from "../auth/session.js";
import { request } from "../transport/client.js";
import { cacheRoot } from "../paths.js";

const TTL_MS = 1000 * 60 * 30; // 30 分钟缓存

function cacheFile(appId: string): string {
  return join(cacheRoot(), appId, "pgrest-openapi.json");
}

/** 首次调用用 anonKey 拉 /rest/v1/ 的 OpenAPI(PostgREST 出 Swagger v2),本地缓存。 */
export async function getPgrestSpec(app: AppConfig, session: Session | null, force = false): Promise<any> {
  const f = cacheFile(app.scopeId);
  if (!force && existsSync(f) && Date.now() - statSync(f).mtimeMs < TTL_MS) {
    return JSON.parse(readFileSync(f, "utf8"));
  }
  const { status, body } = await request(app, session, { path: "/rest/v1/", auth: !!session });
  if (status !== 200) throw new Error(`Failed to fetch PostgREST OpenAPI, HTTP ${status}`);
  mkdirSync(join(f, ".."), { recursive: true });
  writeFileSync(f, typeof body === "string" ? body : JSON.stringify(body));
  return body;
}

/** 只读本地缓存的 PostgREST OpenAPI(不触网,供补全用);没缓存返回 null。 */
export function readCachedSpec(appId: string): any | null {
  const f = cacheFile(appId);
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, "utf8"));
  } catch {
    return null;
  }
}

/** 从 Swagger paths 取暴露的表(排除根与 /rpc/) */
export function listTables(spec: any): string[] {
  return Object.keys(spec?.paths ?? {})
    .filter((p) => p !== "/" && !p.startsWith("/rpc/"))
    .map((p) => p.replace(/^\//, ""));
}

/** 从 Swagger paths 取暴露的 RPC */
export function listRpcs(spec: any): string[] {
  return Object.keys(spec?.paths ?? {})
    .filter((p) => p.startsWith("/rpc/"))
    .map((p) => p.replace(/^\/rpc\//, ""));
}
