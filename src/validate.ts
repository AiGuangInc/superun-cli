import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";

// ajv-formats 默认导出在 esbuild(tsx)与 node(tsc 产物)下解包形态不一,统一兜一层。
const addFormats = ((addFormatsImport as any).default ?? addFormatsImport) as (ajv: unknown, opts?: unknown) => unknown;

export interface InputCheck {
  ok: boolean;
  errors: string[];
}

/** 用 JSON Schema 2020-12 校验入参(schema 来自编译产物的 input,已内联无 $ref)。 */
export function validateInput(schema: any, data: unknown): InputCheck {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  const fn = ajv.compile(schema);
  const ok = fn(data) as boolean;
  const errors = (fn.errors ?? []).map((e) => `${e.instancePath || "(root)"} ${e.message ?? ""}`.trim());
  return { ok, errors };
}
