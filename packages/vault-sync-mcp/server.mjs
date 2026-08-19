#!/usr/bin/env node
// vault-sync-mcp — zero-dependency stdio MCP server that fires a vault replication
// run and reports the outcome from the plan artefact, never from the command's
// HTTP status.
//
// Backend: the Remotely Save plugin, driven through the Obsidian Local REST API
// (`POST /commands/<id>/`). The command ids are Remotely Save's; everything else
// here is backend-agnostic.
//
// Tools:
//   sync_run(dry_run?, timeout_ms?, list_limit?)  -> fire a run, then recover the plan and report it
//   sync_plan_latest(list_limit?)                 -> parse the newest already-exported plan (no HTTP)
//
// Config (env): VAULT_PATH · OBSIDIAN_API_KEY · OBSIDIAN_API_URL · SYNC_PLAN_DIR ·
//               SYNC_ALLOW_APPLY · SYNC_TLS_INSECURE.
// Node built-ins only. stdout is reserved for JSON-RPC frames; logs go to stderr.
//
// Deliberate boundaries:
//   - The capability is proven by RUNNING the command, not by reading the plugin's
//     settings. Remotely Save stores its config in an obfuscated blob; three separate
//     installs read it, saw nothing, and concluded "no remote configured" — which a
//     single dry run disproved. This server therefore never opens that file.
//   - HTTP 204 is not evidence. The plugin answers 204 for a command it merely
//     accepted, and exports nothing at all when it holds no plan. Completion is
//     decided by a plan whose own generateTime is at or after the moment we fired.
//   - Applying is walled SEPARATELY from planning. A dry run reads the remote; a real
//     run pushes to it. dry_run:false requires SYNC_ALLOW_APPLY=1 — a planning surface
//     is not automatically a replicating one.
//   - No delete surface. Every export drops a file into the vault and this server
//     removes none of them: deletions here are known to resurrect (upstream bug), so
//     removal is the user's call. The files written are named in the result instead.
//   - Read-only against the vault otherwise: it opens the plan directory and nothing else.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';

const PROTOCOL = '2025-03-26';
const SERVER_NAME = 'vault-sync-mcp';
const SERVER_VERSION = '0.1.2';

const log = (...a) => process.stderr.write(a.join(' ') + '\n');

const VAULT = process.env.VAULT_PATH;
if (!VAULT || !path.isAbsolute(VAULT)) {
  log('FATAL: VAULT_PATH env var is required and must be an absolute path to the vault root.');
  process.exit(1);
}
const VAULT_REAL = await fs.realpath(VAULT).catch(() => {
  log(`FATAL: VAULT_PATH does not resolve: ${VAULT}`);
  process.exit(1);
});

const API_KEY = process.env.OBSIDIAN_API_KEY;
if (!API_KEY) {
  log('FATAL: OBSIDIAN_API_KEY env var is required (Local REST API plugin settings).');
  process.exit(1);
}

const API_URL = process.env.OBSIDIAN_API_URL || 'https://127.0.0.1:27124';
let API;
try {
  API = new URL(API_URL);
  if (API.protocol !== 'https:' && API.protocol !== 'http:') throw new Error('unsupported protocol');
} catch {
  log(`FATAL: OBSIDIAN_API_URL is not a usable URL: ${API_URL}`);
  process.exit(1);
}

// The plugin serves a self-signed certificate. Accept it on loopback, where the peer
// cannot be anyone else; anywhere else it takes an explicit opt-in.
const LOOPBACK = ['127.0.0.1', '::1', 'localhost'].includes(API.hostname);
const TLS_INSECURE = process.env.SYNC_TLS_INSECURE === '1' || LOOPBACK;
if (API.protocol === 'https:' && !TLS_INSECURE) {
  log('NOTE: TLS verification is on; a self-signed plugin certificate will be rejected.');
}

const PLAN_DIR = process.env.SYNC_PLAN_DIR || '_debug_remotely_save';
const PLAN_DIR_ABS = path.resolve(VAULT_REAL, PLAN_DIR);
if (!PLAN_DIR_ABS.startsWith(VAULT_REAL + path.sep)) {
  log(`FATAL: SYNC_PLAN_DIR escapes the vault: ${PLAN_DIR}`);
  process.exit(1);
}

const APPLY_ENABLED = process.env.SYNC_ALLOW_APPLY === '1';

const CMD_START = 'remotely-save:start-sync';
const CMD_START_DRY = 'remotely-save:start-sync-dry-run';
const CMD_EXPORT = 'remotely-save:export-sync-plans-1';

const PLAN_FILE_RE = /^sync_plans_hist_exported_on_(\d+)\.md$/;
const META_KEY = '/$@meta';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Local REST API -----------------------------------------------------------

