# vault-workspace-mcp

Zero-dependency stdio MCP server for agent work in an Obsidian vault.

**Tools**

| Tool | What it does |
|---|---|
| `vault_search(folder, query?, name_pattern?, limit?)` | Folder scope **required** — full-vault scans are not offered |
| `vault_read(file, offset?, limit?)` | Paged read under `READ_ROOTS`, excluding `READ_DENIES` |
| `vault_write(file, content, mode?)` | Scoped create or atomic replace; absent without a write scope |
| `vault_delete(path, recursive?)` | Exact/rooted delete; absent without a delete scope |
| `todo_query(folder?, limit?)` | Only open exact-selector Todos; returns source fingerprint, and withholds indistinguishable duplicates as `ambiguous` |
| `todo_transition(...)` | Gate-only conditional waiting/success/failure transition; absent unless enabled |

**Config (env)**

| Var | Required | Meaning |
|---|---|---|
| `VAULT_PATH` | ✅ | Absolute path to the vault root |
| `READ_ROOTS` | — | Read roots; default `.` |
| `READ_DENIES` | — | Denied paths; defaults to Vault control, trash, agent config, and all `.git` paths |
| `WRITE_ROOTS` / `WRITE_PATHS` | — | Rooted or exact write scope; no scope ⇒ no `vault_write` |
| `DELETE_ROOTS` / `DELETE_PATHS` | — | Rooted or exact delete scope; no scope ⇒ no `vault_delete` |
| `TODO_SELECTOR` | — | Exact same-line tag token; default `#agent/todo` |
| `TODO_MARKS` | ✅ | `waiting=~,succeeded=/,failed=!` form; values must be distinct |
| `TODO_WRITE` | — | `1` exposes Gate-only `todo_transition` |

Host adapters should start separate instances with the minimum tool surface. A Worker instance normally receives exact `READ_ROOTS`/`WRITE_PATHS`; only the Gate instance receives `TODO_WRITE=1` or finalization targets.

## Boundaries by design

- **Reads are walled too.** Direct reads and recursive search both enforce `READ_DENIES`; a caller cannot bypass a denied folder by naming a file directly.
- **Exact assignment paths are supported.** `WRITE_PATHS` and `DELETE_PATHS` avoid widening a Worker or one-shot Gate operation to a whole folder.
- **Todo selection is fixed by configuration.** Callers cannot disable the selector or request non-open states. Partial tag matches and fenced examples are excluded.
- **Todo effects are conditional and atomic.** `todo_transition` re-finds exactly one source fingerprint, fails closed on user edits, and writes the mark plus question/work or result record in one replacement. `[x]` remains user-owned.
- **A todo the server cannot identify is never handed out.** Identical todo lines in one file share a fingerprint. `todo_query` keeps them out of `rows` and reports them under `ambiguous`, so a dispatcher never starts work whose source could not be closed — the alternative is discovering the conflict at finalize time, after the run.
- **`todo_transition` is walled by the read scope, not the write scope.** A user's todo is a user's todo wherever it sits, so this tool reaches any file under `READ_ROOTS` — `WRITE_ROOTS`/`WRITE_PATHS` do not narrow it. What it may change there is narrow instead: one checkbox character plus that todo's own indented record. Give `TODO_WRITE=1` to the Gate instance only.
- **Walls use real paths.** Absolute paths, traversal, denied paths, and symlink escape are rejected. Root deletion and symlink deletion are refused.
- `.obsidian/` is not a work area.
- Scoring and gate logic are intentionally absent — this is an I/O capability layer for a gated workflow. Verdicts and state transitions belong to the gate core.

## History

- **v0.4.1** — indistinguishable duplicate todos withheld from `rows` as `ambiguous`; `todo_transition` names which conflict it hit; the read-scope wall on `todo_transition` documented.
- **v0.4** — read roots/denies, exact assignment paths, optional mutation surfaces, atomic replacement, exact Todo selector, source fingerprints, and Gate-only semantic transitions.
- **v0.3** — `vault_delete` + `DELETE_ROOTS`; `MARK_VALUES` (one mark per outcome) replaces the hard-coded `/`; symlink escape closed for write and delete; `todo_mark` refuses fenced and already-`[x]` lines.
- **v0.2** — `workspace_lock_*` removed (duplicate detection is the prepare gate's job, not a mutex); `WRITE_ROOTS` wall moved into the server, out of hooks.
