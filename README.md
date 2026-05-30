# superun

**A universal, configuration-driven CLI for any Supabase-compatible backend.**

Operate your Supabase project's PostgREST database and Edge Functions as the currently authenticated user — from any directory, across any number of projects. One binary; switch backends by configuration, not by reinstalling.

English · [简体中文](README.zh-CN.md)

![Node](https://img.shields.io/badge/node-%E2%89%A520-3c873a) ![License](https://img.shields.io/badge/license-Apache%202.0-blue)

> **Building an app that users will drive with superun?** The **[`superun-integration` skill](skills/superun-integration/SKILL.md)** walks an agent — or you — through making your backend CLI-ready.

## Features

- **Universal** — Works against any Supabase-compatible backend: hosted (`*.supabase.co`), self-hosted, or `localhost`.
- **Credentials are the only config** — Register a backend with just its URL and anon key; everything else is discovered at runtime.
- **Identity-aware** — Every request runs as the logged-in user. Row Level Security and `verifyJwt` Edge Functions are enforced exactly as in production.
- **Typed Edge Functions** — The backend publishes an OpenAPI 3.1 document; superun compiles it into a local cache and exposes each function as a first-class command with input/output schemas.
- **Multi-project** — Manage and switch between any number of projects; each keeps an isolated configuration, session, and function cache.
- **Browser login** — Sign in through your project's built-in Supabase OAuth 2.1 authorization server (Authorization Code + PKCE, with Dynamic Client Registration).
- **Shell completion** — Bash, Zsh, and Fish; completes commands, function tags, function names, and project aliases from the local cache, with no network calls.

## Installation

Requires Node.js ≥ 20.

```bash
npm install -g superun-cli
```

The `superun` binary is added to your `PATH` on macOS, Windows, and Linux.

## Quick Start

```bash
# 1. Register a backend (interactive, or pass flags directly)
superun init --name shop --url https://<project>.supabase.co --anon-key <anon-key>

# 2. Authenticate as a user
superun login --browser            # via the project's OAuth 2.1 server
# or: superun login --token <jwt>  # paste an existing access token

# 3. Use it from any directory
superun db tables                  # list tables & RPCs (live introspection)
superun db select <table> --eq id=1 --limit 10
superun fn                         # browse Edge Functions by tag
superun fn <tag> <name> --data '{...}'
```

## Commands

### Projects

```
superun init  --url <url> --anon-key <key> [--name <alias>]   Register a backend and make it active
superun app list                                              List registered projects (* = active)
superun app use <alias|id>                                    Switch the active project
superun app show                                              Show the active project's configuration
superun app set [--name|--url|--anon-key|--manifest <v>]      Update configuration fields
superun app refresh                                           Fetch & compile the backend's Edge Function manifest
superun app remove <alias|id>                                 Remove a project (and its cached session)
superun app where                                             Print the configuration directory in use
superun -a <alias|id> <command>                               Target a specific project for one command
```

### Authentication

```
superun login --browser                          Sign in via the project's OAuth 2.1 server (PKCE)
superun login --token <jwt> [--refresh <jwt>]    Use an existing access token
superun login --password --email <e> --pass <p>  Email & password (GoTrue)
superun whoami                                    Decode the current session's JWT claims
superun logout                                    Clear the local session
```

### Database (PostgREST)

```
superun db tables                                List exposed tables & RPCs
superun db select <table> [--eq col=val] [--limit n]
superun db insert <table> --data '<json>'        Insert rows (returns the inserted rows)
superun db update <table> --eq col=val --data '<json>'   (requires a filter unless --all)
superun db delete <table> --eq col=val                   (requires a filter unless --all)
superun db rpc <name> [--data '<json>']          Call a Postgres function
```

### Edge Functions

```
superun fn                                List function groups (by OpenAPI tag)
superun fn <tag>                          List functions within a group
superun fn <tag> <name> --data '<json>'   Invoke (add --help for the input/output contract)
```

## Authentication & Identity

The "current user" is the JWT held in the local session. PostgREST RLS and `verifyJwt: true` functions both validate it against the backend's `jwtSecret`, so the token must be issued by that instance — by GoTrue, or signed with the same secret. Tokens from a foreign auth system are rejected at runtime (`401`); only `verifyJwt: false` functions remain callable.

Sessions refresh automatically: when an access token is near expiry — or a request returns `401` — superun uses the stored refresh token to obtain a new one and persists it transparently.

### Browser login (OAuth 2.1)

`superun login --browser` uses the project's built-in OAuth 2.1 authorization server. The CLI implements the full flow: OIDC discovery, Dynamic Client Registration, Authorization Code + PKCE, and token exchange. To enable it, the backend (GoTrue) needs:

```
oauth_server_enabled = true
oauth_server_allow_dynamic_registration = true   # or pre-register a client (more secure)
oauth_server_authorization_path = /oauth/consent # consent page hosted on your site_url
```

Your application provides a single consent page, reusing its existing login; GoTrue handles the rest of the protocol. See `superun login --help` for the full integration contract.

> **Security** — Open Dynamic Client Registration widens the consent-phishing surface. For production, pre-register a client with its redirect URI locked to `http://localhost` and pass `--oauth-client-id`.

## How Edge Functions Work

superun treats the database and auth as fixed capabilities (standard Supabase, introspected live), and Edge Functions as per-project capabilities described by an OpenAPI document the backend hosts:

```
Backend hosts OpenAPI 3.1  (an Edge Function or static asset; default /functions/v1/_cli-manifest)
        │  superun app refresh  →  dereference + validate + reduce to a minimal set
        ▼
Local cache  (per project: index.json + <function>.json, schemas inlined)
        │  fn reads JSON only — no OpenAPI parsing on the hot path
        ▼
superun fn <tag> <name>
```

- Standard **OpenAPI 3.1** in, no custom DSL — inputs and outputs are JSON Schema 2020-12.
- **Grouping** follows OpenAPI `tags`; without tags, the first path segment is used (`/api/runtime-tick` → group `api`, command `runtime-tick`).
- `verifyJwt` is derived from a non-empty OpenAPI `security` block at compile time.
- The OpenAPI parser runs only during `app refresh`; the `fn` hot path just reads cached JSON.

### Progressive loading

The compiled cache is layered so that both humans and AI agents read only what they need:

| Layer | Reads | Command |
|---|---|---|
| L0 | groups | `superun fn` |
| L1 | function summaries | `superun fn <tag>` |
| L2 | a single function's inlined schema | `superun fn <tag> <name> --help` / invoke |

## Configuration

Resolution order: `APP_CLI_DIR` → `-a/--app` override → nearest `.app-cli/` directory → the global active project.

Configuration lives in the per-user config directory (Windows `%APPDATA%`, macOS/Linux `~/.config/superun`). Override the root with `SUPERUN_HOME`, or supply the anon key via `APP_CLI_ANON_KEY`.

## Use with an AI agent

superun ships two [Claude Code](https://claude.com/claude-code) skills, for the two sides of the tool:

- **[`superun`](skills/superun/SKILL.md)** — lets an agent *operate* a backend: introspect the schema, drill into Edge Functions level by level, and act under the user's identity with guard-rails around destructive writes.
- **[`superun-integration`](skills/superun-integration/SKILL.md)** — guides an agent *integrating an app*: publish the OpenAPI manifest, implement the consent page, and enable the OAuth server.

Install whichever you need by copying it into your skills directory:

```bash
cp -r skills/superun             ~/.claude/skills/   # to operate a backend
cp -r skills/superun-integration ~/.claude/skills/   # to make an app superun-ready
```

## Development

```bash
pnpm install
pnpm dev init --url https://x.supabase.co --anon-key <key> --name demo
pnpm dev app refresh --manifest fixtures/manifest.openapi.json   # sample backend OpenAPI
pnpm dev fn
pnpm build                                                       # emits dist/cli.js (bin: superun)
```

`fixtures/manifest.openapi.json` is a sample backend document (single file, multiple functions with tags). `app refresh --manifest` accepts a URL, a function name, or a local file, which is convenient for offline testing.

## Roadmap

- [x] Multi-project management; `app refresh` compiles the backend OpenAPI into the cache
- [x] `fn` tag-based navigation with input-schema validation and `verifyJwt` gating
- [x] Shell completion (Bash / Zsh / Fish)
- [x] `login --token / --password / --browser` (OAuth 2.1 + PKCE, DCR or pre-registered client), `whoami`, full `db` CRUD/RPC under RLS
- [x] Automatic session refresh
- [ ] `login` strategies `otp` (email code) and `custom` (app-specific endpoint)
- [ ] Reference backend manifest endpoint (`_cli-manifest`) for end-to-end `fn`

## License

Licensed under the [Apache License 2.0](LICENSE) © 2026 uxarts.

You may use, modify, and distribute this project freely, including for
**commercial** purposes. When you redistribute it or a derivative work, you must
retain the copyright notice and the [`LICENSE`](LICENSE) / [`NOTICE`](NOTICE)
files. The license does **not** grant any right to use the "uxarts" / "superun"
names, marks, or the author's reputation to endorse or promote your own product
(see Section 6 of the license). The software is provided "as is", without
warranty of any kind, and the author is not liable for any damages arising from
its use.
