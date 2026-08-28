---
name: superun
description: Operate a registered Supabase backend's production or debug target through the `superun` CLI. Use when the user wants to inspect tables or RPCs, query or mutate rows, call an Edge Function, select an environment, or otherwise act against their registered app. Requests use the selected target's logged-in session when present and its anon role otherwise. Requires the `superun` CLI installed and a project registered.
---

# superun

`superun` is a CLI that operates any Supabase-compatible backend. Requests use the
selected production/debug target's logged-in user session when one exists; otherwise
they run as that target's anon role. Row Level Security still applies, and `verifyJwt`
Edge Functions receive the user token only when logged in. Use it instead of writing
HTTP requests by hand.

## Before acting — orient yourself

```bash
superun --version          # confirm it's installed
superun app list           # which projects are registered (* = active)
superun app show           # confirm the selected production/debug target and URL
superun whoami --json       # current identity, or "Not logged in"
```

- No active project? Register one with `superun init --url <url> --anon-key <key> [--debug-url <url> --debug-anon-key <key>] [--name <alias>]`.
- To add debug to an existing project, use `superun app set --debug-url <url> --debug-anon-key <key>`. Supplying the complete pair makes debug the project default.
- Not logged in? Public/anon operations may still work. For user-scoped data or `verifyJwt` functions, authenticate with `superun login --browser` (or `--token <jwt>`). Never fabricate a token.
- Sessions refresh automatically. A `401` means the session is unrecoverable (expired refresh token, or a token from a foreign auth system) — tell the user to `superun login` again.
- If a project has a complete debug target, superun uses debug by default. Use `-e production` only when the user explicitly wants to inspect or operate production. Each target has its own login session, OAuth client, PostgREST schema cache, and Edge Function cache.

## Prefer Edge Functions over raw DB writes

When a task can be done through an Edge Function (`superun fn`), **prefer that over a
direct `db insert/update/delete`.** Functions are the app's intended entry point: they
encapsulate business logic — input validation, computed/derived columns, multi-table
consistency, and side effects (sending mail, firing webhooks, writing audit rows) — plus
invariants that Row Level Security alone does not enforce. Writing rows directly bypasses
all of that and can leave data in a state the application considers invalid, even though
RLS permitted the write.

So before reaching for a `db` write:

1. Discover the available functions (`superun fn`) and check whether one covers the task.
2. If a function exists, use it — read its `--help` contract, then invoke it.
3. Use `db` writes only for operations **no function covers**, and say so to the user
   before mutating (this is ad-hoc, unguarded data manipulation).

`db` reads (`select`, `tables`, `rpc` for read-only functions) are fine for inspection
and queries at any time — this preference is about **mutations**.

## Database (PostgREST)

Use this to **read and inspect** data freely; for **writes**, first see
[Prefer Edge Functions over raw DB writes](#prefer-edge-functions-over-raw-db-writes)
above. Always start by discovering the schema; never guess table or column names.

```bash
superun db tables                                   # list exposed tables & RPCs (live introspection)
superun db select <table> --eq col=val --limit 10   # read (repeat --eq for multiple filters)
superun db insert <table> --data '{"col":"val"}'    # returns the inserted rows
superun db update <table> --eq id=1 --data '{...}'   # requires a filter
superun db delete <table> --eq id=1                  # requires a filter
superun db rpc <name> --data '{...}'                 # call a Postgres function
```

**Safety:** `update` and `delete` require at least one `--eq` filter by default.
Whole-table writes need `--all` — treat that as destructive and **never run it
without explicit user confirmation**.

## Edge Functions — drill down, don't dump

Function commands are generated from the backend's OpenAPI document. Discover them
in three levels and read only what you need:

```bash
superun fn                              # 1. list groups (OpenAPI tags)
superun fn <tag>                        # 2. list functions in a group
superun fn <tag> <name> --help          # 3. read THIS function's input/output schema
superun fn <tag> <name> --data '{...}'  #    invoke it (input validated against the schema)
```

This layering exists so an agent navigates to the single function it needs and reads
that one contract — rather than loading every function's schema up front. Always read
`--help` for the contract before invoking an unfamiliar function. Add `--no-validate`
only if the user explicitly wants to bypass input-schema checks.

## Targeting and switching projects

```bash
superun -a <alias|id> <command>   # run one command against a specific project
superun -e debug <command>        # override the environment for one command
superun app use <alias|id>        # change the active project for subsequent commands
superun app set --environment debug|production  # change the project's default target
```

A project can be referenced by either its alias or its id (`superun app list` shows both).
Keep the same `-a` and `-e` target throughout a multi-command workflow, including
`login`, `whoami`, discovery, the action itself, and cleanup. Run `app show` before a
mutation when the target is not already obvious. Never assume a production session or
cached schema applies to debug, or vice versa.

## Interpreting output

- `db` / `fn` commands print `HTTP <status>` followed by the JSON body. Parse both. On
  a non-2xx status, surface the error body rather than retrying blindly.
- A mutation's HTTP status alone is not proof that data changed. In particular,
  `UPDATE` / `DELETE` may return `HTTP 200` with `[]` when RLS or grants make zero rows
  visible or writable. Require returned rows and, when correctness matters, re-select
  using the same precise filter. Verify temporary test data is actually gone.
- `superun whoami --json` emits the selected environment plus machine-readable identity
  claims. `Not logged in` means subsequent requests use the anon role.

## Don't

- Don't reach for a `db` write when an Edge Function covers the task — prefer `fn` (see above).
- Don't run `--all` writes, `app remove`, or `logout` without explicit user intent.
- Don't ask for or paste raw tokens/keys — the anon key and session are managed by superun.
- Don't invent table/column/function names; introspect first (`db tables`, `fn`).
