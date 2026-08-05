# agent-obsidian-mcp

Local MCP servers for the Agent-Obsidian workflow. One repo · one version tag · one GitHub Release; each Release attaches independently installable `.tgz` assets (built with `npm pack`).

| Package | Tool surface | Purpose |
|---|---|---|
| [`vault-workspace-mcp`](packages/vault-workspace-mcp/) | `vault_search` · `vault_read` · `vault_write` · `vault_delete` · `todo_query` · `todo_mark` | Agent file I/O behind a WRITE_ROOTS write wall, a separate DELETE_ROOTS cleanup wall, and todo detection/marking. |
| [`paper-fetch-mcp`](packages/paper-fetch-mcp/) | `paper_fulltext_fetch` | arXiv full text with LaTeX math (ar5iv HTML → pdftotext fallback). |

Both servers are **zero-dependency single files** (Node ≥ 18 built-ins only; `paper-fetch-mcp` additionally shells out to `pdftotext` for its PDF fallback).

## Deliberate boundaries

These servers are I/O capability layers only. Verdicts, scoring, state transitions, and completion belong to the workflow's gate core, which is implemented on the host — never here.

- **Deleting is walled separately from writing** (v0.3). The gates need cleanup — a write probe, a half-made work folder, a failed artifact — but a write surface is not automatically a delete surface, and without `DELETE_ROOTS` the tool is not registered at all.
- `vault_search` **requires a folder scope** — full-vault scans are not offered.
- `todo_mark` writes only the configured `MARK_VALUES` (one per outcome). The final `[x]` and the re-opening `[ ]` are user-only and refused unconditionally.
- Paths are vault-relative; absolute paths, `..` traversal, and `.obsidian/` writes are rejected, and walls are checked on **resolved real paths** so symlinks cannot tunnel out.
- `VAULT_PATH`, `WRITE_ROOTS`, and `MARK_VALUES` are **required** for `vault-workspace-mcp` — there are no fallback values.

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
  env:
    VAULT_PATH: /absolute/path/to/vault
    WRITE_ROOTS: <fleeting root>,<work root>
    DELETE_ROOTS: <work root>          # omit to ship without a delete tool
    MARK_VALUES: "/,!"                 # one checkbox char per outcome
paper-fetch:
  command: node
  args: [<install path>/node_modules/paper-fetch-mcp/server.mjs]
```
