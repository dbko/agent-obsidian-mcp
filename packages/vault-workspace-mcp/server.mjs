#!/usr/bin/env node
// vault-workspace-mcp — zero-dependency stdio MCP server for agent work in an Obsidian vault.
//
// Extracted from a prior internal tool: ONLY the Todo / workspace file I/O surface.
// All scoring, round-recording, and citation-gate functions of the predecessor are
// intentionally absent — verdicts and state transitions belong to the gate core, not to tools.
//
// Tools (canonical names per workflow capability registry):
//   vault_search(folder, query?, name_pattern?, limit?)      -> matching lines / files (folder scope REQUIRED)
//   vault_read(file, offset?, limit?)                        -> file content (paged)
//   vault_write(file, content, mode?)                        -> create / overwrite / append (walled by WRITE_ROOTS)
//   vault_delete(path, recursive?)                           -> remove under DELETE_ROOTS (absent if unconfigured)
//   todo_query(folder?, tag?, status?, limit?)               -> task lines [{file,line,status,mark,text}]
//   todo_mark(file, line, mark?)                             -> set checkbox to one of MARK_VALUES
//   (v0.2: workspace_lock_* removed — duplicate detection is the prepare gate's job;
//    vault_write enforces WRITE_ROOTS — the machine write wall lives here, not in hooks)
//
// Config (env): VAULT_PATH (required, absolute) · WRITE_ROOTS (required) ·
//               MARK_VALUES (required) · DELETE_ROOTS (optional — no value, no delete tool).
// Node built-ins only. stdout is reserved for JSON-RPC frames; logs go to stderr.
//
// Deliberate boundaries (from the workflow's base rules):
//   - Delete is walled SEPARATELY from write (DELETE_ROOTS ⊆ intent of the work root):
//     the gate needs cleanup (write-probe removal, half-made work folders, failed artifacts),
//     but a write surface is not automatically a delete surface. No DELETE_ROOTS, no tool.
//   - todo_mark writes only MARK_VALUES — the agent-processing-finished marks decided at
//     install (one per outcome). '[x]' and '[ ]' are user-only: the final confirmation and
//     the re-open are the user's, so they are refused unconditionally, not by config.
//   - Marks are refused on lines inside fenced code blocks — example todos in policy notes
//     are not real triggers (todo_query already skips them; todo_mark agrees).
//   - vault_search requires a folder scope: full-vault scans are not offered.
//   - Paths are vault-relative; absolute paths and traversal ('..') are rejected, and the
//     resolved real path must stay inside the vault (symlinks cannot tunnel out of a wall).
//   - vault_write / vault_delete cannot touch '.obsidian/' (app config is not a work area).

import { promises as fs } from 'node:fs';
import path from 'node:path';

const PROTOCOL = '2025-03-26';
const SERVER_NAME = 'vault-workspace-mcp';
const SERVER_VERSION = '0.3.0';

const log = (...a) => process.stderr.write(a.join(' ') + '\n');

const VAULT = process.env.VAULT_PATH;
if (!VAULT || !path.isAbsolute(VAULT)) {
  log('FATAL: VAULT_PATH env var is required and must be an absolute path to the vault root.');
  process.exit(1);
}
// The vault itself may sit under a symlinked ancestor — compare real paths, not declared ones.
const VAULT_REAL = await fs.realpath(VAULT).catch(() => {
  log(`FATAL: VAULT_PATH does not resolve: ${VAULT}`);
  process.exit(1);
});

const SKIP_DIRS = new Set(['.obsidian', '.trash', '.git', 'node_modules']);
const TASK_RE = /^\s*[-*]\s*\[(.)\]\s?(.*)$/; // checkbox char + text

// --- roots (walls) -------------------------------------------------------------
// Comma-separated vault-relative folders. '*' disables a wall (tests only).
function parseRoots(raw) {
  if (raw.trim() === '*') return { all: true, roots: [] };
  return { all: false, roots: raw.split(',').map((r) => path.normalize(r.trim())).filter(Boolean) };
}

