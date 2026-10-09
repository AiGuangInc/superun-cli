import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
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
    const { status, body } = await request(app, loadSession(app.scopeId), {
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
  if (!existsSync(join(app.runtimeDir, "functions", "index.json"))) {
    await refreshFunctions(app);
  }
}

/** 只读取总览附带的项目业务说明，不改变接口缓存或阻断原有能力。@author xiuyu.yi */
export async function readProjectSkill(app: AppConfig): Promise<{ source: string | null; content: string | null; error?: string }> {
  let source: string | null = null;
  try {
    const src = resolveSource(app);
    const path = src.kind === "url" ? new URL(src.value).pathname : src.value;
    if (basename(path) !== "openapi.json") {
      return { source, content: null, error: "当前清单来源没有同目录项目业务说明约定。" };
    }
    source = src.kind === "url" ? new URL("./SKILL.md", src.value).href : join(dirname(src.value), "SKILL.md");
    const missing = { source, content: null, error: "项目尚未提供 SKILL.md。" };
    const maxBytes = 256 * 1024;
    let content: string;
    if (src.kind === "file") {
      if (!existsSync(source)) return missing;
      if (statSync(source).size > maxBytes) throw new Error("项目业务说明超过体积限制。");
      content = readFileSync(source, "utf8");
    } else {
      const url = new URL(source);
      url.searchParams.set("_superun_read", randomUUID());
      // 公开文档不携带项目 key 或用户凭据；每次总览读取最新正文。
      const response = await fetch(url, {
        headers: { "Cache-Control": "no-cache, no-store", Pragma: "no-cache" },
        cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15000),
      });
      if (!response.ok || response.headers.get("content-type")?.includes("text/html")) {
        await response.body?.cancel();
        if (response.status === 404) return missing;
        throw new Error(response.ok ? "文档地址返回了 HTML 页面。" : `HTTP ${response.status}`);
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("项目业务说明响应为空。");
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maxBytes) throw new Error("项目业务说明超过体积限制。");
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      content = Buffer.concat(chunks).toString("utf8");
    }
    if (!content.trim() || /<(?:!doctype\s+html|html|head|body)(?:\s|>)/i.test(content)) {
      throw new Error("项目 SKILL.md 为空或返回了站点页面。");
    }
    return { source, content };
  } catch (error) {
    return { source, content: null, error: `项目业务说明读取失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

/** 拉 manifest → 编译 → 写入该 app 的 functions/ 缓存(覆盖)。返回来源与函数数。 */
export async function refreshFunctions(app: AppConfig, override?: string): Promise<{ source: string; count: number }> {
  const src = resolveSource(app, override);
  const doc = await fetchDoc(app, src);
  const { index, functions } = await compileFromDoc(doc);

  const outDir = join(app.runtimeDir, "functions");
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
