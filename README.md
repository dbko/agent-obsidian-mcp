# Vault Steward MCP candidates

Host Adapter implementation candidates for Vault Steward. They are reusable primitives, not canonical bindings: every installer must pin, scope, smoke-test, and pass Conformance on the target host.

| Package | Tool surface | Purpose |
|---|---|---|
| [`vault-workspace-mcp`](packages/vault-workspace-mcp/) | scoped Vault I/O · exact Todo query · `todo_transition` | Role/assignment-scoped filesystem primitive and Gate-only conditional Todo effects. |
| [`paper-fetch-mcp`](packages/paper-fetch-mcp/) | `paper_fulltext_fetch` | arXiv/DOI/OpenAlex resolution to paged open full text with stable locators. |
| [`vault-sync-mcp`](packages/vault-sync-mcp/) | `sync_run` · `sync_plan_latest` | Fires a vault replication run and judges it by the exported plan, not by the command's HTTP status. |
| [`papers-search-mcp`](packages/papers-search-mcp/) | `paper_semantic_search` | Hugging Face Papers corpus search with a structural scope wall — the tool takes no path, URI, host, or repo argument. |

All four servers are **zero-dependency single files** (Node ≥ 18 built-ins only; `paper-fetch-mcp` additionally shells out to `pdftotext` for its PDF fallback).

## Deliberate boundaries

These servers are I/O capability layers only. Verdicts, scoring, state transitions, and completion belong to the workflow's gate core, which is implemented on the host — never here.

- Reading, writing, and deleting have separate rooted or exact scopes. Unconfigured mutation surfaces are absent from `tools/list`.
- `vault_search` **requires a folder scope** — full-vault scans are not offered.
- `todo_query` returns only `[ ]` plus the configured exact selector and a source fingerprint. `todo_transition` fails closed if that source changed.
- Paths are Vault-relative and checked on resolved real paths. Default read denies cover Vault control, trash, agent configuration, and every `.git` directory.
- `paper_fulltext_fetch` does not treat metadata or an abstract as full text; it requires a retrievable arXiv, OA PDF, or structurally identified full-article HTML source.
- `vault-sync-mcp` proves the replication capability by **running** the command rather than by reading the plugin's (obfuscated) settings, treats HTTP 204 as acceptance rather than completion, walls applying separately from planning, and deletes nothing it exported.

## Develop

```bash
npm run smoke        # offline smoke suites for both servers
SMOKE_NETWORK=1 node tests/smoke-paper-fetch.mjs   # + arXiv, DOI, and OpenAlex ID paths
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
    READ_ROOTS: "."
    READ_DENIES: ".obsidian,.trash,.agents,.claude,.codex,**/.git"
    WRITE_PATHS: <assignment output>   # or a Gate-owned WRITE_ROOTS
    TODO_SELECTOR: "#agent/todo"
    TODO_MARKS: "waiting=~,succeeded=/,failed=!"
    TODO_WRITE: "0"                   # only a Gate instance receives 1
paper-fetch:
  command: node
  args: [<install path>/node_modules/paper-fetch-mcp/server.mjs]
vault-sync:
  command: node
  args: [<install path>/node_modules/vault-sync-mcp/server.mjs]
  env:
    VAULT_PATH: /absolute/path/to/vault
    OBSIDIAN_API_KEY: <Local REST API key>
    SYNC_ALLOW_APPLY: "0"             # only an instance permitted to replicate receives 1
```
