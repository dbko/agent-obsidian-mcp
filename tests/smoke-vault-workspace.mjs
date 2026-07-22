// tests/smoke-vault-workspace.mjs — end-to-end smoke over a temp fixture vault.
// Covers all 7 tools + the deliberate boundaries (no delete, folder-required search,
// '/'-only marking, path traversal rejection, .obsidian write rejection, lock mutex).

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, check, summary } from '../shared/smoke-client.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(here, '..', 'packages', 'vault-workspace-mcp', 'server.mjs');

// --- fixture vault -----------------------------------------------------------
const vault = mkdtempSync(path.join(tmpdir(), 'vws-smoke-'));
mkdirSync(path.join(vault, 'initiatives'), { recursive: true });
mkdirSync(path.join(vault, '.obsidian'), { recursive: true });
writeFileSync(path.join(vault, 'initiatives', 'sub-a.md'), [
  '# Sub A',
  '- [ ] 수집 작업 하나 #agent/todo',
  '- [x] 끝난 일 #agent/todo',
  '- [ ] 태그 없는 일',
  '```',
  '- [ ] 예시 속 가짜 트리거 #agent/todo',
  '```',
  '본문에 검색어 NEEDLE 이 있음',
].join('\n'));
writeFileSync(path.join(vault, 'initiatives', 'sub-b.md'), '# Sub B\n- [/] 이미 처리된 일 #agent/todo\n');

const srv = startServer(SERVER, { VAULT_PATH: vault });
await new Promise(r => setTimeout(r, 300));

try {
  // initialize / tools list
  const init = await srv.rpc('initialize', { protocolVersion: '2025-03-26' });
  check('initialize', init.result?.serverInfo?.name === 'vault-workspace-mcp');
  const list = await srv.rpc('tools/list', {});
  const names = (list.result?.tools || []).map(t => t.name).sort();
  check('tool surface = 7 canonical tools',
    JSON.stringify(names) === JSON.stringify(['todo_mark', 'todo_query', 'vault_read', 'vault_search', 'vault_write', 'workspace_lock_acquire', 'workspace_lock_release'].sort()),
    names.join(','));

  // todo_query: open only, fence skipped, file·line returned
  let r = await srv.callTool('todo_query', { folder: 'initiatives' });
  check('todo_query finds exactly 1 open tagged todo', r.data?.count === 1, JSON.stringify(r.data?.rows));
  check('todo_query returns file·line', r.data?.rows?.[0]?.file === path.join('initiatives', 'sub-a.md') && r.data?.rows?.[0]?.line === 2);
  r = await srv.callTool('todo_query', { folder: 'initiatives', status: 'agent_finished' });
  check('todo_query [/]=agent_finished', r.data?.count === 1);

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

  // todo_mark: '/'-only semantics + idempotency
  r = await srv.callTool('todo_mark', { file: 'initiatives/sub-a.md', line: 2 });
  check('todo_mark sets [/]', r.data?.ok === true && r.data?.new?.includes('[/]'));
  r = await srv.callTool('todo_mark', { file: 'initiatives/sub-a.md', line: 2 });
  check('todo_mark is idempotent', r.data?.unchanged === true);
  r = await srv.callTool('todo_mark', { file: 'initiatives/sub-a.md', line: 8 });
  check('todo_mark refuses non-checkbox line', r.data?.ok === false);

  // locks: mutex + owner check + release
  r = await srv.callTool('workspace_lock_acquire', { session_id: 'alpha' });
  check('lock acquire', r.data?.ok === true);
  r = await srv.callTool('workspace_lock_acquire', { session_id: 'beta' });
  check('second acquire blocked with holder info', r.data?.ok === false && r.data?.holder === 'alpha');
  r = await srv.callTool('workspace_lock_release', { session_id: 'beta' });
  check('non-owner release refused', r.data?.ok === false && r.data?.error === 'not_owner');
  r = await srv.callTool('workspace_lock_release', { session_id: 'alpha' });
  check('owner release', r.data?.ok === true);

  // no delete surface at all
  r = await srv.callTool('vault_delete', { file: 'work/w-1/note.md' });
  check('no delete tool exists', r.isError);
} finally {
  srv.kill();
  rmSync(vault, { recursive: true, force: true });
}

process.exit(summary('vault-workspace-mcp smoke'));
