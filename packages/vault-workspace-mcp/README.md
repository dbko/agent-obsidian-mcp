# vault-workspace-mcp

Zero-dependency stdio MCP server for agent work in an Obsidian vault.

**Tools**: `vault_search` (folder scope required) · `vault_read` · `vault_write` (create/overwrite/append, no delete — **walled by `WRITE_ROOTS`**: comma-separated vault-relative roots, required env since v0.2) · `todo_query` (precise checkbox-line search, fenced code skipped, returns `file`·`line`) · `todo_mark` (sets `[/]` only, idempotent — intended for gate bindings; not walled).

v0.2: `workspace_lock_*` removed — duplicate detection is the prepare gate's job (unfinished-contract check), not a mutex.

**Config**: `VAULT_PATH` env (required, absolute path to the vault root).

**Run**: `VAULT_PATH=/path/to/vault node server.mjs` — speaks line-delimited JSON-RPC (MCP) on stdio.

Boundaries by design: no delete surface, no full-vault search, no `[x]` writing, no `.obsidian/` writes, vault-relative paths only. Scoring/gate logic is intentionally absent — this is an I/O capability layer for a gated workflow.
