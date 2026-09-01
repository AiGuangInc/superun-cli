# superun

**面向任意 Supabase 兼容后端的通用 CLI。**

以当前登录用户的身份,在任意目录操作 Supabase 项目的 PostgREST 数据库与 Edge Functions;一套二进制管理任意多个项目,切换后端只需切换配置,无需重装。

[English](README.md) · 简体中文

![Node](https://img.shields.io/badge/node-%E2%89%A520-3c873a) ![License](https://img.shields.io/badge/license-Apache%202.0-blue)

> **要让你的应用支持 superun 接入?** **[`superun-integration` skill](skills/superun-integration/SKILL.md)**(英文)会带 agent —— 或你自己 —— 完成对接改造。

## 特性

- **通用** —— 适配任意 Supabase 兼容后端:托管(`*.supabase.co`)、自建、或 `localhost`。
- **凭据即全部配置** —— 注册后端只需 URL 与 anon key,其余能力运行时从后端发现。
- **身份感知** —— 每个请求都以登录用户身份发出;Row Level Security 与 `verifyJwt` Edge Function 的鉴权与生产环境完全一致。
- **类型化 Edge Functions** —— 后端发布 OpenAPI 3.1 文档,superun 将其编译为本地缓存,把每个函数暴露为带输入/输出 schema 的一等命令。
- **多项目** —— 管理并切换任意多个项目,各自的配置、会话与函数缓存相互隔离。
- **生产/debug 双环境** —— 同一项目可额外配置 debug Supabase URL 与 anon key；配置完整后默认走 debug，也可按命令临时切回 production。两套会话与运行时缓存完全隔离。
- **浏览器登录** —— 通过项目内置的 Supabase OAuth 2.1 授权服务器登录(授权码 + PKCE,支持动态客户端注册)。
- **WorkBuddy 本地 MCP** —— 一次配置 stdio 命令,之后即可通过对话查询和操作指定项目,并复用 CLI 已有的登录、RLS、能力发现与参数校验。
- **Shell 补全** —— 支持 Bash / Zsh / Fish,从本地缓存补全命令、函数标签、函数名与项目别名,全程不触网。

## 安装

需要 Node.js ≥ 20。

```bash
npm install -g superun-cli
```

`superun` 命令会自动加入 `PATH`(macOS / Windows / Linux 一致)。

## 快速开始

```bash
# 1. 注册后端(交互式,或直接传参)
superun init --name shop --url https://<project>.supabase.co --anon-key <anon-key>

# 项目有独立 debug Supabase 时（配置后默认走 debug）
superun init --name shop --url https://<production> --anon-key <production-key> \
  --debug-url https://<debug> --debug-anon-key <debug-key>

# 2. 以用户身份登录
superun login --browser            # 通过项目的 OAuth 2.1 服务器
# 或:superun login --token <jwt>   # 粘贴已有的 access token

# 3. 在任意目录使用
superun db tables                  # 列出表与 RPC(实时自省)
superun db select <table> --eq id=1 --limit 10
superun fn                         # 按标签浏览 Edge Functions
superun fn <tag> <name> --data '{...}'
```

## 命令

### 项目管理

```
superun init  --url <url> --anon-key <key> [--debug-url <url> --debug-anon-key <key>]   注册后端并设为活跃
superun app list                                             列出已注册项目(* 为活跃)
superun app use <别名|id>                                    切换活跃项目
superun app show                                             查看活跃项目配置
superun app set [--name|--url|--anon-key|--debug-url|--debug-anon-key|--environment <值>] 更新配置字段
superun app refresh                                          拉取并编译后端的 Edge Function manifest
superun app remove <别名|id>                                 删除项目(连同其会话缓存)
superun app where                                            打印当前使用的配置目录
superun -a <别名|id> <命令>                                  本次命令临时指向指定项目
superun -e <debug|production> <命令>                          本次命令临时指定环境
```

### 认证

```
superun login --browser                          通过项目 OAuth 2.1 服务器登录(PKCE)
superun login --token <jwt> [--refresh <jwt>]    使用已有 access token
superun login --password --email <e> --pass <p>  邮箱与密码(GoTrue)
superun whoami                                    解码当前会话的 JWT claims
superun logout                                    清除本地会话
```

### 数据库(PostgREST)

```
superun db tables                                列出暴露的表与 RPC
superun db select <table> [--eq col=val] [--limit n]
superun db insert <table> --data '<json>'        插入(返回插入的行)
superun db update <table> --eq col=val --data '<json>'   (默认需过滤条件,全表更新加 --all)
superun db delete <table> --eq col=val                   (默认需过滤条件,全表删除加 --all)
superun db rpc <name> [--data '<json>']          调用 Postgres 函数
```

### Edge Functions

```
superun fn                                列出函数分组(按 OpenAPI 标签)
superun fn <tag>                          列出分组内的函数
superun fn <tag> <name> --data '<json>'   调用(--help 查看输入/输出契约)
```

### 在 WorkBuddy 中使用 MCP

MCP 只需在 WorkBuddy 中配置一次,不是每次对话都粘贴一段指令。完成 `init` 和 `login` 后,在 WorkBuddy 的 MCP 设置中新增一个本地 **stdio** 服务。如果宿主支持 JSON 配置,可填写:

```json
{
  "mcpServers": {
    "superun-shop": {
      "type": "stdio",
      "command": "superun",
      "args": ["--app", "shop", "--env", "production", "mcp"]
    }
  }
}
```

`--app` 既可以直接使用 `init --name` 时填写的别名(如 `shop`),也可以使用生成的项目 id。保留 `--env production` 可将 WorkBuddy 固定连到生产环境;若要使用项目单独配置的 debug 环境,则改为 `--env debug`。如果 WorkBuddy 找不到全局安装的命令,请把 `command` 换成 `which superun`(macOS/Linux)或 `where superun`(Windows)返回的绝对路径。重启或重新连接 MCP 服务后,就可以在对话里说“列出 shop 项目的表”或“介绍一下订单相关函数”。

服务固定暴露 7 个工具:`project_status`、`list_tables`、`query_rows`、`list_function_groups`、`list_functions`、`describe_function`、`call_function`。数据库能力刻意限制为只读(`GET`、单次最多 200 行),不提供原始增删改或 RPC 工具。每个结果最多 1 MiB,超限时需缩小 `columns` 或 `limit`。`call_function` 会按发布的输入 schema 校验,并强制要求 `userConfirmed: true`;MCP 宿主只有在用户已于当前对话明确确认“这个具体函数 + 这份具体 input”后才可以设置该字段。

对应的服务启动命令是:

```bash
superun --app shop --env production mcp
```

该命令的 stdout 只用于 MCP 协议,诊断信息写入 stderr。

## 认证与身份

“当前用户”即本地会话持有的 JWT。PostgREST 的 RLS 与 `verifyJwt: true` 的函数都使用后端的 `jwtSecret` 验签,因此 token 必须由该实例签发 —— 由 GoTrue 签发,或用相同 secret 签出。来自其他鉴权体系的 token 会在运行时被拒(`401`),此时仅能调用 `verifyJwt: false` 的函数。

会话自动续期:当 access token 临近过期、或请求返回 `401` 时,superun 会用存储的 refresh token 换取新 token 并透明持久化。

### 浏览器登录(OAuth 2.1)

`superun login --browser` 使用项目内置的 OAuth 2.1 授权服务器。CLI 已实现完整流程:OIDC discovery、动态客户端注册(DCR)、授权码 + PKCE、token 交换。启用需后端(GoTrue):

```
oauth_server_enabled = true
oauth_server_allow_dynamic_registration = true   # 或预注册客户端(更安全)
oauth_server_authorization_path = /oauth/consent # 部署在 site_url 上的同意页
```

你的应用只需提供一个同意页,复用其现有登录;OAuth 协议其余部分由 GoTrue 负责。完整集成契约见 `superun login --help`。

> **安全** —— 开放动态客户端注册会扩大“同意钓鱼”面。生产环境建议预注册客户端、将 redirect URI 锁定为 `http://localhost`,并通过 `--oauth-client-id` 指定。

## Edge Functions 工作原理

superun 将数据库与认证视为固定能力(标准 Supabase,实时自省),将 Edge Functions 视为按项目而异的能力,由后端托管的 OpenAPI 文档描述:

```
后端托管 OpenAPI 3.1  (Edge Function 或静态资源;默认 /functions/v1/_cli-manifest)
        │  superun app refresh  →  解引用 + 校验 + 降解为最小集
        ▼
本地缓存  (每项目:index.json + <函数>.json,schema 已内联)
        │  fn 仅读取 JSON,热路径不解析 OpenAPI
        ▼
superun fn <tag> <name>
```

- 输入为标准 **OpenAPI 3.1**,无自造 DSL —— 输入/输出即 JSON Schema 2020-12。
- **分组**遵循 OpenAPI `tags`;无标签时取路径首段(`/api/runtime-tick` → 分组 `api`,命令 `runtime-tick`)。
- 函数路径会保留原始大小写,也可使用普通点号,但必须是可跨平台的安全相对路径;路径穿越、URL 路径保留字符、Windows 非法或保留名称、顶层 `index` 名称及大小写不敏感的缓存冲突会在生成缓存前被拒绝。
- `verifyJwt` 在编译期由非空的 OpenAPI `security` 块推导得出。
- OpenAPI 解析器仅在 `app refresh` 时运行;`fn` 热路径只读取缓存 JSON。

### 渐进式加载

编译后的缓存分层组织,人与 AI agent 都只读取所需部分:

| 层级 | 读取内容 | 命令 |
|---|---|---|
| L0 | 分组 | `superun fn` |
| L1 | 函数摘要 | `superun fn <tag>` |
| L2 | 单个函数的内联 schema | `superun fn <tag> <name> --help` / 调用 |

## 配置

解析顺序:`APP_CLI_DIR` → `-a/--app` 覆盖 → 就近的 `.app-cli/` 目录 → 全局活跃项目。

配置存于用户级配置目录(Windows `%APPDATA%`,macOS/Linux `~/.config/superun`)。生产环境使用 `url` / `anonKey`；debug 环境额外使用 `debugUrl` / `debugAnonKey`。debug 两项都存在时默认走 debug；可用 `app set --environment production|debug` 修改项目默认值，或用全局 `-e/--env` 只覆盖当前命令。生产与 debug 的登录会话、OAuth 客户端、PostgREST schema 和 Edge Function 缓存相互隔离。

可用 `SUPERUN_HOME` 覆盖配置根目录。凭据也可分别通过 `APP_CLI_ANON_KEY`、`APP_CLI_DEBUG_URL`、`APP_CLI_DEBUG_ANON_KEY` 提供，并可用 `APP_CLI_ENVIRONMENT` 选择环境。

## 配合 AI agent 使用

superun 自带两个 [Claude Code](https://claude.com/claude-code) skill,对应工具的两端:

- **[`superun`](skills/superun/SKILL.md)** —— 让 agent *操作*后端:自省 schema、逐级钻取 Edge Functions、以用户身份行事,并对破坏性写入设有护栏。
- **[`superun-integration`](skills/superun-integration/SKILL.md)** —— 指导 agent *改造应用接入*:发布 OpenAPI manifest、实现 consent 页、开启 OAuth server。

按需把对应 skill 拷进你的 skills 目录即可启用:

```bash
cp -r skills/superun             ~/.claude/skills/   # 操作后端
cp -r skills/superun-integration ~/.claude/skills/   # 让应用支持 superun 接入
```

## 开发

```bash
pnpm install
pnpm dev init --url https://x.supabase.co --anon-key <key> --name demo
pnpm dev app refresh --manifest fixtures/manifest.openapi.json   # 样例后端 OpenAPI
pnpm dev fn
pnpm build                                                       # 产出 dist/cli.js(bin: superun)
pnpm test                                                        # 协议与 stdio MCP 测试
```

`fixtures/manifest.openapi.json` 是一份样例后端文档(单文件、多函数 + 标签)。`app refresh --manifest` 接受 URL、函数名或本地文件,便于离线自测。

## 路线图

- [x] 多项目管理;`app refresh` 将后端 OpenAPI 编译进缓存
- [x] `fn` 按标签导航,输入 schema 校验与 `verifyJwt` 门禁
- [x] Shell 补全(Bash / Zsh / Fish)
- [x] `login --token / --password / --browser`(OAuth 2.1 + PKCE,DCR 或预注册客户端)、`whoami`、完整 `db` 增删改查/RPC(RLS 生效)
- [x] 会话自动续期
- [x] 面向 WorkBuddy 等 MCP 宿主的本地 stdio 服务(受限只读工具 + 参数校验后的业务函数)
- [ ] `login` 策略 `otp`(邮箱验证码)与 `custom`(应用自有端点)
- [ ] 参考后端 manifest 端点(`_cli-manifest`)以打通端到端 `fn`

## 许可证

基于 [Apache License 2.0](LICENSE) 授权 © 2026 uxarts。

你可以自由地使用、修改和分发本项目,**包括用于商业用途**。当你再分发本项目或其衍生作品时,必须保留版权声明以及 [`LICENSE`](LICENSE) / [`NOTICE`](NOTICE) 文件。本授权**不**授予使用 “uxarts” / “superun” 名称、标识,或借作者名声为你自己的产品做背书、打广告的任何权利(详见协议第 6 条)。本软件按“现状”提供,不附带任何担保,作者对使用本软件产生的任何损失不承担责任。
