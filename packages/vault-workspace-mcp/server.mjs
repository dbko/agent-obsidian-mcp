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
//   vault_write(file, content, mode?)                        -> scoped create / atomic replace / append
//   vault_delete(path, recursive?)                           -> scoped exact or rooted removal
//   todo_query(folder?, limit?)                              -> open selector matches + source fingerprint
//   todo_transition(...)                                     -> Gate-only conditional mark + work/result record
//   (v0.2: workspace_lock_* removed — duplicate detection is the prepare gate's job;
//    vault_write enforces WRITE_ROOTS — the machine write wall lives here, not in hooks)
//
// Config (env): VAULT_PATH · READ_ROOTS · READ_DENIES · WRITE_ROOTS/WRITE_PATHS ·
//               DELETE_ROOTS/DELETE_PATHS · TODO_SELECTOR · TODO_MARKS · TODO_WRITE.
// Node built-ins only. stdout is reserved for JSON-RPC frames; logs go to stderr.
//
// Deliberate boundaries (from the workflow's base rules):
//   - Delete is walled SEPARATELY from write (DELETE_ROOTS ⊆ intent of the work root):
//     the gate needs cleanup (write-probe removal, half-made work folders, failed artifacts),
//     but a write surface is not automatically a delete surface. No DELETE_ROOTS, no tool.
//   - todo_transition writes only configured semantic marks after a unique fingerprint match.
//     '[x]' is user-owned and source edits fail closed.
//   - Transitions cannot resolve lines inside fenced code blocks — examples are not triggers.
//   - vault_search requires a folder scope: full-vault scans are not offered.
//   - Paths are vault-relative; absolute paths and traversal ('..') are rejected, and the
//     resolved real path must stay inside the vault (symlinks cannot tunnel out of a wall).
//   - vault_write / vault_delete cannot touch '.obsidian/' (app config is not a work area).

import { promises as fs } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';

const PROTOCOL = '2025-03-26';
const SERVER_NAME = 'vault-workspace-mcp';
const SERVER_VERSION = '0.4.2';

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

const TASK_RE = /^(\s*)[-*]\s*\[(.)\]\s?(.*)$/; // indent + checkbox char + text

const DEFAULT_READ_DENIES = ['.obsidian', '.trash', '.agents', '.claude', '.codex', '**/.git'];
const TODO_SELECTOR = process.env.TODO_SELECTOR || '#agent/todo';
const TODO_WRITE_ENABLED = process.env.TODO_WRITE === '1';

function parseTodoMarks(raw) {
  if (!raw || !raw.trim())
    throw new Error('TODO_MARKS is required (waiting=~,succeeded=/,failed=!)');
  const out = {};
  for (const entry of raw.split(',')) {
    const [key, value, ...rest] = entry.split('=');
    if (rest.length || !key || value === undefined || value.length !== 1)
      throw new Error(`invalid TODO_MARKS entry: ${entry}`);
    out[key.trim()] = value;
  }
  for (const key of ['waiting', 'succeeded', 'failed'])
    if (!out[key]) throw new Error(`TODO_MARKS is missing ${key}`);
  if (new Set(Object.values(out)).size !== 3)
    throw new Error('TODO_MARKS values must be distinct');
  return out;
}

let TODO_MARKS;
try { TODO_MARKS = parseTodoMarks(process.env.TODO_MARKS); }
catch (e) { log(`FATAL: ${e.message}`); process.exit(1); }
const TODO_MARK_SET = new Set(Object.values(TODO_MARKS));

// --- scopes (walls) ------------------------------------------------------------
function parseRoots(raw) {
  if (!raw || !raw.trim()) return { all: false, roots: [] };
  if (raw.trim() === '*') return { all: true, roots: [] };
  return { all: false, roots: raw.split(',').map((r) => path.normalize(r.trim())).filter(Boolean) };
}

function parsePaths(raw) {
  if (!raw || !raw.trim()) return new Set();
  return new Set(raw.split(',').map((r) => path.normalize(r.trim())).filter(Boolean));
}

