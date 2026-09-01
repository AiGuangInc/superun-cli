import type { Command } from "commander";
import { FunctionsTree } from "../config/functions.js";
import { listAppMetas, loadApp, resolveRef, setActiveOverride, setEnvironmentOverride } from "../config/app.js";
import { listRpcs, listTables, readCachedSpec } from "../discovery/pgrest.js";

const TOP = ["init", "login", "logout", "whoami", "db", "fn", "mcp", "app"];
const APP_SUB = ["list", "use", "remove", "show", "set", "where", "refresh"];

/** 补全后端收到的是上下文词，先应用其中的全局目标覆盖。 */
function applyGlobalOverrides(tokens: string[]): void {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if ((token === "-a" || token === "--app") && tokens[i + 1]) {
      const ref = tokens[++i];
      setActiveOverride(resolveRef(ref) ?? ref);
      continue;
    }
    if (token.startsWith("--app=")) {
      const ref = token.slice("--app=".length);
      if (ref) setActiveOverride(resolveRef(ref) ?? ref);
      continue;
    }
    if ((token === "-e" || token === "--env") && tokens[i + 1]) {
      setEnvironmentOverride(tokens[++i]);
      continue;
    }
    if (token.startsWith("--env=")) {
      const environment = token.slice("--env=".length);
      if (environment) setEnvironmentOverride(environment);
    }
  }
}

/** 去掉全局 app / environment 选项，得到“命令位”序列。 */
function stripGlobals(tokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "-a" || t === "--app" || t === "-e" || t === "--env") {
      i++;
      continue;
    }
    if (t.startsWith("--app=") || t.startsWith("--env=")) continue;
    out.push(t);
  }
  return out;
}

/**
 * 给定“已完成的上下文词”(不含正在输入的那个),返回该位置的候选全集。
 * 前缀过滤交给 shell(compadd / compgen / fish 自带)。
 */
function candidatesFor(contextRaw: string[]): string[] {
  const ctx = stripGlobals(contextRaw);
  if (ctx.length === 0) return TOP; // 补顶层命令
  const cmd = ctx[0];

  if (cmd === "app") {
    if (ctx.length === 1) return APP_SUB;
    // app use / remove <ref> → 补 app 名字/id
    if (ctx.length === 2 && (ctx[1] === "use" || ctx[1] === "remove" || ctx[1] === "rm")) {
      const out = new Set<string>();
      for (const m of listAppMetas()) {
        if (m.name) out.add(m.name);
        out.add(m.id);
      }
      return [...out];
    }
    return [];
  }

  if (cmd === "fn") {
    try {
      const tree = new FunctionsTree(loadApp().runtimeDir);
      if (ctx.length === 1) {
        // 补 tag
        const groups = tree.listGroups().map((g) => g.name);
        for (const f of tree.listFunctions()) if (!groups.includes(f.group)) groups.push(f.group);
        return groups;
      }
      if (ctx.length === 2) {
        // 补该 tag 下的函数
        const g = ctx[1];
        return tree.listFunctions(g).map((f) => (f.name.startsWith(g + "/") ? f.name.slice(g.length + 1) : f.name));
      }
    } catch {
      return [];
    }
  }
  if (cmd === "db") {
    if (ctx.length === 1) return ["tables", "select", "insert", "update", "delete", "rpc"];
    if (ctx.length === 2) {
      try {
        const app = loadApp();
        const spec = readCachedSpec(app.scopeId);
        if (!spec) return [];
        if (ctx[1] === "rpc") return listRpcs(spec);
        if (["select", "insert", "update", "delete"].includes(ctx[1])) return listTables(spec);
      } catch {
        return [];
      }
    }
    return [];
  }
  return [];
}

/** `superun __complete <已完成的上下文词...>`:输出候选,一行一个。 */
export function runComplete(context: string[]): void {
  try {
    applyGlobalOverrides(context);
    for (const c of candidatesFor(context)) console.log(c);
  } catch {
    /* 补全永不报错 */
  }
}

function script(shell: string): string {
  if (shell === "bash") {
    return `# superun bash completion -- add to ~/.bashrc:  source <(superun completion bash)
_superun_complete() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  local ctx=("\${COMP_WORDS[@]:1:COMP_CWORD-1}")
  local cands
  cands="$(superun __complete "\${ctx[@]}")"
  COMPREPLY=( $(compgen -W "\${cands}" -- "\${cur}") )
}
complete -F _superun_complete superun`;
  }
  if (shell === "zsh") {
    // 双模式:可 source(走 else 分支 compdef 注册),也可放进 fpath 当 _superun 自动加载(走 if 分支)。
    return `#compdef superun
# superun zsh completion. See the README for installation:
#   Recommended:  superun completion zsh > ~/.zfunc/_superun   (and before compinit: fpath=(~/.zfunc $fpath))
#   Quick:        append to ~/.zshrc:  source <(superun completion zsh)
_superun() {
  local -a c
  c=(\${(f)"$(superun __complete \${words[2,$((CURRENT-1))]})"})
  compadd -- $c
}
if [ "$funcstack[1]" = "_superun" ]; then
  _superun
else
  compdef _superun superun
fi`;
  }
  if (shell === "fish") {
    return `# superun fish completion -- superun completion fish > ~/.config/fish/completions/superun.fish
complete -c superun -f -a "(superun __complete (commandline -opc)[2..-1])"`;
  }
  throw new Error(`Unsupported shell: ${shell} (supported: bash / zsh / fish)`);
}

export function registerCompletion(program: Command): void {
  program
    .command("completion <shell>", { hidden: true })
    .description("print the shell completion script (bash / zsh / fish): completes commands, tags, function names, and apps")
    .action((shell: string) => {
      console.log(script(shell));
    });

  // 隐藏后端:由补全脚本调用,读本地缓存出候选,不触网
  program
    .command("__complete [context...]", { hidden: true })
    .action((context: string[] = []) => {
      runComplete(context);
    });
}
