# agent-obsidian-mcp

Local MCP servers for the Agent-Obsidian workflow. One repo · one version tag · one GitHub Release; each Release attaches independently installable `.tgz` assets (built with `npm pack`).

| Package | Tool surface | Purpose |
|---|---|---|
| [`vault-workspace-mcp`](packages/vault-workspace-mcp/) | `vault_search` · `vault_read` · `vault_write` · `todo_query` · `todo_mark` | Agent file I/O behind a WRITE_ROOTS write wall, todo detection/marking. (v0.2: lock tools removed — duplicate detection belongs to the prepare gate.) |
| [`paper-fetch-mcp`](packages/paper-fetch-mcp/) | `paper_fulltext_fetch` | arXiv full text with LaTeX math (ar5iv HTML → pdftotext fallback). |

Both servers are **zero-dependency single files** (Node ≥ 18 built-ins only; `paper-fetch-mcp` additionally shells out to `pdftotext` for its PDF fallback).

## Deliberate boundaries

These servers are I/O capability layers only. Verdicts, scoring, state transitions, and completion belong to the workflow's gate core, which is implemented on the host — never here.

- **No delete tool exists.** Deletion is user-only in the workflow, so the surface is absent by construction.
- `vault_search` **requires a folder scope** — full-vault scans are not offered.
- `todo_mark` writes **only `[/]`** (agent-processing-finished). The final `[x]` is user-only.
- Paths are vault-relative; absolute paths, `..` traversal, and `.obsidian/` writes are rejected.
- `VAULT_PATH` env is **required** for `vault-workspace-mcp` — there is no fallback path.

## Develop

```bash
npm run smoke        # offline smoke suites for both servers
SMOKE_NETWORK=1 node tests/smoke-paper-fetch.mjs   # + one real arXiv fetch
npm run pack:all     # build dist/*.tgz release assets
npm run digest       # sha256 for the release manifest
```

## Release & install (consumed by the workflow's bootstrap)

Release assets are the `npm pack` tgz files plus their sha256 digests. The bootstrap installs a pinned asset — never a floating latest:

```bash
npm install --omit=dev --ignore-scripts <verified .tgz>
```

MCP registration example (any MCP host):

```yaml
vault-workspace:
  command: node
  args: [<install path>/node_modules/vault-workspace-mcp/server.mjs]
  env: { VAULT_PATH: /absolute/path/to/vault }
paper-fetch:
  command: node
  args: [<install path>/node_modules/paper-fetch-mcp/server.mjs]
```
