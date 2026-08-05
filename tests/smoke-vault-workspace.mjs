// tests/smoke-vault-workspace.mjs — end-to-end smoke over a temp fixture vault.
// Covers all 6 tools + the deliberate boundaries: folder-required search, the WRITE_ROOTS
// wall, the separate DELETE_ROOTS wall (v0.3), configured marks with '[x]'/'[ ]' refused,
// fenced-block refusal, path traversal, .obsidian rejection, and symlink tunnelling.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, check, summary } from '../shared/smoke-client.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(here, '..', 'packages', 'vault-workspace-mcp', 'server.mjs');

// --- fixture vault -----------------------------------------------------------
const vault = mkdtempSync(path.join(tmpdir(), 'vws-smoke-'));
const outside = mkdtempSync(path.join(tmpdir(), 'vws-outside-'));
writeFileSync(path.join(outside, 'precious.md'), 'must survive\n');
mkdirSync(path.join(vault, 'initiatives'), { recursive: true });
mkdirSync(path.join(vault, '.obsidian'), { recursive: true });
mkdirSync(path.join(vault, 'work'), { recursive: true });
writeFileSync(path.join(vault, 'initiatives', 'sub-a.md'), [
  '# Sub A',
  '- [ ] 수집 작업 하나 #agent/todo',
  '- [x] 끝난 일 #agent/todo',
  '- [ ] 태그 없는 일',
  '```',
  '- [ ] 예시 속 가짜 트리거 #agent/todo',
  '```',
  '본문에 검색어 NEEDLE 이 있음',
  '- [ ] 실패로 닫을 일 #agent/todo',
].join('\n'));
writeFileSync(path.join(vault, 'initiatives', 'sub-b.md'), '# Sub B\n- [/] 이미 처리된 일 #agent/todo\n');
// a symlink inside the write surface, pointing out of the vault
symlinkSync(outside, path.join(vault, 'work', 'tunnel'));
// and one that stays inside it (resolves within the wall — only the lstat guard stops it)
mkdirSync(path.join(vault, 'work', 'kept'), { recursive: true });
symlinkSync(path.join(vault, 'work', 'kept'), path.join(vault, 'work', 'inlink'));

const ENV = { VAULT_PATH: vault, WRITE_ROOTS: 'fleeting,work', DELETE_ROOTS: 'work', MARK_VALUES: '/,!' };
const srv = startServer(SERVER, ENV);
await new Promise(r => setTimeout(r, 300));

