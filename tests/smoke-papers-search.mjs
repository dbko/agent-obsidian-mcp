// Smoke for papers-search-mcp — `030` requires the implementation to ship
// with its own smoke, testing what is allowed AND what is refused, and
// confirming the refusal actually blocked rather than merely returned.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'papers-search-mcp', 'server.mjs');
const NETWORK = process.env.SMOKE_NETWORK === '1';

let failures = 0;
const ok = (label, cond) => {
  console.log(`  ${cond ? 'ok ' : 'FAIL'}  ${label}`);
  if (!cond) failures++;
};

function start() {
  const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let id = 0;
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    }
  });
  return {
    rpc: (method, params) =>
      new Promise((resolve) => {
        const rid = ++id;
        pending.set(rid, resolve);
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: rid, method, params }) + '\n');
      }),
    stop: () => child.kill(),
  };
}

const text = (m) => (m.result?.content ?? []).map((c) => c.text).join('');
const s = start();

const init = await s.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
ok('initialize', init.result?.serverInfo?.name === 'papers-search-mcp');
ok('version is 0.1.0', init.result?.serverInfo?.version === '0.1.0');

const listed = await s.rpc('tools/list', {});
const names = (listed.result?.tools ?? []).map((t) => t.name);
ok('tool surface = paper_semantic_search only', names.length === 1 && names[0] === 'paper_semantic_search');

// The wall is structural: there must be no way to name a target.
const props = Object.keys(listed.result.tools[0].inputSchema.properties);
ok('schema exposes only query/limit', props.sort().join(',') === 'limit,query');
ok('no path/uri/repo/host argument exists',
   !props.some((p) => /path|uri|url|repo|host|file|dataset|model/i.test(p)));

// Refusals
ok('unknown tool refused', (await s.rpc('tools/call', { name: 'hf_fs', arguments: {} })).result?.isError === true);
const empty = await s.rpc('tools/call', { name: 'paper_semantic_search', arguments: { query: '  ' } });
ok('empty query refused', empty.result?.isError === true);
const missing = await s.rpc('tools/call', { name: 'paper_semantic_search', arguments: {} });
ok('missing query refused', missing.result?.isError === true);
const badLimit = await s.rpc('tools/call', { name: 'paper_semantic_search', arguments: { query: 'x', limit: -3 } });
ok('negative limit refused', badLimit.result?.isError === true);

// Extra arguments must not become a target: the server ignores them, so a
// caller cannot smuggle a path in alongside a valid query.
if (NETWORK) {
  const smuggle = await s.rpc('tools/call', {
    name: 'paper_semantic_search',
    arguments: { query: 'gaussian splatting', path: 'hf://datasets', cmd: 'ls' },
  });
  const body = text(smuggle);
  ok('extra path/cmd arguments are ignored, not honoured',
     smuggle.result?.isError !== true && !body.includes('hf://datasets'));

  const res = await s.rpc('tools/call', {
    name: 'paper_semantic_search',
    arguments: { query: 'gaussian splatting', limit: 3 },
  });
  const payload = JSON.parse(text(res));
  ok('search returns rows', Array.isArray(payload.results) && payload.results.length > 0);
  ok('limit is honoured', payload.results.length <= 3);
  ok('every row carries a stable identifier', payload.results.every((r) => typeof r.paper_id === 'string' && r.paper_id));
  ok('identifiers look like arXiv ids', payload.results.every((r) => /^\d{4}\.\d{4,5}$/.test(r.arxiv_id)));
  ok('rows carry title and authors', payload.results.every((r) => r.title && Array.isArray(r.authors)));
  ok('abstract-only evidence level is declared',
     payload.results.every((r) => r.evidence_level === 'abstract_only'));
  ok('fetch time is stamped', typeof payload.fetched_at === 'string');
} else {
  console.log('  (network cases skipped — set SMOKE_NETWORK=1 to include)');
}

s.stop();
console.log(failures === 0 ? '== papers-search-mcp smoke: ALL PASS ==' : `== papers-search-mcp smoke: ${failures} FAILURES ==`);
process.exit(failures === 0 ? 0 : 1);
