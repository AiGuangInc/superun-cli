// 仅在 `app refresh` 路径用(动态 import),让运行时热路径(fn/db/login)不加载 parser。

const METHODS = ["post", "get", "put", "patch", "delete", "options", "head", "trace"] as const;

/** deref 一份内存里的 OpenAPI 文档(解析其内部 $ref)。用于 refresh 拉到的 manifest。 */
export async function dereferenceDoc(doc: unknown): Promise<any> {
  const { dereference } = await import("@readme/openapi-parser");
  return dereference(doc as any);
}

/** 校验一份内存里的 OpenAPI 3.1 文档。通过返回 null,否则返回人读错误串。 */
export async function validateDoc(doc: unknown): Promise<string | null> {
  const { validate, compileErrors } = await import("@readme/openapi-parser");
  const res = await validate(doc as any);
  return res.valid ? null : compileErrors(res);
}

/** 从 pathItem 取首个(通常唯一)operation 及其 HTTP 方法。 */
export function pickOperation(pathItem: any): { method: string; operation: any } | null {
  if (!pathItem) return null;
  for (const m of METHODS) if (pathItem[m]) return { method: m, operation: pathItem[m] };
  return null;
}