// WRITE_ROOTS: the fixed write surface (fleeting root + work root). REQUIRED — this
// server IS the wall since v0.2 (hooks are gone).
const WRITE_ROOTS_RAW = process.env.WRITE_ROOTS;
if (!WRITE_ROOTS_RAW || !WRITE_ROOTS_RAW.trim()) {
  log('FATAL: WRITE_ROOTS env var is required (comma-separated vault-relative write roots, or "*" for tests).');
  process.exit(1);
}
const WRITE = parseRoots(WRITE_ROOTS_RAW);

// DELETE_ROOTS: OPTIONAL and separate. Unset means this deployment has no delete
// surface at all — the tool is not registered, so its absence is visible in tools/list
// instead of surfacing as a runtime error on every call.
const DELETE_ROOTS_RAW = process.env.DELETE_ROOTS || '';
const DELETE_ENABLED = Boolean(DELETE_ROOTS_RAW.trim());
const DELETE = DELETE_ENABLED ? parseRoots(DELETE_ROOTS_RAW) : { all: false, roots: [] };

// MARK_VALUES: the agent-processing-finished checkbox chars decided at install — one per
// outcome (accepted / failed). REQUIRED: a silent single-value default would let a
// deployment close both outcomes with the same mark and never notice.
// '[x]' (user's final confirmation) and '[ ]' (re-open) are refused here, not by config.
const RESERVED_MARKS = new Map([
  [' ', "'[ ]' is the open state — re-opening a todo is the user's"],
  ['x', "'[x]' is the user's final confirmation"],
  ['X', "'[x]' is the user's final confirmation"],
]);
const MARK_VALUES_RAW = process.env.MARK_VALUES;
if (!MARK_VALUES_RAW || !MARK_VALUES_RAW.trim()) {
  log('FATAL: MARK_VALUES env var is required (comma-separated checkbox chars, one per outcome — e.g. "/,!").');
  process.exit(1);
}
const MARK_VALUES = MARK_VALUES_RAW.split(',').map((m) => m.trim()).filter(Boolean);
for (const m of MARK_VALUES) {
  if (m.length !== 1) {
    log(`FATAL: MARK_VALUES entries must be single characters: ${JSON.stringify(m)}`);
    process.exit(1);
  }
  if (RESERVED_MARKS.has(m)) {
    log(`FATAL: MARK_VALUES may not contain ${JSON.stringify(m)} — ${RESERVED_MARKS.get(m)}.`);
    process.exit(1);
  }
}
const MARK_SET = new Set(MARK_VALUES);

function underRoot(relNorm, root) {
  return relNorm === root || relNorm.startsWith(root + path.sep);
}

function assertWritable(relNorm) {
  if (WRITE.all) return;
  if (!WRITE.roots.some((root) => underRoot(relNorm, root))) {
    log(`write denied (outside WRITE_ROOTS): ${relNorm}`);
    throw new Error(`write denied — outside the write surface (WRITE_ROOTS): ${relNorm}`);
  }
}

// Delete is stricter than write: the target must be strictly INSIDE a root.
// Deleting a root itself would take the work area (or the fleeting area) with it.
function assertDeletable(relNorm) {
  if (DELETE.all) return;
  const root = DELETE.roots.find((r) => underRoot(relNorm, r));
  if (!root) {
    log(`delete denied (outside DELETE_ROOTS): ${relNorm}`);
    throw new Error(`delete denied — outside the delete surface (DELETE_ROOTS): ${relNorm}`);
  }
  if (relNorm === root) throw new Error(`delete denied — this is a delete root itself: ${relNorm}`);
}

// --- path safety -------------------------------------------------------------
// All tool paths are vault-relative. Reject absolute paths and traversal.
function resolveRel(rel, { allowObsidian = false } = {}) {
  if (typeof rel !== 'string' || !rel.trim()) throw new Error('path is required (vault-relative)');
  if (path.isAbsolute(rel)) throw new Error(`absolute paths are not accepted: ${rel}`);
  const norm = path.normalize(rel);
  if (norm.startsWith('..')) throw new Error(`path escapes the vault: ${rel}`);
  if (!allowObsidian && (norm === '.obsidian' || norm.startsWith('.obsidian' + path.sep)))
    throw new Error(`'.obsidian/' is not a work area: ${rel}`);
  return { rel: norm, abs: path.join(VAULT, norm) };
}

