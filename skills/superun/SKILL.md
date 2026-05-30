---
name: superun
description: Operate a Supabase backend — PostgREST database and Edge Functions — as the authenticated user, through the `superun` CLI. Use when the user wants to query, insert, update, or delete rows in their Supabase database; call an Edge Function; inspect tables or RPCs; or otherwise act against their registered Supabase app from the command line. Requires the `superun` CLI installed and a project registered.
---

# superun

`superun` is a CLI that operates any Supabase-compatible backend as the **currently
logged-in user**. Every database call runs under that user's Row Level Security, and
`verifyJwt` Edge Functions receive their token. Use it to drive a user's Supabase app
without writing HTTP requests by hand.

## Before acting — orient yourself

```bash
superun --version          # confirm it's installed
superun app list           # which projects are registered (* = active)
superun whoami --json       # current identity, or "Not logged in"
```

- No active project? The user must register one: `superun init --url <url> --anon-key <key> [--name <alias>]`.
- Not logged in? The user must authenticate: `superun login --browser` (or `--token <jwt>`). Do not attempt to fabricate tokens.
- Sessions refresh automatically. A `401` means the session is unrecoverable (expired refresh token, or a token from a foreign auth system) — tell the user to `superun login` again.

## Database (PostgREST)

Always start by discovering the schema; never guess table or column names.

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
superun app use <alias|id>        # change the active project for subsequent commands
```

A project can be referenced by either its alias or its id (`superun app list` shows both).

## Interpreting output

- `db` / `fn` commands print `HTTP <status>` followed by the JSON body. Parse the JSON
  for results; on a non-2xx status, surface the error body to the user rather than
  retrying blindly.
- `superun whoami --json` emits machine-readable identity claims.

## Don't

- Don't run `--all` writes, `app remove`, or `logout` without explicit user intent.
- Don't ask for or paste raw tokens/keys — the anon key and session are managed by superun.
- Don't invent table/column/function names; introspect first (`db tables`, `fn`).
