import { dereferenceDoc, pickOperation, validateDoc } from "./openapi.js";
import type { CompiledFn, FnSummary, GroupInfo } from "./config/functions.js";

export interface CompiledManifest {
  index: { schemaVersion: number; groups: GroupInfo[]; functions: FnSummary[] };
  functions: Record<string, CompiledFn>;
}

/**
 * 把后端吐回来的「一整份 OpenAPI 3.1 文档」(各 path 即一个函数,tags 即分组)
 * 校验 + deref + 降解成运行时最小集。只在 refresh 时跑一次,结果落缓存。
 */
export async function compileFromDoc(doc: unknown): Promise<CompiledManifest> {
  const verr = await validateDoc(structuredClone(doc));
  if (verr) throw new Error(`Manifest failed OpenAPI 3.1 validation:\n${verr}`);
  const dereffed = await dereferenceDoc(doc);

  const functions: Record<string, CompiledFn> = {};
  const fnIndex: FnSummary[] = [];

  for (const [p, item] of Object.entries(dereffed.paths ?? {}) as [string, any][]) {
    const name = p.replace(/^\//, "");
    const picked = pickOperation(item);
    if (!picked) continue;
    const op = picked.operation;
    const verifyJwt = Array.isArray(op.security) && op.security.length > 0;
    // 分组优先用 OpenAPI tag;没有则按路径首段(/api/runtime-tick → api),再没有则 default
    const group = (Array.isArray(op.tags) && op.tags[0]) || (name.includes("/") ? name.split("/")[0] : "default");
    const summary: string = op.summary ?? "";
    const input = op.requestBody?.content?.["application/json"]?.schema ?? null;
    const output = op.responses?.["200"]?.content?.["application/json"]?.schema ?? null;

    const compiled: CompiledFn = { name, group, method: picked.method, verifyJwt, summary };
    if (op.description) compiled.description = op.description;
    if (input) compiled.input = input;
    if (output) compiled.output = output;
    functions[name] = compiled;
    fnIndex.push({ name, group, summary, verifyJwt });
  }

  // groups:优先用 doc.tags 的 name+description,补齐出现过但未声明的 group
  const declared: GroupInfo[] = Array.isArray(dereffed.tags) ? dereffed.tags : [];
  const used = new Set(fnIndex.map((f) => f.group));
  const groups: GroupInfo[] = [];
  for (const t of declared) if (used.has(t.name)) groups.push({ name: t.name, description: t.description });
  for (const g of used) if (!groups.some((x) => x.name === g)) groups.push({ name: g });

  return { index: { schemaVersion: 1, groups, functions: fnIndex }, functions };
}