// String prefixes alone do not make a wall: a symlink inside a root can point anywhere.
// Resolve the deepest EXISTING ancestor, re-attach the not-yet-created tail, and return
// the real vault-relative path — the roots are then checked against that.
async function realRel(abs, declaredRel) {
  let probe = abs;
  for (;;) {
    let real;
    try {
      real = await fs.realpath(probe);
    } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e;
      const parent = path.dirname(probe);
      if (parent === probe) throw new Error(`cannot resolve path: ${declaredRel}`);
      probe = parent;
      continue;
    }
    const tail = path.relative(probe, abs);
    const realFull = tail ? path.join(real, tail) : real;
    const rel = path.relative(VAULT_REAL, realFull);
    if (rel.startsWith('..') || path.isAbsolute(rel))
      throw new Error(`path escapes the vault through a link: ${declaredRel}`);
    return rel;
  }
}

// --- walk (folder-scoped) -----------------------------------------------------
async function walk(dirAbs, acc = []) {
  let entries;
  try { entries = await fs.readdir(dirAbs, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    const full = path.join(dirAbs, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      await walk(full, acc);
    } else if (e.isFile() && e.name.endsWith('.md')) {
      acc.push(full);
    }
  }
  return acc;
}

// --- vault_search ------------------------------------------------------------
// Folder scope is REQUIRED (base rule: searches are always folder-scoped).
async function vaultSearch({ folder, query = '', name_pattern = '', limit = 100 } = {}) {
  if (typeof folder !== 'string' || !folder.trim())
    throw new Error('folder is required — full-vault search is not offered (scope your search)');
  const { rel: folderRel, abs: folderAbs } = resolveRel(folder);
  const cap = Math.max(1, Math.min(500, Number(limit) || 100));
  let nameRe = null;
  if (name_pattern) {
    // glob-lite: * -> .*, ? -> . (anchored, case-insensitive)
    const esc = name_pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    nameRe = new RegExp(`^${esc}$`, 'i');
  }
  const files = (await walk(folderAbs)).sort();
  const fileHits = [];
  const lineHits = [];
  let truncated = false;
  for (const f of files) {
    const rel = path.relative(VAULT, f);
    if (nameRe && !nameRe.test(path.basename(f))) continue;
    if (!query) {
      fileHits.push(rel);
      if (fileHits.length >= cap) { truncated = true; break; }
      continue;
    }
    let content;
    try { content = await fs.readFile(f, 'utf8'); } catch { continue; }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].includes(query)) continue;
      lineHits.push({ file: rel, line: i + 1, text: lines[i].trim().slice(0, 300) });
      if (lineHits.length >= cap) { truncated = true; break; }
    }
    if (truncated) break;
  }
  return query
    ? { folder: folderRel, query, count: lineHits.length, truncated, matches: lineHits }
    : { folder: folderRel, count: fileHits.length, truncated, files: fileHits };
}

// --- vault_read ---------------------------------------------------------------
async function vaultRead({ file, offset = 1, limit = 0 } = {}) {
  const { rel, abs } = resolveRel(file);
  const content = await fs.readFile(abs, 'utf8');
  const lines = content.split('\n');
  const total = lines.length;
  const start = Math.max(1, Number(offset) || 1);
  const n = Number(limit) || 0;
  const slice = n > 0 ? lines.slice(start - 1, start - 1 + n) : lines.slice(start - 1);
  return { file: rel, total_lines: total, offset: start, returned_lines: slice.length, text: slice.join('\n') };
}