function postCommand(commandId) {
  if (!/^[a-z0-9._-]+:[a-z0-9._-]+$/i.test(commandId))
    return Promise.reject(new Error(`refusing a malformed command id: ${commandId}`));
  const lib = API.protocol === 'https:' ? https : http;
  const opts = {
    hostname: API.hostname,
    port: API.port || (API.protocol === 'https:' ? 443 : 80),
    path: `/commands/${commandId}/`,
    method: 'POST',
    headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Length': 0 },
    timeout: 15000,
  };
  if (API.protocol === 'https:' && TLS_INSECURE) opts.rejectUnauthorized = false;
  return new Promise((resolve, reject) => {
    const req = lib.request(opts, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { if (body.length < 4096) body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: body.trim() }));
    });
    req.on('timeout', () => req.destroy(new Error('request timed out')));
    req.on('error', (e) => reject(new Error(`${API.origin} unreachable: ${e.message}`)));
    req.end();
  });
}

async function fire(commandId) {
  const r = await postCommand(commandId);
  if (r.status < 200 || r.status >= 300)
    throw new Error(`${commandId} refused with HTTP ${r.status}${r.body ? `: ${r.body.slice(0, 200)}` : ''}`);
  return r.status;
}

// --- plan artefacts -----------------------------------------------------------

async function listPlanFiles() {
  let names;
  try { names = await fs.readdir(PLAN_DIR_ABS); }
  catch (e) {
    if (e.code === 'ENOENT') return [];
    throw new Error(`cannot read the plan directory ${PLAN_DIR}: ${e.message}`);
  }
  return names
    .map((name) => ({ name, m: PLAN_FILE_RE.exec(name) }))
    .filter((x) => x.m)
    .map((x) => ({ name: x.name, exported_at_ms: Number(x.m[1]) }))
    .sort((a, b) => b.exported_at_ms - a.exported_at_ms);
}

function parsePlan(text, listLimit) {
  const fence = /```json\s*([\s\S]*?)```/.exec(text);
  if (!fence) throw new Error('the plan file holds no fenced json block');
  let doc;
  try { doc = JSON.parse(fence[1]); }
  catch (e) { throw new Error(`the plan json does not parse: ${e.message}`); }

  const meta = doc[META_KEY]?.sideNotes ?? null;
  const entries = Object.entries(doc).filter(([k]) => k !== META_KEY);
  const pending = entries.filter(([, v]) => v && v.change === true);

  const byDecision = {};
  for (const [, v] of pending) {
    const d = v.decision ?? 'unknown';
    byDecision[d] = (byDecision[d] ?? 0) + 1;
  }
  const conflicts = pending
    .filter(([, v]) => String(v.decision ?? '').includes('conflict'))
    .map(([k, v]) => ({ key: k, decision: v.decision }));

  return {
    generated_at: meta?.generateTimeFmt ?? null,
    generated_at_ms: typeof meta?.generateTime === 'number' ? meta.generateTime : null,
    service: meta?.service ?? null,
    trigger_source: meta?.triggerSource ?? null,
    sync_direction: meta?.syncDirection ?? null,
    total_entries: entries.length,
    pending: pending.length,
    by_decision: byDecision,
    conflicts,
    pending_keys: pending.slice(0, listLimit).map(([k]) => k),
    pending_keys_truncated: pending.length > listLimit,
  };
}

async function readPlan(name, listLimit) {
  const abs = path.join(PLAN_DIR_ABS, name);
  const text = await fs.readFile(abs, 'utf8');
  return parsePlan(text, listLimit);
}

function clampLimit(v, dflt = 50) {
  const n = Number.isFinite(v) ? Math.floor(v) : dflt;
  return Math.max(0, Math.min(500, n));
}

// --- tools --------------------------------------------------------------------

async function syncPlanLatest(args) {
  const listLimit = clampLimit(args.list_limit);
  const files = await listPlanFiles();
  if (!files.length)
    return { found: false, plan_dir: PLAN_DIR, note: 'no exported plan yet — run sync_run first' };
  const newest = files[0];
  return {
    found: true,
    plan_file: path.posix.join(PLAN_DIR, newest.name),
    exported_at_ms: newest.exported_at_ms,
    plan: await readPlan(newest.name, listLimit),
  };
}

