# vault-workspace-mcp

Zero-dependency stdio MCP server for agent work in an Obsidian vault.

**Tools**

| Tool | What it does |
|---|---|
| `vault_search(folder, query?, name_pattern?, limit?)` | Folder scope **required** — full-vault scans are not offered |
| `vault_read(file, offset?, limit?)` | Paged read |
| `vault_write(file, content, mode?)` | create / overwrite / append — walled by `WRITE_ROOTS` |
| `vault_delete(path, recursive?)` | Cleanup — walled by `DELETE_ROOTS`, **absent** when unconfigured |
| `todo_query(folder?, tag?, status?, limit?)` | Precise checkbox-line search; fenced blocks skipped; returns `file`·`line`·`mark` |
| `todo_mark(file, line, mark?)` | Sets one of `MARK_VALUES`; idempotent |

**Config (env)**

| Var | Required | Meaning |
|---|---|---|
| `VAULT_PATH` | ✅ | Absolute path to the vault root |
| `WRITE_ROOTS` | ✅ | Comma-separated vault-relative write surface (`*` disables the wall — tests only) |
| `MARK_VALUES` | ✅ | Comma-separated checkbox chars, one per outcome (e.g. `/,!`) |
| `DELETE_ROOTS` | — | Delete surface. Unset ⇒ `vault_delete` is not registered at all |

**Run**: `VAULT_PATH=/path/to/vault WRITE_ROOTS=fleeting,work MARK_VALUES=/,! node server.mjs` — speaks line-delimited JSON-RPC (MCP) on stdio.

## Boundaries by design

- **Delete is walled separately from write.** The gates need cleanup — removing a write probe, a half-made work folder (left behind, it blocks its source as a duplicate forever), a failed artifact — but a write surface is not automatically a delete surface. A delete root itself cannot be deleted, folders need `recursive: true`, and an absent target returns `ok` with `unchanged: true`.
- **`[x]` and `[ ]` are the user's.** `todo_mark` writes only the configured `MARK_VALUES`; the final confirmation and the re-open are refused unconditionally, not by config, and an already-`[x]` line is never overwritten. `MARK_VALUES` is required — a silent default would let a deployment close both outcomes with the same mark and never notice.
- **Marks configure the trigger query too.** `status:"open"` never returns a todo this deployment has already marked — otherwise the same todo is re-discovered forever.
- **Fenced blocks are not triggers.** Both `todo_query` and `todo_mark` skip them: example todos in policy notes are examples.
- **Walls are checked on real paths.** Vault-relative only; absolute paths and `..` are rejected; the resolved path must stay inside the vault, so a symlink cannot tunnel a write or a delete out of a root. `vault_delete` refuses symlinks outright.
- `.obsidian/` is not a work area.
- Scoring and gate logic are intentionally absent — this is an I/O capability layer for a gated workflow. Verdicts and state transitions belong to the gate core.

## History

- **v0.3** — `vault_delete` + `DELETE_ROOTS`; `MARK_VALUES` (one mark per outcome) replaces the hard-coded `/`; symlink escape closed for write and delete; `todo_mark` refuses fenced and already-`[x]` lines.
- **v0.2** — `workspace_lock_*` removed (duplicate detection is the prepare gate's job, not a mutex); `WRITE_ROOTS` wall moved into the server, out of hooks.