// --- vault_write --------------------------------------------------------------
// create: fail if exists · overwrite: replace · append: add to end (creates if missing).
// Parent folders are created. No delete surface exists in this server.
async function vaultWrite({ file, content, mode = 'create' } = {}) {
  if (typeof content !== 'string') throw new Error('content (string) is required');
  if (!['create', 'overwrite', 'append'].includes(mode)) throw new Error(`unknown mode: ${mode}`);
  const { rel, abs } = resolveRel(file);
  assertWritable(await realRel(abs, rel));
  await fs.mkdir(path.dirname(abs), { recursive: true });
  if (mode === 'create') {
    try {
      const fd = await fs.open(abs, 'wx'); // O_EXCL — refuse silent overwrite
      await fd.writeFile(content, 'utf8');
      await fd.close();
    } catch (e) {
      if (e.code === 'EEXIST') throw new Error(`file exists (use mode:"overwrite" or "append"): ${rel}`);
      throw e;
    }
  } else if (mode === 'overwrite') {
    await fs.writeFile(abs, content, 'utf8');
  } else {
    await fs.appendFile(abs, content, 'utf8');
  }
  return { ok: true, file: rel, mode, bytes: Buffer.byteLength(content, 'utf8') };
}

// --- vault_delete ---------------------------------------------------------------
// Cleanup surface for the gates: the write-probe the prepare gate removes immediately,
// a half-made work folder (left behind, it would block its source as duplicate forever),
// and failed artifacts inside a work folder. Walled by DELETE_ROOTS, absent without it.
// Idempotent: a missing target is the desired end state, not an error.
async function countEntries(abs) {
  let n = 1;
  let entries;
  try { entries = await fs.readdir(abs, { withFileTypes: true }); } catch { return n; }
  for (const e of entries) n += e.isDirectory() ? await countEntries(path.join(abs, e.name)) : 1;
  return n;
}

async function vaultDelete({ path: target, recursive = false } = {}) {
  const { rel, abs } = resolveRel(target);
  assertDeletable(await realRel(abs, rel));
  let st;
  try {
    st = await fs.lstat(abs);
  } catch (e) {
    if (e.code === 'ENOENT') return { ok: true, path: rel, unchanged: true, reason: 'already absent' };
    throw e;
  }
  // A symlink inside the work area is anomalous — removing it is not what a cleanup means,
  // and following it would act outside the wall. Refuse and let a human look.
  if (st.isSymbolicLink()) throw new Error(`delete denied — target is a symlink: ${rel}`);
  if (st.isDirectory()) {
    if (recursive !== true)
      throw new Error(`target is a folder — pass recursive:true to remove it and its contents: ${rel}`);
    const removed = await countEntries(abs);
    await fs.rm(abs, { recursive: true, force: true });
    return { ok: true, path: rel, kind: 'folder', recursive: true, removed_entries: removed };
  }
  await fs.rm(abs, { force: true });
  return { ok: true, path: rel, kind: 'file', bytes: st.size };
}

// --- todo_query ---------------------------------------------------------------
// [ ]=open · [x]/[X]=done · MARK_VALUES=agent_finished (processing finished — never
// re-triggered) · anything else=in_progress.
// The agent-finished marks come from config, so a `status:"open"` query never returns a
// todo this deployment has already closed — the source of infinite re-discovery.
// Fenced code blocks are skipped: example todos inside policy/example notes are not real candidates.
function classify(ch) {
  if (ch === ' ') return 'open';
  if (ch === 'x' || ch === 'X') return 'done';
  if (MARK_SET.has(ch)) return 'agent_finished';
  return 'in_progress';
}

