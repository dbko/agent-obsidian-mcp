// tests/smoke-vault-workspace.mjs — end-to-end smoke over a temp fixture vault.
// Covers scoped reads/writes/deletes, exact Todo selection, source fingerprints,
// atomic semantic transitions, fenced examples, traversal, and symlink tunnelling.

import { appendFileSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, existsSync } from 'node:fs';
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
mkdirSync(path.join(vault, '.claude'), { recursive: true });
mkdirSync(path.join(vault, 'work'), { recursive: true });
writeFileSync(path.join(vault, '.claude', 'secret.md'), 'must not be readable\n');
writeFileSync(path.join(vault, 'initiatives', 'sub-a.md'), [
  '# Sub A',
  '- [ ] 수집 작업 하나 #agent/todo',
  '- [x] 끝난 일 #agent/todo',
  '- [ ] 태그 없는 일',
  '- [ ] 비슷하지만 다른 태그 #agent/todolist',
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

const ENV = {
  VAULT_PATH: vault,
  READ_ROOTS: '.',
  WRITE_ROOTS: 'fleeting,work',
  DELETE_ROOTS: 'work',
  TODO_SELECTOR: '#agent/todo',
  TODO_MARKS: 'waiting=~,succeeded=/,failed=!',
  TODO_WRITE: '1',
};
const srv = startServer(SERVER, ENV);
await new Promise(r => setTimeout(r, 300));

try {
  // initialize / tools list
  const init = await srv.rpc('initialize', { protocolVersion: '2025-03-26' });
  check('initialize', init.result?.serverInfo?.name === 'vault-workspace-mcp');
  check('version is 0.4.1', init.result?.serverInfo?.version === '0.4.1', init.result?.serverInfo?.version);
  const list = await srv.rpc('tools/list', {});
  const names = (list.result?.tools || []).map(t => t.name).sort();
  check('tool surface = 6 scoped tools',
    JSON.stringify(names) === JSON.stringify(['todo_transition', 'todo_query', 'vault_delete', 'vault_read', 'vault_search', 'vault_write'].sort()),
    names.join(','));

  // todo_query: open only, fence skipped, configured marks excluded from "open"
  let r = await srv.callTool('todo_query', { folder: 'initiatives' });
  check('todo_query finds exactly 2 open tagged todos', r.data?.count === 2, JSON.stringify(r.data?.rows));
  check('todo_query returns file·line·fingerprint', r.data?.rows?.[0]?.file === path.join('initiatives', 'sub-a.md') && r.data?.rows?.[0]?.line === 2 && /^[a-f0-9]{64}$/.test(r.data?.rows?.[0]?.fingerprint || ''));
  const firstTodo = r.data.rows[0];

  // vault_search: folder required; query hits
  r = await srv.callTool('vault_search', {});
  check('vault_search without folder is refused', r.isError, r.text);
  r = await srv.callTool('vault_search', { folder: 'initiatives', query: 'NEEDLE' });
  check('vault_search finds content match', r.data?.count === 1 && r.data?.matches?.[0]?.file.endsWith('sub-a.md'));

  // vault_read paging
  r = await srv.callTool('vault_read', { file: 'initiatives/sub-a.md', offset: 2, limit: 1 });
  check('vault_read paging', r.data?.returned_lines === 1 && r.data?.text.includes('수집 작업'));
  r = await srv.callTool('vault_read', { file: '.claude/secret.md' });
  check('vault_read enforces READ_DENIES on direct reads', r.isError && r.text.includes('READ_DENIES'), r.text);

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
  check('write outside WRITE_ROOTS denied', r.isError && r.text.includes('WRITE_ROOTS'), r.text);
  r = await srv.callTool('vault_write', { file: 'worknote.md', content: 'x' });
  check('prefix trick (worknote vs work/) denied', r.isError, r.text);

  // a symlink under the write root must not tunnel out of the vault
  r = await srv.callTool('vault_write', { file: 'work/tunnel/pwned.md', content: 'x' });
  check('write through an out-of-vault symlink denied', r.isError && r.text.includes('link'), r.text);
  check('  ... and nothing was written outside', !existsSync(path.join(outside, 'pwned.md')));

  // todo_transition: fingerprint lookup, waiting/final states, idempotency, conflict
  r = await srv.callTool('todo_transition', {
    file: firstTodo.file, fingerprint: firstTodo.fingerprint, state: 'waiting', work_id: 'w-test-0001',
    question: '범위를 확인해 주세요', work_link: '[[work/w-test-0001/work.md]]',
  });
  check('todo_transition records waiting state', r.data?.state === 'waiting' && r.data?.mark === '~');
  let todoText = readFileSync(path.join(vault, firstTodo.file), 'utf8');
  check('waiting transition writes question and work link atomically', todoText.includes('[~] 수집 작업') && todoText.includes('질문: 범위를 확인해 주세요') && todoText.includes('작업: [[work/w-test-0001/work.md]]'));
  r = await srv.callTool('todo_transition', {
    file: firstTodo.file, fingerprint: firstTodo.fingerprint, state: 'waiting', work_id: 'w-test-0001',
    question: '범위를 확인해 주세요', work_link: '[[work/w-test-0001/work.md]]',
  });
  check('todo_transition is idempotent', r.data?.unchanged === true);

  appendFileSync(path.join(vault, firstTodo.file), '\n  - Vault Steward: w-test-0001\n    - 결과: [[duplicate]]');
  r = await srv.callTool('todo_transition', {
    file: firstTodo.file, fingerprint: firstTodo.fingerprint, state: 'waiting', work_id: 'w-test-0001',
    question: '범위를 확인해 주세요', work_link: '[[work/w-test-0001/work.md]]',
  });
  check('duplicate work blocks fail closed', r.isError && /source_conflict/.test(r.text), r.text);
  const duplicateFile = readFileSync(path.join(vault, firstTodo.file), 'utf8');
  writeFileSync(path.join(vault, firstTodo.file), duplicateFile.replace(/\n  - Vault Steward: w-test-0001\n    - 결과: \[\[duplicate\]\]$/, ''));
  r = await srv.callTool('todo_query', { folder: 'initiatives' });
  check('waiting todo leaves the Dispatcher query', r.data?.count === 1, JSON.stringify(r.data?.rows));

  // Simulate user input: user owns the reset from [~] to [ ]. The source fingerprint remains stable.
  writeFileSync(path.join(vault, firstTodo.file), todoText.replace('[~] 수집 작업', '[ ] 수집 작업'));
  r = await srv.callTool('todo_transition', {
    file: firstTodo.file, fingerprint: firstTodo.fingerprint, state: 'succeeded', work_id: 'w-test-0001',
    result_link: '[[work/w-test-0001/result.md]]',
  });
  check('succeeded transition uses configured mark', r.data?.state === 'succeeded' && r.data?.mark === '/');
  todoText = readFileSync(path.join(vault, firstTodo.file), 'utf8');
  check('final transition replaces the waiting block with result link', todoText.includes('[/] 수집 작업') && todoText.includes('결과: [[work/w-test-0001/result.md]]') && !todoText.includes('질문:'));

  r = await srv.callTool('todo_query', { folder: 'initiatives' });
  const secondTodo = r.data.rows[0];
  const beforeEdit = readFileSync(path.join(vault, secondTodo.file), 'utf8');
  writeFileSync(path.join(vault, secondTodo.file), beforeEdit.replace('실패로 닫을 일', '사용자가 고친 실패 작업'));
  r = await srv.callTool('todo_transition', {
    file: secondTodo.file, fingerprint: secondTodo.fingerprint, state: 'failed', work_id: 'w-test-0002',
    result_link: '[[work/w-test-0002/work.md]]',
  });
  check('source edit causes source_conflict', r.isError && r.text.includes('source_conflict'), r.text);
  r = await srv.callTool('todo_query', { folder: 'initiatives' });
  const editedTodo = r.data.rows[0];
  r = await srv.callTool('todo_transition', {
    file: editedTodo.file, fingerprint: editedTodo.fingerprint, state: 'failed', work_id: 'w-test-0002',
    result_link: '[[work/w-test-0002/work.md]]',
  });
  check('failed transition uses configured mark', r.data?.state === 'failed' && r.data?.mark === '!');
  r = await srv.callTool('todo_query', { folder: 'initiatives' });
  check('all transitioned todos leave the open set', r.data?.count === 0, JSON.stringify(r.data?.rows));

  // Indistinguishable duplicates: two identical todo lines in one file share a
  // fingerprint, so neither can be closed. They must be withheld up front, not
  // discovered at finalize time. Its own folder — the checks above are scoped.
  mkdirSync(path.join(vault, 'dup'), { recursive: true });
  writeFileSync(path.join(vault, 'dup', 'twins.md'), [
    '# Twins',
    '- [ ] 같은 문장 작업 #agent/todo',
    '- [ ] 구별되는 작업 #agent/todo',
    '- [ ] 같은 문장 작업 #agent/todo',
  ].join('\n'));
  r = await srv.callTool('todo_query', { folder: 'dup' });
  check('duplicate todo lines are withheld from rows', r.data?.count === 1 && r.data?.rows?.[0]?.text.startsWith('구별되는'), JSON.stringify(r.data?.rows));
  check('  ... and reported as ambiguous with a reason', r.data?.ambiguous_count === 2 && /duplicate_source/.test(r.data?.ambiguous?.[0]?.reason || ''), JSON.stringify(r.data?.ambiguous));
  check('  ... the duplicates share one fingerprint', r.data?.ambiguous?.[0]?.fingerprint === r.data?.ambiguous?.[1]?.fingerprint);
  check('  ... and are two distinct lines', r.data?.ambiguous?.[0]?.line === 2 && r.data?.ambiguous?.[1]?.line === 4, JSON.stringify(r.data?.ambiguous));
  r = await srv.callTool('todo_transition', {
    file: path.join('dup', 'twins.md'), fingerprint: r.data.ambiguous[0].fingerprint,
    state: 'succeeded', work_id: 'w-test-0003', result_link: '[[work/w-test-0003/result.md]]',
  });
  check('transitioning an ambiguous source fails closed', r.isError && /source_conflict — 2 identical/.test(r.text), r.text);
  check('  ... and the file is untouched', readFileSync(path.join(vault, 'dup', 'twins.md'), 'utf8').split('[ ]').length === 4);
  r = await srv.callTool('todo_transition', {
    file: path.join('dup', 'twins.md'), fingerprint: 'f'.repeat(64),
    state: 'succeeded', work_id: 'w-test-0004', result_link: '[[work/w-test-0004/result.md]]',
  });
  check('  ... no match reports the edited/moved/removed case', r.isError && /no todo matches this fingerprint/.test(r.text), r.text);

  // vault_delete: the gates' cleanup surface, walled separately
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
    r.isError && r.text.includes('DELETE_ROOTS'), r.text);
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
  await expectExit('refuses to start without TODO_MARKS',
    { VAULT_PATH: vault2, WRITE_ROOTS: '*' }, 'TODO_MARKS is required');
  await expectExit("refuses 'x' as a configured mark",
    { VAULT_PATH: vault2, TODO_MARKS: 'waiting=~,succeeded=x,failed=!' }, "final confirmation");
  await expectExit('refuses a multi-character mark',
    { VAULT_PATH: vault2, TODO_MARKS: 'waiting=~~,succeeded=/,failed=!' }, 'invalid TODO_MARKS');

  // Read-only instance exposes no mutation tools.
  const s = startServer(SERVER, { VAULT_PATH: vault2, TODO_MARKS: 'waiting=~,succeeded=/,failed=!' });
  await new Promise(r => setTimeout(r, 300));
  const l = await s.rpc('tools/list', {});
  const n = (l.result?.tools || []).map(t => t.name);
  check('without DELETE_ROOTS the delete tool is not registered', !n.includes('vault_delete'), n.join(','));
  check('without write scope vault_write is not registered', !n.includes('vault_write'), n.join(','));
  check('without TODO_WRITE todo_transition is not registered', !n.includes('todo_transition'), n.join(','));
  const call = await s.callTool('vault_delete', { path: 'anything' });
  check('  ... and calling it is an unknown tool', call.isError && call.text.includes('unknown tool'), call.text);
  s.kill();

  mkdirSync(path.join(vault2, 'work'), { recursive: true });
  const scoped = startServer(SERVER, {
    VAULT_PATH: vault2, WRITE_PATHS: 'work/exact.md',
    TODO_MARKS: 'waiting=~,succeeded=/,failed=!',
  });
  await new Promise(r => setTimeout(r, 300));
  let q = await scoped.callTool('vault_write', { file: 'work/exact.md', content: 'ok' });
  check('WRITE_PATHS permits the exact assignment path', q.data?.ok === true);
  q = await scoped.callTool('vault_write', { file: 'work/sibling.md', content: 'no' });
  check('WRITE_PATHS denies a sibling path', q.isError && q.text.includes('WRITE_PATHS'), q.text);
  scoped.kill();
} finally {
  rmSync(vault2, { recursive: true, force: true });
}

process.exit(summary('vault-workspace-mcp smoke'));