const READ = parseRoots(process.env.READ_ROOTS || '.');
const READ_DENIES = (process.env.READ_DENIES || DEFAULT_READ_DENIES.join(','))
  .split(',').map((p) => path.normalize(p.trim())).filter(Boolean);
const WRITE = parseRoots(process.env.WRITE_ROOTS || '');
const WRITE_PATHS = parsePaths(process.env.WRITE_PATHS || '');
const WRITE_ENABLED = WRITE.all || WRITE.roots.length > 0 || WRITE_PATHS.size > 0;
const DELETE = parseRoots(process.env.DELETE_ROOTS || '');
const DELETE_PATHS = parsePaths(process.env.DELETE_PATHS || '');
const DELETE_ENABLED = DELETE.all || DELETE.roots.length > 0 || DELETE_PATHS.size > 0;

const RESERVED_MARKS = new Map([
  [' ', "'[ ]' is the open state — re-opening a todo is the user's"],
  ['x', "'[x]' is the user's final confirmation"],
  ['X', "'[x]' is the user's final confirmation"],
]);
for (const m of TODO_MARK_SET) {
  if (RESERVED_MARKS.has(m)) {
    log(`FATAL: TODO_MARKS may not contain ${JSON.stringify(m)} — ${RESERVED_MARKS.get(m)}.`);
    process.exit(1);
  }
}

function underRoot(relNorm, root) {
  if (root === '.') return true;
  return relNorm === root || relNorm.startsWith(root + path.sep);
}

function matchesDeny(relNorm, pattern) {
  if (pattern.startsWith(`**${path.sep}`))
    return relNorm.split(path.sep).includes(pattern.slice(3));
  return underRoot(relNorm, pattern);
}

function assertReadable(relNorm) {
  if (READ_DENIES.some((p) => matchesDeny(relNorm, p)))
    throw new Error(`read denied — path matches READ_DENIES: ${relNorm}`);
  if (!READ.all && !READ.roots.some((root) => underRoot(relNorm, root)))
    throw new Error(`read denied — outside READ_ROOTS: ${relNorm}`);
}

function assertWritable(relNorm) {
  if (WRITE.all) return;
  if (!WRITE_PATHS.has(relNorm) && !WRITE.roots.some((root) => underRoot(relNorm, root))) {
    log(`write denied (outside WRITE_ROOTS/WRITE_PATHS): ${relNorm}`);
    throw new Error(`write denied — outside WRITE_ROOTS and WRITE_PATHS: ${relNorm}`);
  }
}

