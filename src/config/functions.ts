import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface GroupInfo {
  name: string;
  description?: string;
}

export interface FnSummary {
  name: string;
  group: string;
  summary: string;
  verifyJwt: boolean;
}

/** 编译产物:单个函数的运行时最小数据集(schema 已内联,无 $ref)。 */
export interface CompiledFn {
  name: string;
  group: string;
  method: string;
  verifyJwt: boolean;
  summary: string;
  description?: string;
  /** 请求体 JSON Schema 2020-12(已 deref) */
  input?: any;
  /** 200 响应 JSON Schema(可选) */
  output?: any;
}

interface CompiledIndex {
  schemaVersion: number;
  groups: GroupInfo[];
  functions: FnSummary[];
}

/**
 * 运行时 edge function 读取器:**只读本地缓存**(`functions/index.json` + `functions/<name>.json`)。
 * 不解析 OpenAPI、不引 parser —— 编译只在 `superun app refresh` 时一次性做完。
 *   listGroups()    L0 — 只读 index 的 groups
 *   listFunctions() L1 — 只读 index 的函数摘要,不读单函数文件
 *   resolveLeaf()   L2 — 读单个 <name>.json(已编译,JSON.parse 即得)
 */
export class FunctionsTree {
  private readonly dir: string;
  private readonly indexPath: string;
  private index?: CompiledIndex;

  constructor(appDir: string) {
    this.dir = join(appDir, "functions");
    this.indexPath = join(this.dir, "index.json");
  }

  private loadIndex(): CompiledIndex {
    if (!this.index) {
      if (!existsSync(this.indexPath)) {
        throw new Error(`No local function cache found (${this.indexPath}); run \`superun app refresh\` first`);
      }
      this.index = JSON.parse(readFileSync(this.indexPath, "utf8")) as CompiledIndex;
    }
    return this.index;
  }

  listGroups(): GroupInfo[] {
    return this.loadIndex().groups ?? [];
  }

  listFunctions(group?: string): FnSummary[] {
    const fns = this.loadIndex().functions ?? [];
    return group ? fns.filter((f) => f.group === group) : fns;
  }

  resolveLeaf(ref: string): CompiledFn {
    // 按索引解析:接受规范函数名,或 `group/name` 形式。
    const fns = this.loadIndex().functions ?? [];
    const hit = fns.find((f) => f.name === ref) ?? fns.find((f) => `${f.group}/${f.name}` === ref);
    const name = hit ? hit.name : ref;
    const f = join(this.dir, `${name}.json`);
    if (!existsSync(f)) {
      throw new Error(`Unknown function "${ref}". Run \`superun fn\` or \`superun fn <tag>\` to list available functions`);
    }
    return JSON.parse(readFileSync(f, "utf8")) as CompiledFn;
  }
}
