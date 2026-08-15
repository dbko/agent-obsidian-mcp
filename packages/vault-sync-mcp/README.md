# vault-sync-mcp

Fires a vault replication run and reports the outcome **from the plan artefact**, never from
the command's HTTP status.

Zero dependencies, Node ≥ 18, stdio JSON-RPC. Backend: the [Remotely Save](https://github.com/remotely-save/remotely-save)
plugin, driven through the Obsidian Local REST API. The command ids are Remotely Save's;
everything else is backend-agnostic.

## Why it is shaped this way

**The capability is proven by running the command, not by reading settings.** Remotely Save
keeps its configuration in an obfuscated blob. Three separate installs opened that file, saw
nothing they recognised, and concluded "no remote is configured" — which a single dry run
disproved in four seconds. This server never opens that file. If a run produces a plan, the
remote is there; if it does not, no amount of config reading would have helped.

**HTTP 204 is not evidence.** The plugin answers `204` to a command it merely accepted, and
exports nothing at all when it is holding no plan. A run counts as complete only when a plan
turns up whose own `generateTime` is at or after the moment we fired.

**Planning and applying are walled separately.** A dry run reads the remote; a real run pushes
to it. `dry_run:false` needs `SYNC_ALLOW_APPLY=1`.

**There is no delete surface.** Every export drops a file into the vault, and this server
removes none of them — deletions here are known to resurrect (upstream bug), so removal is the
user's call. The files a call wrote are named in its result instead. This costs little: the
default plan directory begins with an underscore, and Remotely Save's `syncUnderscoreItems` is
off by default, so the exports stay on the machine that made them rather than replicating.
Keep that property in mind before pointing `SYNC_PLAN_DIR` somewhere else — a full plan runs
close to a megabyte.

## Tools

### `sync_run(dry_run?, timeout_ms?, list_limit?)`

Fires `remotely-save:start-sync-dry-run` (or `…:start-sync` when applying), then exports and
parses the resulting plan.

- `dry_run` — default `true`. `false` performs the replication and requires `SYNC_ALLOW_APPLY=1`.
- `timeout_ms` — how long to wait for a fresh plan. Default `60000`, max `600000`.
- `list_limit` — how many pending keys to name. Default `50`, max `500`.

```jsonc
{
  "fired": "remotely-save:start-sync-dry-run",
  "dry_run": true,
  "http_status": 204,
  "completed": true,
  "synced": false,                       // pending === 0
  "plan_file": "_debug_remotely_save/sync_plans_hist_exported_on_1786795305176.md",
  "plan_files_written": ["_debug_remotely_save/…"],
  "plan": {
    "generated_at": "2026-08-15T21:00:51+09:00",
    "service": "dropbox",
    "trigger_source": "manual",
    "sync_direction": "bidirectional",
    "total_entries": 552,
    "pending": 37,
    "by_decision": { "local_is_created_then_push": 24, "local_is_modified_then_push": 7 },
    "conflicts": [{ "key": "…", "decision": "conflict_modified_then_keep_local" }],
    "pending_keys": ["…"],
    "pending_keys_truncated": false
  }
}
```

When no fresh plan arrives in time the call returns `completed:false` with a `reason` — it does
not guess. An unparsable plan is an error, never "nothing pending".

**An applying run reports `planned`, not `plan`.** The plugin records the plan when a run
*starts*, so it is the work the run set out to do — not what it achieved. Reading `pending` off
it would say "12 still pending" about the very files just pushed. So `dry_run:false` returns
`planned`, sets `synced: null`, and names the follow-up:

```jsonc
{ "fired": "remotely-save:start-sync", "synced": null,
  "confirm_with": "sync_run { dry_run: true } — its pending count is the outcome" }
```

The outcome is a fact about the remote after the fact. Ask for it; do not infer it.

### `sync_plan_latest(list_limit?)`

Parses the newest already-exported plan. Fires nothing and reaches no network — use it to read
the outcome of a run started elsewhere, such as from the Obsidian UI.

## Configuration

| env | required | meaning |
|---|---|---|
| `VAULT_PATH` | yes | Absolute path to the vault root. |
| `OBSIDIAN_API_KEY` | yes | From the Local REST API plugin's settings. |
| `OBSIDIAN_API_URL` | no | Default `https://127.0.0.1:27124`. |
| `SYNC_PLAN_DIR` | no | Default `_debug_remotely_save`, vault-relative. |
| `SYNC_ALLOW_APPLY` | no | `1` permits `dry_run:false`. Off by default. |
| `SYNC_TLS_INSECURE` | no | `1` accepts a self-signed certificate. Implied on loopback. |

The plugin serves a self-signed certificate, so TLS verification is relaxed automatically when
the host is loopback and only then.

## Smoke test

```sh
node tests/smoke-vault-sync.mjs                 # offline: protocol, parsing, walls
SMOKE_LIVE_SYNC=1 VAULT_PATH=… OBSIDIAN_API_KEY=… node tests/smoke-vault-sync.mjs
```

The live path performs one dry run. It never applies a replication.