async function todoQuery({ folder = '', tag = '#agent/todo', status = 'open', limit = 200 } = {}) {
  const scopeAbs = folder ? resolveRel(folder).abs : VAULT;
  const cap = Math.max(1, Math.min(1000, Number(limit) || 200));
  const files = (await walk(scopeAbs)).sort();
  const rows = [];
  let truncated = false;
  for (const f of files) {
    const rel = path.relative(VAULT, f);
    let content;
    try { content = await fs.readFile(f, 'utf8'); } catch { continue; }
    const lines = content.split('\n');
    let inFence = false;
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*(```|~~~)/.test(lines[i])) { inFence = !inFence; continue; }
      if (inFence) continue;
      const m = TASK_RE.exec(lines[i]);
      if (!m) continue;
      const st = classify(m[1]);
      if (status !== 'all' && st !== status) continue;
      const text = m[2].trim();
      if (tag && !text.includes(tag)) continue; // same-line co-occurrence (precise)
      rows.push({ file: rel, line: i + 1, status: st, mark: m[1], text });
      if (rows.length >= cap) { truncated = true; break; }
    }
    if (truncated) break;
  }
  return { count: rows.length, truncated, rows };
}

// --- todo_mark ----------------------------------------------------------------
// Sets a checkbox to one of MARK_VALUES (the agent-processing-finished marks, applied by
// gates — one per outcome). '[x]' and '[ ]' are the user's and are never writable here.
// Marking is deliberately NOT walled by WRITE_ROOTS: todos live wherever the user keeps
// them. The wall here is the operation itself — one character, from a fixed set.
async function todoMark({ file, line, mark } = {}) {
  if (!line || typeof line !== 'number') throw new Error('line (1-indexed number) is required');
  if (mark === undefined || mark === null) {
    if (MARK_VALUES.length > 1)
      throw new Error(`mark is required — this deployment has several: ${MARK_VALUES.join(', ')}`);
    mark = MARK_VALUES[0];
  }
  if (typeof mark !== 'string' || !MARK_SET.has(mark)) {
    const why = RESERVED_MARKS.get(mark);
    throw new Error(
      why
        ? `mark ${JSON.stringify(mark)} is refused — ${why}.`
        : `unknown mark ${JSON.stringify(mark)} — allowed: ${MARK_VALUES.join(', ')}`,
    );
  }
  const { rel, abs } = resolveRel(file);
  const content = await fs.readFile(abs, 'utf8');
  const lines = content.split('\n');
  const idx = line - 1;
  if (idx < 0 || idx >= lines.length)
    return { ok: false, error: `line ${line} out of range (file has ${lines.length} lines)` };
  // A line inside a fenced block is an example, not a trigger — todo_query skips those,
  // so a line number that reaches here pointing into a fence did not come from a query.
  let inFence = false;
  for (let i = 0; i < idx; i++) if (/^\s*(```|~~~)/.test(lines[i])) inFence = !inFence;
  if (inFence)
    return { ok: false, error: 'line is inside a fenced code block (an example, not a trigger)', line: lines[idx].trim() };
  const original = lines[idx];
  const m = TASK_RE.exec(original);
  if (!m) return { ok: false, error: 'line does not contain a checkbox', line: original.trim() };
  // The user's final confirmation is not ours to undo.
  if (m[1] === 'x' || m[1] === 'X')
    return { ok: false, error: "line is already '[x]' — the user's final confirmation is not overwritten", line: original.trim() };
  if (m[1] === mark) return { ok: true, file: rel, line, mark, unchanged: true, text: original.trim() }; // idempotent
  const updated = original.replace(/^(\s*[-*]\s*\[)(.)(\].*)$/, `$1${mark}$3`);
  lines[idx] = updated;
  await fs.writeFile(abs, lines.join('\n'), 'utf8');
  return { ok: true, file: rel, line, mark, old: original.trim(), new: updated.trim() };
}