// Delete is stricter than write: the target must be strictly INSIDE a root.
// Deleting a root itself would take the work area (or the fleeting area) with it.
function assertDeletable(relNorm) {
  if (DELETE.all) return;
  if (DELETE_PATHS.has(relNorm)) return;
  const root = DELETE.roots.find((r) => underRoot(relNorm, r));
  if (!root) {
    log(`delete denied (outside DELETE_ROOTS/DELETE_PATHS): ${relNorm}`);
    throw new Error(`delete denied — outside DELETE_ROOTS and DELETE_PATHS: ${relNorm}`);
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
    const rel = path.relative(VAULT, full);
    if (e.isDirectory()) {
      let real;
      try { real = await realRel(full, rel); assertReadable(real); }
      catch { continue; }
      await walk(full, acc);
    } else if (e.isFile() && e.name.endsWith('.md')) {
      try { assertReadable(await realRel(full, rel)); acc.push(full); }
      catch { /* denied */ }
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
  assertReadable(await realRel(folderAbs, folderRel));
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
  assertReadable(await realRel(abs, rel));
  const content = await fs.readFile(abs, 'utf8');
  const lines = content.split('\n');
  const total = lines.length;
  const start = Math.max(1, Number(offset) || 1);
  const n = Number(limit) || 0;
  const slice = n > 0 ? lines.slice(start - 1, start - 1 + n) : lines.slice(start - 1);
  return { file: rel, total_lines: total, offset: start, returned_lines: slice.length, text: slice.join('\n') };
}

// --- vault_write --------------------------------------------------------------
async function atomicReplace(abs, content) {
  const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.vault-steward-${process.pid}-${randomBytes(6).toString('hex')}`);
  let fd;
  try {
    fd = await fs.open(tmp, 'wx');
    await fd.writeFile(content, 'utf8');
    await fd.sync();
    await fd.close();
    fd = undefined;
    await fs.rename(tmp, abs);
  } finally {
    if (fd) await fd.close().catch(() => {});
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}

// create: fail if exists · overwrite/append: atomic same-directory replacement.
async function vaultWrite({ file, content, mode = 'create' } = {}) {
  if (typeof content !== 'string') throw new Error('content (string) is required');
  if (!['create', 'overwrite', 'append'].includes(mode)) throw new Error(`unknown mode: ${mode}`);
  const { rel, abs } = resolveRel(file);
  assertWritable(await realRel(abs, rel));
  await fs.mkdir(path.dirname(abs), { recursive: true });
  if (mode === 'create') {
    let fd;
    try {
      fd = await fs.open(abs, 'wx'); // O_EXCL — refuse silent overwrite
      await fd.writeFile(content, 'utf8');
      await fd.close();
      fd = undefined;
    } catch (e) {
      if (e.code === 'EEXIST') throw new Error(`file exists (use mode:"overwrite" or "append"): ${rel}`);
      throw e;
    } finally {
      if (fd) await fd.close().catch(() => {});
    }
  } else if (mode === 'overwrite') {
    await atomicReplace(abs, content);
  } else {
    let prior = '';
    try { prior = await fs.readFile(abs, 'utf8'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    await atomicReplace(abs, prior + content);
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

// --- todo_query / todo_transition ---------------------------------------------
function selectorRegex(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|\\s)${escaped}(?=$|\\s|[.,;:!?()\\[\\]{}])`);
}
const TODO_SELECTOR_RE = selectorRegex(TODO_SELECTOR);

function taskFingerprint(file, line) {
  const normalized = line.replace(/^(\s*[-*]\s*\[).(\]\s?.*)$/, '$1 $2');
  return createHash('sha256').update(`todo-v1\0${file}\0${normalized}`).digest('hex');
}

async function todoQuery({ folder = '', limit = 200 } = {}) {
  const scopeAbs = folder ? resolveRel(folder).abs : VAULT;
  const scopeRel = folder ? resolveRel(folder).rel : '.';
  assertReadable(await realRel(scopeAbs, scopeRel));
  const cap = Math.max(1, Math.min(1000, Number(limit) || 200));
  const files = (await walk(scopeAbs)).sort();
  const rows = [];
  const ambiguous = [];
  let truncated = false;
  for (const f of files) {
    const rel = path.relative(VAULT, f);
    let content;
    try { content = await fs.readFile(f, 'utf8'); } catch { continue; }
    const lines = content.split('\n');
    let inFence = false;
    // Collect the whole file before emitting any of it. An identical todo line
    // repeated in one file hashes to a single fingerprint, and nothing here or
    // in todo_transition can tell those sources apart — so they must be found
    // together. Emitting under the cap first could cut the pair and let the
    // surviving half look unique.
    const hits = [];
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*(```|~~~)/.test(lines[i])) { inFence = !inFence; continue; }
      if (inFence) continue;
      const m = TASK_RE.exec(lines[i]);
      if (!m) continue;
      if (m[2] !== ' ') continue;
      const text = m[3].trim();
      if (!TODO_SELECTOR_RE.test(text)) continue;
      hits.push({ file: rel, line: i + 1, mark: m[2], text, fingerprint: taskFingerprint(rel, lines[i]) });
    }
    const occurrences = new Map();
    for (const h of hits) occurrences.set(h.fingerprint, (occurrences.get(h.fingerprint) || 0) + 1);
    for (const h of hits) {
      // Fail closed here rather than at the end of a run: todo_transition would
      // refuse this source as a conflict at finalize time, after the work is done.
      if (occurrences.get(h.fingerprint) > 1) {
        ambiguous.push({ ...h, reason: 'duplicate_source — an identical todo line appears more than once in this file, so no fingerprint identifies one of them' });
        continue;
      }
      if (rows.length >= cap) { truncated = true; break; }
      rows.push(h);
    }
    if (truncated) break;
  }
  return { count: rows.length, truncated, rows, ambiguous_count: ambiguous.length, ambiguous };
}

function oneLine(value, name) {
  if (typeof value !== 'string' || !value.trim() || /[\r\n]/.test(value))
    throw new Error(`${name} must be a non-empty single line`);
  return value.trim();
}

async function todoTransition({ file, fingerprint, state, work_id, question, work_link, result_link } = {}) {
  if (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint))
    throw new Error('fingerprint must be the sha256 returned by todo_query');
  if (!['waiting', 'succeeded', 'failed'].includes(state))
    throw new Error('state must be waiting, succeeded, or failed');
  work_id = oneLine(work_id, 'work_id');
  // Hangul is allowed: the kernel's default work_id slug is Korean (010 — "한글 허용").
  if (!/^[A-Za-z0-9가-힣-]+$/.test(work_id)) throw new Error('work_id has unsafe characters');
  if (state === 'waiting') {
    question = oneLine(question, 'question');
    work_link = oneLine(work_link, 'work_link');
  } else {
    result_link = oneLine(result_link, 'result_link');
  }
  const { rel, abs } = resolveRel(file);
  assertReadable(await realRel(abs, rel));
  const content = await fs.readFile(abs, 'utf8');
  const lines = content.split('\n');
  const matches = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = TASK_RE.exec(lines[i]);
    if (m && TODO_SELECTOR_RE.test(m[3].trim()) && taskFingerprint(rel, lines[i]) === fingerprint)
      matches.push(i);
  }
  if (matches.length === 0)
    throw new Error('source_conflict — no todo matches this fingerprint; the source line was edited, moved or removed');
  if (matches.length > 1)
    throw new Error(`source_conflict — ${matches.length} identical todo lines share this fingerprint, so none of them can be identified as the source (todo_query reports these as ambiguous)`);
  const idx = matches[0];
  const original = lines[idx];
  const m = TASK_RE.exec(original);
  if (m[2] === 'x' || m[2] === 'X') throw new Error("source_conflict — '[x]' is user-owned");
  const targetMark = TODO_MARKS[state];
  if (m[2] !== ' ' && m[2] !== TODO_MARKS.waiting && m[2] !== targetMark)
    throw new Error(`source_conflict — current mark [${m[2]}] cannot transition to ${state}`);
  const updated = original.replace(/^(\s*[-*]\s*\[).(\].*)$/, `$1${targetMark}$2`);
  lines[idx] = updated;

  const baseIndent = m[1] + '  ';
  const header = `${baseIndent}- Vault Steward: ${work_id}`;
  const headerMatches = [];
  for (let i = 0; i < lines.length; i++) if (lines[i] === header) headerMatches.push(i);
  if (headerMatches.length > 1)
    throw new Error(`source_conflict — found ${headerMatches.length} work blocks for ${work_id}`);
  const oldHeader = headerMatches[0] ?? -1;
  if (oldHeader >= 0) {
    if (oldHeader < idx) throw new Error('source_conflict — work block precedes its todo');
    let end = oldHeader + 1;
    while (end < lines.length && lines[end].startsWith(baseIndent + '  - ')) end++;
    lines.splice(oldHeader, end - oldHeader);
  }
  const block = state === 'waiting'
    ? [header, `${baseIndent}  - 질문: ${question}`, `${baseIndent}  - 작업: ${work_link}`]
    : [header, `${baseIndent}  - 결과: ${result_link}`];
  lines.splice(idx + 1, 0, ...block);

  const next = lines.join('\n');
  if (next === content) return { ok: true, file: rel, line: idx + 1, state, unchanged: true };
  await atomicReplace(abs, next);
  return { ok: true, file: rel, line: idx + 1, state, mark: targetMark, fingerprint };
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
    name: 'todo_query',
    description: `Return only open [ ] todos whose same line contains the exact configured selector token ${JSON.stringify(TODO_SELECTOR)}. Configured marks, other checkbox states, partial tag matches, and fenced examples are excluded. Returns file, line, text, and a stable source fingerprint. Identical todo lines repeated in one file share a fingerprint and cannot be told apart; they are withheld from rows and listed under ambiguous instead.`,
    inputSchema: { type: 'object', properties: {
      folder: { type: 'string', description: 'Vault-relative folder scope (recommended; default: whole vault).' },
      limit: { type: 'number', description: 'Max rows (default 200, cap 1000).' } },
    },
  },
];

if (WRITE_ENABLED) {
  TOOLS.splice(2, 0, {
    name: 'vault_write',
    description: 'Create or atomically replace a Vault-relative file. Access is limited to WRITE_PATHS and WRITE_ROOTS; assignment-scoped workers should receive exact WRITE_PATHS.',
    inputSchema: { type: 'object', properties: {
      file: { type: 'string', description: 'Vault-relative file path.' },
      content: { type: 'string', description: 'Full text to write or append.' },
      mode: { type: 'string', enum: ['create', 'overwrite', 'append'], description: 'Default create.' } },
      required: ['file', 'content'] },
  });
}

if (DELETE_ENABLED) {
  TOOLS.splice(3, 0, {
    name: 'vault_delete',
    description: 'Idempotently remove an exact DELETE_PATHS target or a path strictly inside DELETE_ROOTS. Roots and symlinks are refused; folders require recursive:true.',
    inputSchema: { type: 'object', properties: {
      path: { type: 'string', description: 'Vault-relative file or folder path.' },
      recursive: { type: 'boolean', description: 'Required (true) to remove a folder and its contents.' } },
      required: ['path'] },
  });
}

if (TODO_WRITE_ENABLED) {
  TOOLS.push({
    name: 'todo_transition',
    description: 'Gate-only atomic Todo transition. Re-finds exactly one source by fingerprint, refuses user edits/conflicts, applies the configured waiting/succeeded/failed mark, and records a question/work link or result link.',
    inputSchema: { type: 'object', properties: {
      file: { type: 'string', description: 'Vault-relative source note.' },
      fingerprint: { type: 'string', description: 'sha256 returned by todo_query.' },
      state: { type: 'string', enum: ['waiting', 'succeeded', 'failed'] },
      work_id: { type: 'string' },
      question: { type: 'string', description: 'Required for waiting.' },
      work_link: { type: 'string', description: 'Required for waiting.' },
      result_link: { type: 'string', description: 'Required for succeeded/failed.' } },
      required: ['file', 'fingerprint', 'state', 'work_id'] },
  });
}

const HANDLERS = {
  vault_search: vaultSearch,
  vault_read: vaultRead,
  todo_query: todoQuery,
  ...(WRITE_ENABLED ? { vault_write: vaultWrite } : {}),
  ...(DELETE_ENABLED ? { vault_delete: vaultDelete } : {}),
  ...(TODO_WRITE_ENABLED ? { todo_transition: todoTransition } : {}),
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
log(`  read roots: ${READ.all ? '* (wall disabled)' : READ.roots.join(', ')}; denies: ${READ_DENIES.join(', ')}`);
log(`  write roots: ${WRITE.all ? '* (wall disabled)' : WRITE.roots.join(', ')}`);
log(`  write paths: ${[...WRITE_PATHS].join(', ') || 'none'}`);
log(`  delete roots: ${DELETE_ENABLED ? (DELETE.all ? '* (wall disabled)' : DELETE.roots.join(', ')) : 'none — vault_delete not registered'}`);
log(`  delete paths: ${[...DELETE_PATHS].join(', ') || 'none'}`);
log(`  todo selector: ${TODO_SELECTOR}; marks: ${JSON.stringify(TODO_MARKS)}; transition: ${TODO_WRITE_ENABLED ? 'enabled' : 'disabled'}`);
