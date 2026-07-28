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
//   vault_write(file, content, mode?)                        -> create / overwrite / append (no delete surface)
//   todo_query(folder?, tag?, status?, limit?)               -> task lines [{file,line,status,text}]
//   todo_mark(file, line)                                    -> set checkbox to [/] (agent-processing-finished mark)
//   (v0.2: workspace_lock_* removed — duplicate detection is the prepare gate's job;
//    vault_write enforces WRITE_ROOTS — the machine write wall lives here, not in hooks)
//
// Config: VAULT_PATH env is REQUIRED (absolute path to the vault root). No fallback path.
// Node built-ins only. stdout is reserved for JSON-RPC frames; logs go to stderr.
//
// Deliberate boundaries (from the workflow's base rules):
//   - No delete tool: deletion is user-only, so the surface simply does not exist here.
//   - vault_search requires a folder scope: full-vault scans are not offered.
//   - todo_mark writes only '/': the final [x] belongs to the user, and other states
//     belong to editing flows, not to this minimal marking tool.
//   - Paths are vault-relative; absolute paths and traversal ('..') are rejected.
//   - vault_write cannot touch '.obsidian/' (app config is not a work area).

import { promises as fs } from 'node:fs';
import path from 'node:path';

const PROTOCOL = '2025-03-26';
const SERVER_NAME = 'vault-workspace-mcp';
const SERVER_VERSION = '0.2.0';

const log = (...a) => process.stderr.write(a.join(' ') + '\n');

const VAULT = process.env.VAULT_PATH;
if (!VAULT || !path.isAbsolute(VAULT)) {
  log('FATAL: VAULT_PATH env var is required and must be an absolute path to the vault root.');
  process.exit(1);
}

const SKIP_DIRS = new Set(['.obsidian', '.trash', '.git', 'node_modules']);
const TASK_RE = /^\s*[-*]\s*\[(.)\]\s?(.*)$/; // checkbox char + text
// --- write wall ----------------------------------------------------------------
// WRITE_ROOTS: comma-separated vault-relative folders where vault_write may write
// (the fixed write surface: fleeting root + work root). REQUIRED — this server IS
// the wall since v0.2 (hooks are gone). '*' disables the wall (tests only).
const WRITE_ROOTS_RAW = process.env.WRITE_ROOTS;
if (!WRITE_ROOTS_RAW || !WRITE_ROOTS_RAW.trim()) {
  log('FATAL: WRITE_ROOTS env var is required (comma-separated vault-relative write roots, or "*" for tests).');
  process.exit(1);
}
const WRITE_ALL = WRITE_ROOTS_RAW.trim() === '*';
const WRITE_ROOTS = WRITE_ALL ? [] : WRITE_ROOTS_RAW.split(',').map((r) => path.normalize(r.trim())).filter(Boolean);

function assertWritable(relNorm) {
  if (WRITE_ALL) return;
  const ok = WRITE_ROOTS.some((root) => relNorm === root || relNorm.startsWith(root + path.sep));
  if (!ok) {
    log(`write denied (outside WRITE_ROOTS): ${relNorm}`);
    throw new Error(`write denied — outside the write surface (WRITE_ROOTS): ${relNorm}`);
  }
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
  assertWritable(rel);
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

// --- todo_query ---------------------------------------------------------------
// [ ]=open · [x]/[X]=done · [/]=agent_finished (agent processing finished — never re-triggered) · other=in_progress
// Fenced code blocks are skipped: example todos inside policy/example notes are not real candidates.
function classify(ch) {
  if (ch === ' ') return 'open';
  if (ch === 'x' || ch === 'X') return 'done';
  if (ch === '/') return 'agent_finished';
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
      rows.push({ file: rel, line: i + 1, status: st, text });
      if (rows.length >= cap) { truncated = true; break; }
    }
    if (truncated) break;
  }
  return { count: rows.length, truncated, rows };
}

// --- todo_mark ----------------------------------------------------------------
// Sets a checkbox to '[/]' ONLY (agent-processing-finished mark, applied by gates).
// '[x]' is user-only by workflow rule and is deliberately not writable here.
async function todoMark({ file, line } = {}) {
  if (!line || typeof line !== 'number') throw new Error('line (1-indexed number) is required');
  const { rel, abs } = resolveRel(file);
  const content = await fs.readFile(abs, 'utf8');
  const lines = content.split('\n');
  const idx = line - 1;
  if (idx < 0 || idx >= lines.length)
    return { ok: false, error: `line ${line} out of range (file has ${lines.length} lines)` };
  const original = lines[idx];
  const m = TASK_RE.exec(original);
  if (!m) return { ok: false, error: 'line does not contain a checkbox', line: original.trim() };
  if (m[1] === '/') return { ok: true, file: rel, line, unchanged: true, text: original.trim() }; // idempotent
  const updated = original.replace(/^(\s*[-*]\s*\[)(.)(\].*)$/, `$1/$3`);
  lines[idx] = updated;
  await fs.writeFile(abs, lines.join('\n'), 'utf8');
  return { ok: true, file: rel, line, old: original.trim(), new: updated.trim() };
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
    description: 'Write a file by vault-relative path. mode "create" (default, fails if the file exists), "overwrite", or "append". Parent folders are created. There is NO delete tool in this server — deletion is user-only by workflow rule. ".obsidian/" is rejected.',
    inputSchema: { type: 'object', properties: {
      file: { type: 'string', description: 'Vault-relative file path.' },
      content: { type: 'string', description: 'Full text to write (or to append).' },
      mode: { type: 'string', enum: ['create', 'overwrite', 'append'], description: 'Default "create".' } },
      required: ['file', 'content'] },
  },
  {
    name: 'todo_query',
    description: 'Find checkbox task lines, precisely and token-cheaply (returns only matching lines, never whole notes). Filters: folder scope, same-line tag (default "#agent/todo"), status: open ([ ]) / agent_finished ([/]) / done ([x]) / in_progress / all. Fenced code blocks are skipped (example todos in policy docs are not candidates). Returns [{file,line,status,text}] — use file·line as the immutable request-source reference.',
    inputSchema: { type: 'object', properties: {
      folder: { type: 'string', description: 'Vault-relative folder scope (recommended; default: whole vault).' },
      tag: { type: 'string', description: 'Same-line tag filter (default "#agent/todo"; empty string disables).' },
      status: { type: 'string', enum: ['open', 'agent_finished', 'done', 'in_progress', 'all'], description: 'Default "open".' },
      limit: { type: 'number', description: 'Max rows (default 200, cap 1000).' } },
    },
  },
  {
    name: 'todo_mark',
    description: "Set a checkbox line to '[/]' — the agent-processing-finished mark applied by gates (idempotent: already-[/] lines return unchanged:true). This tool writes ONLY '/'; the final '[x]' is user-only by workflow rule and cannot be written here.",
    inputSchema: { type: 'object', properties: {
      file: { type: 'string', description: 'Vault-relative file path.' },
      line: { type: 'number', description: '1-indexed line number of the checkbox (from todo_query).' } },
      required: ['file', 'line'] },
  },
];

const HANDLERS = {
  vault_search: vaultSearch,
  vault_read: vaultRead,
  vault_write: vaultWrite,
  todo_query: todoQuery,
  todo_mark: todoMark,
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
