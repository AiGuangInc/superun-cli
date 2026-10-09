---
name: superun-integration
description: Make a Supabase application "superun-ready" so its users can operate it through the superun CLI. Use when a developer wants their app to support superun — exposing Edge Functions to the CLI via an OpenAPI manifest, implementing the OAuth 2.1 consent page for browser login, or enabling the project's OAuth authorization server. Covers all three integration steps and their exact API contracts.
---

# Making a Supabase app superun-ready

superun lets users operate a Supabase backend from the command line as themselves.
To make an application support it, complete up to three independent steps. Do only
the ones the user needs:

| Step | Enables | Work |
|---|---|---|
| 1 | `superun fn` (Edge Functions) | Publish an OpenAPI manifest |
| 2 | `superun login --browser` (approval UI) | Implement a consent page |
| 3 | `superun login --browser` (the server itself) | Enable the OAuth server in auth config |

Steps 2 and 3 go together (browser login needs both). Step 1 is independent.

Work in the **application's own repository**, adapting file paths and framework
idioms to whatever the project uses (Next.js, Vite, Remix, plain static, etc.).

---

## Step 1 — Publish the OpenAPI manifest

Create a static **OpenAPI 3.1** document at `public/superun/openapi.json` (so it is
served at `https://<app>/superun/openapi.json`). The CLI compiles this into typed `fn`
commands.

Rules:
- One `path` per Edge Function, matching its route **under `/functions/v1/`** — the
  function at `/functions/v1/orders/create` is described by path `/orders/create`.
- Request/response bodies are **JSON Schema 2020-12**.
- `tags` define command groups (`tags: ["orders"]` → `superun fn orders <name>`);
  with no tag, the first path segment is used.
- A non-empty `security` block marks a function as requiring a logged-in user
  (`verifyJwt`); the CLI then attaches the user's bearer token.

Minimal operation:

```json
{
  "openapi": "3.1.0",
  "info": { "title": "My App API", "version": "1.0.0" },
  "paths": {
    "/orders/create": {
      "post": {
        "tags": ["orders"],
        "summary": "Create an order for the current user",
        "security": [{ "bearerAuth": [] }],
        "requestBody": { "required": true, "content": { "application/json": {
          "schema": { "type": "object", "required": ["sku", "qty"], "properties": {
            "sku": { "type": "string" }, "qty": { "type": "integer", "minimum": 1 } } } } } },
        "responses": { "200": { "description": "The created order", "content": {
          "application/json": { "schema": { "type": "object", "properties": {
            "id": { "type": "string" } } } } } } }
      }
    }
  }
}
```

Generate paths from the app's actual Edge Functions. Keep schemas honest — the CLI
validates user input against them.

---

## 生成项目业务 Skill

由执行本次接入任务的项目 Agent，在业务代码和 OpenAPI 确定后生成 `public/superun/SKILL.md`，并随项目部署。首次创建；每次更新接入能力都依据当前完整实现重新生成并覆盖同一路径，不因文件存在而跳过，不追加第二份文档。

阅读项目需求、页面调用、service、Edge Functions、RPC 和数据模型，先识别业务目标，再核对数据来源与实际状态流转，最后与开放接口对齐。不能只将接口列表转成 Markdown。

单份文档包含 name/description frontmatter，以及项目业务范围、数据含义和按用户目标组织的流程。每个流程写清前置条件、查询入口、对象 ID、方法与路径、返回字段到下一步参数的映射、状态限制、写入确认、完成判据与失败处理。可选参数的省略/null 语义和统计时间范围必须准确。没有开放接口的步骤明确不支持，不用直接改表替代。

正文只含外部操作所需业务知识，不包含源码路径、真实业务记录、凭据、调试备注或开发待办。旧正文仅作参考，已经失效的流程须移除。先生成校验完整新内容，再覆盖；失败保留旧文件并报告本次失败。

部署后读取 `/superun/SKILL.md` 并核对正文；写入源码但部署失败不能报告更新成功。`superun fn` 和 MCP `list_function_groups` 会实时返回这份正文，每次业务任务先读总览。不要新增文档索引、接口扩展或手动刷新步骤。