async function syncRun(args) {
  const dryRun = args.dry_run === undefined ? true : !!args.dry_run;
  const listLimit = clampLimit(args.list_limit);
  const timeoutMs = Math.max(5000, Math.min(600000, Number(args.timeout_ms) || 60000));

  if (!dryRun && !APPLY_ENABLED)
    throw new Error(
      'dry_run:false needs SYNC_ALLOW_APPLY=1 — this instance may plan a replication but not perform one',
    );

  const command = dryRun ? CMD_START_DRY : CMD_START;
  const before = new Set((await listPlanFiles()).map((f) => f.name));
  const firedAt = Date.now();
  const status = await fire(command);

  const deadline = firedAt + timeoutMs;
  let plan = null;
  let planFile = null;
  let lastSeen = null;

  // The run needs a moment before it has a plan to hand out, and the export lands on
  // disk a beat after the command returns. Neither delay is observable, so we retry —
  // with a doubling gap, because every export drops a file this server will not delete:
  // a fixed cadence against a long-running sync turns the plan dir into hundreds of
  // artefacts (measured: 769 files across one stalled run).
  let gap = 2000;
  while (Date.now() < deadline) {
    await sleep(Math.min(gap, Math.max(1, deadline - Date.now())));
    gap *= 2;
    try { await fire(CMD_EXPORT); } catch (e) { lastSeen = e.message; }
    await sleep(1500);
    const files = await listPlanFiles();
    for (const f of files) {
      let parsed;
      try { parsed = await readPlan(f.name, listLimit); } catch { continue; }
      if (parsed.generated_at_ms !== null && parsed.generated_at_ms >= firedAt) {
        plan = parsed;
        planFile = f.name;
        break;
      }
      if (!lastSeen && parsed.generated_at_ms !== null)
        lastSeen = `newest plan predates the run (${parsed.generated_at})`;
    }
    if (plan) break;
  }

  const written = (await listPlanFiles()).filter((f) => !before.has(f.name)).map((f) => path.posix.join(PLAN_DIR, f.name));

  const out = {
    fired: command,
    dry_run: dryRun,
    http_status: status,
    completed: !!plan,
    plan_files_written: written,
    note: 'HTTP 204 only means the command was accepted; the plan artefact is the evidence. This server never deletes the files it exported.',
  };
  if (plan && dryRun) {
    out.plan_file = path.posix.join(PLAN_DIR, planFile);
    out.plan = plan;
    out.synced = plan.pending === 0;
  } else if (plan) {
    // On an applying run this plan is the work the run SET OUT to do — the plugin
    // records it when the run starts. Reading `pending` off it would report "12
    // still pending" about the very files just pushed. The outcome is a fact about
    // the remote after the fact, so ask for a fresh look rather than infer one.
    out.plan_file = path.posix.join(PLAN_DIR, planFile);
    out.planned = plan;
    out.synced = null;
    out.confirm_with = 'sync_run { dry_run: true } — its pending count is the outcome';
  } else {
    out.reason = lastSeen
      ? `no plan generated at or after the run within ${timeoutMs}ms — ${lastSeen}`
      : `no plan generated at or after the run within ${timeoutMs}ms`;
  }
  return out;
}

// --- registry -----------------------------------------------------------------

const TOOLS = [
  {
    name: 'sync_run',
    description:
      'Fire a vault replication run, then recover its plan and report it. Completion is judged by a plan whose own generateTime is at or after the run, never by the command\'s HTTP status. dry_run (default true) computes the plan without pushing.',
    inputSchema: {
      type: 'object',
      properties: {
        dry_run: { type: 'boolean', description: 'Default true. false performs the replication and requires SYNC_ALLOW_APPLY=1.' },
        timeout_ms: { type: 'number', description: 'How long to wait for the plan (default 60000, max 600000).' },
        list_limit: { type: 'number', description: 'How many pending keys to name (default 50, max 500).' },
      },
    },
  },
  {
    name: 'sync_plan_latest',
    description:
      'Parse the newest already-exported plan and report it. Fires nothing and reaches no network — use it to read the outcome of a run started elsewhere, such as from the Obsidian UI.',
    inputSchema: {
      type: 'object',
      properties: {
        list_limit: { type: 'number', description: 'How many pending keys to name (default 50, max 500).' },
      },
    },
  },
];

const HANDLERS = {
  sync_run: syncRun,
  sync_plan_latest: syncPlanLatest,
};

async function callTool(name, args) {
  const h = HANDLERS[name];
  if (!h) throw new Error(`unknown tool: ${name}`);
  return await h(args || {});
}

// --- JSON-RPC / stdio loop ----------------------------------------------------
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function replyErr(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    const pv = (params && params.protocolVersion) || PROTOCOL;
    return reply(id, {
      protocolVersion: pv,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (method && method.startsWith('notifications/')) return;
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/list') return reply(id, { tools: TOOLS });
  if (method === 'tools/call') {
    const { name, arguments: args } = params || {};
    try {
      const data = await callTool(name, args);
      return reply(id, { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
    } catch (e) {
      return reply(id, { content: [{ type: 'text', text: `ERROR: ${e.message}` }], isError: true });
    }
  }
  if (id !== undefined) replyErr(id, -32601, `method not found: ${method}`);
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { log('parse error:', line); continue; }
    Promise.resolve(handle(msg)).catch((e) => log('handler error:', e && e.message));
  }
});
log(`${SERVER_NAME} ${SERVER_VERSION} ready (vault: ${VAULT})`);
log(`  api: ${API.origin}${API.protocol === 'https:' && TLS_INSECURE ? ' (self-signed accepted)' : ''}`);
log(`  plan dir: ${PLAN_DIR}`);
log(`  apply: ${APPLY_ENABLED ? 'enabled (dry_run:false permitted)' : 'disabled — planning only'}`);
