import { readFileSync } from "node:fs";
import type { Command } from "commander";
import type { AppConfig } from "../config/app.js";
import { FunctionsTree } from "../config/functions.js";
import { loadSession } from "../auth/session.js";
import { request } from "../transport/client.js";
import { validateInput } from "../validate.js";

/** 叶命令名 = 去掉分组前缀后的函数名(api/runtime-tick 在组 api 下 → runtime-tick)。 */
function leafName(name: string, group: string): string {
  return name.startsWith(group + "/") ? name.slice(group.length + 1) : name;
}

/** `--help` 末尾追加该函数的入参/出参契约。 */
function contractHelp(tree: FunctionsTree, name: string): string {
  try {
    const d = tree.resolveLeaf(name);
    const parts: string[] = [""];
    parts.push(d.input ? "Input (JSON):\n" + JSON.stringify(d.input, null, 2) : "Input: none");
    if (d.output) parts.push("Output:\n" + JSON.stringify(d.output, null, 2));
    return parts.join("\n");
  } catch {
    return "";
  }
}

async function callFunction(app: AppConfig, tree: FunctionsTree, name: string, opts: any): Promise<void> {
  const fnDef = tree.resolveLeaf(name);
  const session = loadSession(app.id);
  if (fnDef.verifyJwt && !session) throw new Error(`Function "${name}" requires login (verifyJwt=true); run \`superun login\` first`);

  let body: unknown;
  if (opts.file) body = JSON.parse(readFileSync(opts.file, "utf8"));
  else if (opts.data) body = JSON.parse(opts.data);

  if (opts.validate && fnDef.input) {
    const chk = validateInput(fnDef.input, body ?? {});
    if (!chk.ok) {
      console.error("Input validation failed (use --no-validate to skip):");
      for (const e of chk.errors) console.error("  - " + e);
      process.exitCode = 1;
      return;
    }
  }

  const { status, body: resBody } = await request(app, session, {
    method: (fnDef.method ?? "post").toUpperCase(),
    path: `/functions/v1/${fnDef.name}`,
    body: body ?? {},
    auth: fnDef.verifyJwt,
  });
  console.log(`HTTP ${status}`);
  console.log(typeof resBody === "string" ? resBody : JSON.stringify(resBody, null, 2));
  if (status >= 400) process.exitCode = 1;
}

/**
 * 按缓存的 manifest 动态生成 fn 命令树:
 *   superun fn                  列出 tag 组
 *   superun fn <tag>            列出该组函数
 *   superun fn <tag> <函数>      调用(--data/--file/--no-validate;--help 看契约)
 */
export function buildFnCommands(fnCmd: Command, app: AppConfig): void {
  const tree = new FunctionsTree(app.dir);
  const groups = tree.listGroups();
  const fns = tree.listFunctions();

  const groupNames: string[] = [];
  for (const g of groups) groupNames.push(g.name);
  for (const f of fns) if (!groupNames.includes(f.group)) groupNames.push(f.group);

  for (const gname of groupNames) {
    const ginfo = groups.find((g) => g.name === gname);
    const grp = fnCmd.command(gname).description(ginfo?.description ?? `${gname} group`);
    grp.action(() => grp.help()); // `superun fn <tag>` 无函数名 → 列出该组函数

    for (const f of fns.filter((x) => x.group === gname)) {
      grp
        .command(leafName(f.name, gname))
        .description(`${f.verifyJwt ? "[jwt] " : ""}${f.summary}`)
        .option("--data <json>", "request body as a JSON string")
        .option("--file <path>", "read the request body JSON from a file")
        .option("--no-validate", "skip input schema validation")
        .addHelpText("after", () => contractHelp(tree, f.name))
        .action(async (opts) => {
          await callFunction(app, tree, f.name, opts);
        });
    }
  }

  fnCmd.action(() => fnCmd.help()); // `superun fn` 无 tag → 列出所有 tag 组
}