try {
  // initialize / tools list
  const init = await srv.rpc('initialize', { protocolVersion: '2025-03-26' });
  check('initialize', init.result?.serverInfo?.name === 'vault-workspace-mcp');
  check('version is 0.3.0', init.result?.serverInfo?.version === '0.3.0', init.result?.serverInfo?.version);
  const list = await srv.rpc('tools/list', {});
  const names = (list.result?.tools || []).map(t => t.name).sort();
  check('tool surface = 6 canonical tools (v0.3 adds vault_delete)',
    JSON.stringify(names) === JSON.stringify(['todo_mark', 'todo_query', 'vault_delete', 'vault_read', 'vault_search', 'vault_write'].sort()),
    names.join(','));
  const markSchema = (list.result?.tools || []).find(t => t.name === 'todo_mark');
  check('todo_mark advertises the configured marks',
    JSON.stringify(markSchema?.inputSchema?.properties?.mark?.enum) === JSON.stringify(['/', '!']));

  // todo_query: open only, fence skipped, configured marks excluded from "open"
  let r = await srv.callTool('todo_query', { folder: 'initiatives' });
  check('todo_query finds exactly 2 open tagged todos', r.data?.count === 2, JSON.stringify(r.data?.rows));
  check('todo_query returns file·line', r.data?.rows?.[0]?.file === path.join('initiatives', 'sub-a.md') && r.data?.rows?.[0]?.line === 2);
  r = await srv.callTool('todo_query', { folder: 'initiatives', status: 'agent_finished' });
  check('todo_query: configured mark = agent_finished', r.data?.count === 1 && r.data?.rows?.[0]?.mark === '/');

  // vault_search: folder required; query hits
  r = await srv.callTool('vault_search', {});
  check('vault_search without folder is refused', r.isError, r.text);
  r = await srv.callTool('vault_search', { folder: 'initiatives', query: 'NEEDLE' });
  check('vault_search finds content match', r.data?.count === 1 && r.data?.matches?.[0]?.file.endsWith('sub-a.md'));

  // vault_read paging
  r = await srv.callTool('vault_read', { file: 'initiatives/sub-a.md', offset: 2, limit: 1 });
  check('vault_read paging', r.data?.returned_lines === 1 && r.data?.text.includes('수집 작업'));

  // vault_write: create / no-silent-overwrite / append / traversal & .obsidian rejection
  r = await srv.callTool('vault_write', { file: 'work/w-1/note.md', content: 'hello' });
  check('vault_write create with parent dirs', r.data?.ok === true);
  r = await srv.callTool('vault_write', { file: 'work/w-1/note.md', content: 'x' });
  check('vault_write create refuses existing file', r.isError);
  r = await srv.callTool('vault_write', { file: 'work/w-1/note.md', content: '\nmore', mode: 'append' });
  check('vault_write append', r.data?.ok === true);
  r = await srv.callTool('vault_write', { file: '../escape.md', content: 'x' });
  check('vault_write rejects traversal', r.isError);
  r = await srv.callTool('vault_write', { file: '.obsidian/app.json', content: '{}', mode: 'overwrite' });
  check('vault_write rejects .obsidian/', r.isError);

  // write wall: WRITE_ROOTS enforcement
  r = await srv.callTool('vault_write', { file: 'fleeting/idea.md', content: 'inside wall' });
  check('write inside WRITE_ROOTS (fleeting) allowed', r.data?.ok === true);
  r = await srv.callTool('vault_write', { file: 'initiatives/sub-a.md', content: 'x', mode: 'append' });
  check('write outside WRITE_ROOTS denied', r.isError && r.text.includes('write surface'), r.text);
  r = await srv.callTool('vault_write', { file: 'worknote.md', content: 'x' });
  check('prefix trick (worknote vs work/) denied', r.isError, r.text);

  // v0.3: a symlink under the write root must not tunnel out of the vault
  r = await srv.callTool('vault_write', { file: 'work/tunnel/pwned.md', content: 'x' });
  check('write through an out-of-vault symlink denied', r.isError && r.text.includes('link'), r.text);
  check('  ... and nothing was written outside', !existsSync(path.join(outside, 'pwned.md')));

  // todo_mark: configured marks, both outcomes, idempotency, user-only values refused
  r = await srv.callTool('todo_mark', { file: 'initiatives/sub-a.md', line: 2 });
  check('todo_mark requires an explicit mark when several are configured', r.isError, r.text);
  r = await srv.callTool('todo_mark', { file: 'initiatives/sub-a.md', line: 2, mark: '/' });
  check('todo_mark writes the accepted mark', r.data?.ok === true && r.data?.new?.includes('[/]'));
  r = await srv.callTool('todo_mark', { file: 'initiatives/sub-a.md', line: 2, mark: '/' });
  check('todo_mark is idempotent', r.data?.unchanged === true);
  r = await srv.callTool('todo_mark', { file: 'initiatives/sub-a.md', line: 9, mark: '!' });
  check('todo_mark writes the failed mark too', r.data?.ok === true && r.data?.new?.includes('[!]'));
  r = await srv.callTool('todo_query', { folder: 'initiatives' });
  check('both marked todos leave the open set', r.data?.count === 0, JSON.stringify(r.data?.rows));
  r = await srv.callTool('todo_mark', { file: 'initiatives/sub-a.md', line: 2, mark: 'x' });
  check("todo_mark refuses '[x]' (user's final confirmation)", r.isError && r.text.includes('final confirmation'), r.text);
  r = await srv.callTool('todo_mark', { file: 'initiatives/sub-a.md', line: 2, mark: ' ' });
  check("todo_mark refuses '[ ]' (re-open is the user's)", r.isError, r.text);
  r = await srv.callTool('todo_mark', { file: 'initiatives/sub-a.md', line: 3, mark: '/' });
  check('todo_mark refuses an already-[x] line', r.data?.ok === false && /final confirmation/.test(r.data?.error || ''), JSON.stringify(r.data));
  r = await srv.callTool('todo_mark', { file: 'initiatives/sub-a.md', line: 6, mark: '/' });
  check('todo_mark refuses a line inside a fence', r.data?.ok === false && /fenced/.test(r.data?.error || ''), JSON.stringify(r.data));
  r = await srv.callTool('todo_mark', { file: 'initiatives/sub-a.md', line: 8, mark: '/' });
  check('todo_mark refuses non-checkbox line', r.data?.ok === false);

  // v0.3 vault_delete: the gates' cleanup surface, walled separately
  r = await srv.callTool('vault_write', { file: 'work/w-2/probe.tmp', content: 'probe' });
  check('write probe created', r.data?.ok === true);
  r = await srv.callTool('vault_delete', { path: 'work/w-2/probe.tmp' });
  check('delete removes the write probe', r.data?.ok === true && r.data?.kind === 'file');
  check('  ... probe is gone from disk', !existsSync(path.join(vault, 'work', 'w-2', 'probe.tmp')));
  r = await srv.callTool('vault_delete', { path: 'work/w-2/probe.tmp' });
  check('delete is idempotent (absent = desired end state)', r.data?.ok === true && r.data?.unchanged === true);
  r = await srv.callTool('vault_delete', { path: 'work/w-1' });
  check('delete refuses a folder without recursive', r.isError && r.text.includes('recursive'), r.text);
  r = await srv.callTool('vault_delete', { path: 'work/w-1', recursive: true });
  check('delete removes a half-made work folder', r.data?.ok === true && r.data?.kind === 'folder' && r.data?.removed_entries === 2, JSON.stringify(r.data));
  check('  ... folder is gone from disk', !existsSync(path.join(vault, 'work', 'w-1')));
  r = await srv.callTool('vault_delete', { path: 'fleeting/idea.md' });
  check('delete denied outside DELETE_ROOTS (write surface is not a delete surface)',
    r.isError && r.text.includes('delete surface'), r.text);
  check('  ... the fleeting note survives', existsSync(path.join(vault, 'fleeting', 'idea.md')));
  r = await srv.callTool('vault_delete', { path: 'work', recursive: true });
  check('delete refuses a delete root itself', r.isError && r.text.includes('root itself'), r.text);
  r = await srv.callTool('vault_delete', { path: 'initiatives/sub-a.md' });
  check('delete denied outside the wall (vault notes)', r.isError, r.text);
  r = await srv.callTool('vault_delete', { path: '../escape.md' });
  check('delete rejects traversal', r.isError);
  r = await srv.callTool('vault_delete', { path: 'work/tunnel', recursive: true });
  check('delete refuses an out-of-vault symlink (caught as an escape)',
    r.isError && r.text.includes('link'), r.text);
  check('  ... the out-of-vault folder survives', existsSync(path.join(outside, 'precious.md')));
  // an IN-vault symlink resolves fine and lands inside the wall — the lstat guard is what
  // stops it, so that a "cleanup" never silently detaches a link the user put there.
  r = await srv.callTool('vault_delete', { path: 'work/inlink', recursive: true });
  check('delete refuses an in-vault symlink', r.isError && r.text.includes('symlink'), r.text);
  check('  ... the link and its target survive', existsSync(path.join(vault, 'work', 'inlink')));
  r = await srv.callTool('vault_delete', { path: 'work/tunnel/precious.md' });
  check('delete through a symlink denied', r.isError && r.text.includes('link'), r.text);
  check('  ... precious.md survives', existsSync(path.join(outside, 'precious.md')));
} finally {
  srv.kill();
  rmSync(vault, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
}

// --- config walls: the server must refuse to start on unsafe/missing config ----
async function expectExit(label, env, needle) {
  const s = startServer(SERVER, env);
  const code = await new Promise((resolve) => {
    s.child.on('exit', resolve);
    setTimeout(() => resolve(null), 3000);
  });
  const err = s.stderr();
  s.kill();
  check(label, code === 1 && err.includes(needle), `exit=${code} stderr=${err.trim().slice(0, 160)}`);
}

const vault2 = mkdtempSync(path.join(tmpdir(), 'vws-cfg-'));
try {
  await expectExit('refuses to start without MARK_VALUES',
    { VAULT_PATH: vault2, WRITE_ROOTS: '*' }, 'MARK_VALUES env var is required');
  await expectExit("refuses 'x' as a configured mark",
    { VAULT_PATH: vault2, WRITE_ROOTS: '*', MARK_VALUES: '/,x' }, "final confirmation");
  await expectExit('refuses a multi-character mark',
    { VAULT_PATH: vault2, WRITE_ROOTS: '*', MARK_VALUES: '//' }, 'single characters');

  // no DELETE_ROOTS -> no delete tool at all (absence visible in tools/list)
  const s = startServer(SERVER, { VAULT_PATH: vault2, WRITE_ROOTS: '*', MARK_VALUES: '/' });
  await new Promise(r => setTimeout(r, 300));
  const l = await s.rpc('tools/list', {});
  const n = (l.result?.tools || []).map(t => t.name);
  check('without DELETE_ROOTS the delete tool is not registered', !n.includes('vault_delete'), n.join(','));
  const call = await s.callTool('vault_delete', { path: 'anything' });
  check('  ... and calling it is an unknown tool', call.isError && call.text.includes('unknown tool'), call.text);
  const single = await s.callTool('todo_mark', { file: 'x.md', line: 1 });
  check('with one configured mark, mark may be omitted (fails later on the missing file)',
    single.isError && !single.text.includes('mark is required'), single.text);
  s.kill();
} finally {
  rmSync(vault2, { recursive: true, force: true });
}

process.exit(summary('vault-workspace-mcp smoke'));