---

## Step 2 — Implement the consent page

`superun login --browser` drives the project's OAuth 2.1 server, which handles the
whole protocol and redirects the browser to:

```
<site_url><authorization_path>?authorization_id=<ID>
```

`authorization_path` is set in Step 3 (e.g. `/superun/consent`). Build a page at that
route that does three things. Every request carries **both** the `apikey` (anon key)
and the user's `Authorization: Bearer <access_token>` (from the app's normal login).

**1. Fetch details** — `GET /auth/v1/oauth/authorizations/<ID>`

The response has two shapes:

```jsonc
// (a) consent required — render an approval UI
{ "authorization_id":"…", "redirect_uri":"http://localhost:8976", "scope":"email",
  "client": { "id":"…", "name":"superun", "uri":"…", "logo_uri":"…" },
  "user":   { "id":"…", "email":"user@example.com" } }

// (b) already approved — DO NOT render anything; redirect now
{ "redirect_url": "http://localhost:8976?code=…&state=…" }
```

> ⚠️ **The most important rule.** If the response contains `redirect_url`, the
> authorization was auto-approved (the user consented to this client before).
> Navigate to it **immediately** and render nothing. If you show the approval screen
> anyway, the user submits consent for an authorization that is no longer pending and
> gets `400 validation_failed: authorization request cannot be processed`. Handle this
> branch first.

**2. Submit the decision** — `POST /auth/v1/oauth/authorizations/<ID>/consent`

```jsonc
{ "action": "approve" }                 // body (or "deny")
{ "redirect_url": "http://localhost:8976?code=…&state=…" }   // response
```

**3. Redirect** the browser to `redirect_url`. The CLI's loopback listener takes it
from there.

Reference flow (adapt to the app's framework and auth client):

```js
const id = new URLSearchParams(location.search).get("authorization_id");
const accessToken = await getCurrentUserAccessToken();  // app's existing login
const headers = { apikey: ANON_KEY, authorization: `Bearer ${accessToken}`,
                  "content-type": "application/json" };
const base = `${SUPABASE_URL}/auth/v1/oauth/authorizations/${id}`;

const details = await fetch(base, { headers }).then(r => r.json());
if (details.redirect_url) { location.href = details.redirect_url; return; } // auto-approved

const action = await askUserToApprove(details);            // "approve" | "deny"
const { redirect_url } = await fetch(`${base}/consent`, {
  method: "POST", headers, body: JSON.stringify({ action }) }).then(r => r.json());
location.href = redirect_url;
```

The page must require an authenticated user and must display the real `client`
details so the user can see exactly what they are authorizing.

---

## Step 3 — Enable the OAuth server (auth config)

Call the **`SupabaseAuthUpdateConfig`** tool with these keys:

| Key | Value | Purpose |
|---|---|---|
| `oauth_server_enabled` | `true` | Turn on the OAuth 2.1 authorization server |
| `oauth_server_allow_dynamic_registration` | `true` | Let the CLI self-register via DCR (see security note) |
| `oauth_server_authorization_path` | `/superun/consent` | Path of the Step 2 consent page |
| `site_url` | `https://<app>` | Base for the consent redirect and the `Origin` check |

The auth service (GoTrue) reads these **at boot**, so the auth deployment must be
restarted / reconfigured before they take effect. Tell the user this explicitly.

---

## Verify

```bash
superun init --name myapp --url https://<app> --anon-key <key> \
  --manifest https://<app>/superun/openapi.json
superun login --browser        # exercises Steps 2 & 3
superun fn                      # exercises Step 1
```

## Security

- Open Dynamic Client Registration lets anyone register a client with an arbitrary
  `redirect_uri`, widening the consent-phishing surface. For production, prefer to
  pre-register one client with its redirect URI locked to `http://localhost`, leave
  DCR disabled, and have users pass `--oauth-client-id <id>`.
- Never embed a service-role key in the consent page — the user's `access_token`
  authorizes the consent calls; the anon key is public by design.
