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
