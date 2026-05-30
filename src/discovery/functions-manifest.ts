import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { AppConfig } from "../config/app.js";
import { loadSession } from "../auth/session.js";
import { request } from "../transport/client.js";
import { compileFromDoc } from "../manifest-compile.js";

/** 默认约定:后端部署一个 verifyJwt=false 的 edge function 吐函数 OpenAPI。 */
const DEFAULT_MANIFEST_FN = "_cli-manifest";

type Source = { kind: "file"; value: string } | { kind: "url"; value: string };

/** 解析 manifest 来源:http(s) URL / 本地文件 / 裸函数名(→ baseUrl 下的 edge function)。 */
function resolveSource(app: AppConfig, override?: string): Source {
  const raw = override ?? app.manifest ?? DEFAULT_MANIFEST_FN;
  if (/^https?:\/\//.test(raw)) return { kind: "url", value: raw };
  const p = isAbsolute(raw) ? raw : resolve(raw);
  if (existsSync(p)) return { kind: "file", value: p };
  return { kind: "url", value: `${app.baseUrl}/functions/v1/${raw}` };
}

async function fetchDoc(app: AppConfig, src: Source): Promise<unknown> {
  if (src.kind === "file") return JSON.parse(readFileSync(src.value, "utf8"));
  // 指向本 project 的 URL:走统一 client 带 apikey(+ 可能的 session)
  if (src.value.startsWith(app.baseUrl)) {
    const { status, body } = await request(app, loadSession(app.id), {
      path: src.value.slice(app.baseUrl.length),
      auth: false,
    });
    if (status !== 200) throw new Error(`Failed to fetch manifest, HTTP ${status}: ${src.value}`);
    return typeof body === "string" ? JSON.parse(body) : body;
  }
  // 外部 URL
  const res = await fetch(src.value, { headers: { apikey: app.anonKey } });
  if (!res.ok) throw new Error(`Failed to fetch manifest, HTTP ${res.status}: ${src.value}`);
  return res.json();
}

/** 本地没有函数缓存时,懒拉一次(供 fn 命令树构建 / 补全用)。 */
export async function ensureManifest(app: AppConfig): Promise<void> {
  if (!existsSync(join(app.dir, "functions", "index.json"))) {
    await refreshFunctions(app);
  }
}

/** 拉 manifest → 编译 → 写入该 app 的 functions/ 缓存(覆盖)。返回来源与函数数。 */
export async function refreshFunctions(app: AppConfig, override?: string): Promise<{ source: string; count: number }> {
  const src = resolveSource(app, override);
  const doc = await fetchDoc(app, src);
  const { index, functions } = await compileFromDoc(doc);

  const outDir = join(app.dir, "functions");
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "index.json"), JSON.stringify(index, null, 2) + "\n");
  for (const [name, fn] of Object.entries(functions)) {
    const file = join(outDir, `${name}.json`); // name 可能含 `/`(如 api/runtime-tick)
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(fn, null, 2) + "\n");
  }
  return { source: src.value, count: index.functions.length };
}
