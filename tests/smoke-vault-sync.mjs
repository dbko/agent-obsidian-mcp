// tests/smoke-vault-sync.mjs — offline smoke: protocol, tool surface, plan parsing, apply wall.
// Set SMOKE_LIVE_SYNC=1 (plus VAULT_PATH and OBSIDIAN_API_KEY) to additionally run one real
// dry run against a live Obsidian Local REST API. The live path never applies a replication.

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, check, summary } from '../shared/smoke-client.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(here, '..', 'packages', 'vault-sync-mcp', 'server.mjs');

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-sync-smoke-'));
const planDir = path.join(tmp, '_debug_remotely_save');
await fs.mkdir(planDir, { recursive: true });

const GEN_MS = 1786795251955;
const plan = {
  '/$@meta': {
    key: '/$@meta',
    sideNotes: {
      generateTime: GEN_MS,
      generateTimeFmt: '2026-08-15T21:00:51+09:00',
      service: 'dropbox',
      triggerSource: 'manual',
      syncDirection: 'bidirectional',
    },
  },
  'kept/': { key: 'kept/', decision: 'folder_existed_both_then_do_nothing', change: false },
  'new.md': { key: 'new.md', decision: 'local_is_created_then_push', change: true },
  'both.md': { key: 'both.md', decision: 'conflict_modified_then_keep_local', change: true },
};
await fs.writeFile(
  path.join(planDir, `sync_plans_hist_exported_on_${GEN_MS + 10}.md`),
  'Sync plans found:\n\n```json\n' + JSON.stringify(plan, null, 2) + '\n```\n',
);

// An unroutable port: the HTTP path must fail loudly rather than pretend success.
const baseEnv = {
  VAULT_PATH: tmp,
  OBSIDIAN_API_KEY: 'smoke-key',
  OBSIDIAN_API_URL: 'http://127.0.0.1:1',
};

const srv = startServer(SERVER, baseEnv);
await new Promise((r) => setTimeout(r, 300));

try {
  const init = await srv.rpc('initialize', { protocolVersion: '2025-03-26' });
  check('initialize', init.result?.serverInfo?.name === 'vault-sync-mcp');
  check('version is 0.1.0', init.result?.serverInfo?.version === '0.1.0', init.result?.serverInfo?.version);

  const list = await srv.rpc('tools/list', {});
  const names = (list.result?.tools || []).map((t) => t.name).sort();
  check(
    'tool surface = sync_plan_latest + sync_run',
    JSON.stringify(names) === JSON.stringify(['sync_plan_latest', 'sync_run']),
    names.join(','),
  );
  check('no delete surface', !names.some((n) => /delete|remove|clean/i.test(n)));

  let r = await srv.callTool('sync_plan_latest', {});
  check('latest plan found', !r.isError && r.data?.found === true, r.text?.slice(0, 160));
  check('counts changes only', r.data?.plan?.pending === 2 && r.data?.plan?.total_entries === 3, JSON.stringify(r.data?.plan));
  check('reads the service off the plan', r.data?.plan?.service === 'dropbox', r.data?.plan?.service);
  check('names the conflict', r.data?.plan?.conflicts?.[0]?.key === 'both.md', JSON.stringify(r.data?.plan?.conflicts));
  check(
    'groups by decision',
    r.data?.plan?.by_decision?.local_is_created_then_push === 1,
    JSON.stringify(r.data?.plan?.by_decision),
  );
  check('plan path is vault-relative', r.data?.plan_file?.startsWith('_debug_remotely_save/'), r.data?.plan_file);

  r = await srv.callTool('sync_plan_latest', { list_limit: 0 });
  check('list_limit 0 still counts', r.data?.plan?.pending === 2 && r.data?.plan?.pending_keys?.length === 0);
  check('truncation is declared', r.data?.plan?.pending_keys_truncated === true);

  r = await srv.callTool('sync_run', { dry_run: false });
  check('apply is walled off by default', r.isError && /SYNC_ALLOW_APPLY/.test(r.text), r.text?.slice(0, 160));

  r = await srv.callTool('sync_run', { timeout_ms: 5000 }, 30000);
  check('unreachable api surfaces as an error', r.isError && /unreachable/.test(r.text), r.text?.slice(0, 160));

  r = await srv.callTool('sync_nuke', {});
  check('unknown tool refused', r.isError && /unknown tool/.test(r.text));
} finally {
  srv.kill();
}

// A vault with no exported plan must say so rather than invent an empty one.
const emptyVault = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-sync-empty-'));
const srv2 = startServer(SERVER, { ...baseEnv, VAULT_PATH: emptyVault });
await new Promise((r) => setTimeout(r, 300));
try {
  const r = await srv2.callTool('sync_plan_latest', {});
  check('missing plan dir reports found:false', !r.isError && r.data?.found === false, r.text?.slice(0, 160));
} finally {
  srv2.kill();
}

// A plan that cannot be parsed must not read as "nothing pending".
const badVault = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-sync-bad-'));
await fs.mkdir(path.join(badVault, '_debug_remotely_save'), { recursive: true });
await fs.writeFile(path.join(badVault, '_debug_remotely_save', 'sync_plans_hist_exported_on_1.md'), 'no json here');
const srv3 = startServer(SERVER, { ...baseEnv, VAULT_PATH: badVault });
await new Promise((r) => setTimeout(r, 300));
try {
  const r = await srv3.callTool('sync_plan_latest', {});
  check('unparsable plan is an error, not zero pending', r.isError && /fenced json/.test(r.text), r.text?.slice(0, 160));
} finally {
  srv3.kill();
}

if (process.env.SMOKE_LIVE_SYNC === '1') {
  const liveVault = process.env.VAULT_PATH;
  const liveKey = process.env.OBSIDIAN_API_KEY;
  if (!liveVault || !liveKey) {
    check('live run configured', false, 'SMOKE_LIVE_SYNC=1 needs VAULT_PATH and OBSIDIAN_API_KEY');
  } else {
    const srv4 = startServer(SERVER, {
      VAULT_PATH: liveVault,
      OBSIDIAN_API_KEY: liveKey,
      OBSIDIAN_API_URL: process.env.OBSIDIAN_API_URL || 'https://127.0.0.1:27124',
    });
    await new Promise((r) => setTimeout(r, 300));
    try {
      const r = await srv4.callTool('sync_run', { timeout_ms: 90000, list_limit: 5 }, 150000);
      check('live dry run completes', !r.isError && r.data?.completed === true, r.text?.slice(0, 240));
      check('live run stayed dry', r.data?.dry_run === true && r.data?.fired === 'remotely-save:start-sync-dry-run');
      check('live plan is fresh and names a service', !!r.data?.plan?.service && !!r.data?.plan?.generated_at, JSON.stringify(r.data?.plan)?.slice(0, 200));
      check('live run reports what it wrote', Array.isArray(r.data?.plan_files_written));
    } finally {
      srv4.kill();
    }
  }
} else {
  console.log('  (live dry run skipped — set SMOKE_LIVE_SYNC=1 with VAULT_PATH + OBSIDIAN_API_KEY to include)');
}

process.exit(summary('vault-sync-mcp smoke'));