// --- MCP tool registry --------------------------------------------------------
const TOOLS = [
  {
    name: 'vault_search',
    description: 'Search markdown files under a REQUIRED folder scope (full-vault search is not offered). With query: returns matching lines [{file,line,text}]. Without query: lists .md files. name_pattern is a glob for file names (e.g. "*.md", "plan*").',
    inputSchema: { type: 'object', properties: {
      folder: { type: 'string', description: 'Vault-relative folder to search under (required).' },
      query: { type: 'string', description: 'Substring to find in file content. Omit to list files.' },
      name_pattern: { type: 'string', description: 'Glob filter for file names (* and ?).' },
      limit: { type: 'number', description: 'Max results (default 100, cap 500).' } },
      required: ['folder'] },
  },
  {
    name: 'vault_read',
    description: 'Read a markdown/text file by vault-relative path, with optional line offset/limit paging. Returns { file, total_lines, offset, returned_lines, text }.',
    inputSchema: { type: 'object', properties: {
      file: { type: 'string', description: 'Vault-relative file path.' },
      offset: { type: 'number', description: '1-indexed start line (default 1).' },
      limit: { type: 'number', description: 'Number of lines to return (default: to end of file).' } },
      required: ['file'] },
  },
  {
    name: 'vault_write',
    description: 'Write a file by vault-relative path. mode "create" (default, fails if the file exists), "overwrite", or "append". Parent folders are created. Walled: writes outside WRITE_ROOTS are refused, and ".obsidian/" is rejected.',
    inputSchema: { type: 'object', properties: {
      file: { type: 'string', description: 'Vault-relative file path.' },
      content: { type: 'string', description: 'Full text to write (or to append).' },
      mode: { type: 'string', enum: ['create', 'overwrite', 'append'], description: 'Default "create".' } },
      required: ['file', 'content'] },
  },
  {
    name: 'todo_query',
    description: `Find checkbox task lines, precisely and token-cheaply (returns only matching lines, never whole notes). Filters: folder scope, same-line tag (default "#agent/todo"), status: open ([ ]) / agent_finished (this deployment's marks: ${MARK_VALUES.join(' ')}) / done ([x]) / in_progress / all. A "open" query never returns an already-marked todo. Fenced code blocks are skipped (example todos in policy docs are not candidates). Returns [{file,line,status,mark,text}] — use file·line as the immutable request-source reference.`,
    inputSchema: { type: 'object', properties: {
      folder: { type: 'string', description: 'Vault-relative folder scope (recommended; default: whole vault).' },
      tag: { type: 'string', description: 'Same-line tag filter (default "#agent/todo"; empty string disables).' },
      status: { type: 'string', enum: ['open', 'agent_finished', 'done', 'in_progress', 'all'], description: 'Default "open".' },
      limit: { type: 'number', description: 'Max rows (default 200, cap 1000).' } },
    },
  },
  {
    name: 'todo_mark',
    description: `Set a checkbox line to an agent-processing-finished mark, applied by gates (idempotent: an already-marked line returns unchanged:true). Allowed marks in this deployment: ${MARK_VALUES.join(' ')} — one per outcome. '[x]' (the user's final confirmation) and '[ ]' (re-open) are user-only and cannot be written here, and an already-'[x]' line is refused. Lines inside fenced code blocks are refused.`,
    inputSchema: { type: 'object', properties: {
      file: { type: 'string', description: 'Vault-relative file path.' },
      line: { type: 'number', description: '1-indexed line number of the checkbox (from todo_query).' },
      mark: { type: 'string', enum: MARK_VALUES, description: `The mark to write. Required when several are configured (here: ${MARK_VALUES.join(' ')}).` } },
      required: ['file', 'line'] },
  },
];

if (DELETE_ENABLED) {
  TOOLS.splice(3, 0, {
    name: 'vault_delete',
    description: 'Remove a file or folder by vault-relative path — the gates\' cleanup surface (removing a write probe, a half-made work folder, a failed artifact). Walled separately from writing: only paths strictly inside DELETE_ROOTS, never a root itself. Folders need recursive:true. Idempotent: an absent target returns ok with unchanged:true. Symlinks are refused.',
    inputSchema: { type: 'object', properties: {
      path: { type: 'string', description: 'Vault-relative file or folder path.' },
      recursive: { type: 'boolean', description: 'Required (true) to remove a folder and its contents.' } },
      required: ['path'] },
  });
}

const HANDLERS = {
  vault_search: vaultSearch,
  vault_read: vaultRead,
  vault_write: vaultWrite,
  todo_query: todoQuery,
  todo_mark: todoMark,
  ...(DELETE_ENABLED ? { vault_delete: vaultDelete } : {}),
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
log(`  write roots: ${WRITE.all ? '* (wall disabled)' : WRITE.roots.join(', ')}`);
log(`  delete roots: ${DELETE_ENABLED ? (DELETE.all ? '* (wall disabled)' : DELETE.roots.join(', ')) : 'none — vault_delete not registered'}`);
log(`  marks: ${MARK_VALUES.join(' ')}`);
