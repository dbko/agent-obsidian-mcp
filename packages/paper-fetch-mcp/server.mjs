#!/usr/bin/env node
// paper-fetch-mcp — zero-dependency stdio MCP server: fetch arXiv paper full text (LaTeX math preserved).
//
// Tool (canonical name per workflow capability registry):
//   paper_fulltext_fetch(arxiv_id, include_references?, max_chars?)
//     -> { arxiv_id, source: 'ar5iv'|'pdf', title, chars, truncated, text }
//
// Strategy per call:
//   1. ar5iv HTML (https://ar5iv.labs.arxiv.org/html/{id}) -> text + LaTeX from <math alttext>
//   2. fallback: arXiv PDF (https://arxiv.org/pdf/{id}) -> pdftotext -layout (poppler)
//   -> strip bibliography (unless include_references), cap length.
//
// Runtime dependencies: node >= 18, pdftotext (poppler-utils) for the PDF fallback.
// Node built-ins only. stdout is reserved for JSON-RPC frames; logs go to stderr.

import https from 'node:https';
import { spawn } from 'node:child_process';

const PROTOCOL = '2025-03-26';
const SERVER_NAME = 'paper-fetch-mcp';
const SERVER_VERSION = '0.1.0';
const DEFAULT_MAX_CHARS = 40000;
const HTTP_TIMEOUT_MS = 45000;

const log = (...a) => process.stderr.write(a.join(' ') + '\n');

// --- arxiv id normalize -----------------------------------------------------
// Accepts "2309.16653", "arXiv:2309.16653", "2309.16653v2", full URLs. Strips version suffix.
function normalizeId(raw) {
  if (!raw || typeof raw !== 'string') throw new Error('arxiv_id is required (e.g. "2309.16653")');
  const s = raw.trim();
  const m = s.match(/(\d{4}\.\d{4,5})(v\d+)?/) || s.match(/([a-z\-]+(?:\.[A-Z]{2})?\/\d{7})(v\d+)?/i);
  if (!m) throw new Error(`unrecognized arxiv id: ${raw}`);
  return m[1];
}

// --- HTTP GET with redirect follow (text or binary) -------------------------
function httpGet(url, { binary = false, redirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: HTTP_TIMEOUT_MS, headers: { 'User-Agent': `${SERVER_NAME}/${SERVER_VERSION}` } }, (res) => {
      const { statusCode, headers } = res;
      if (statusCode >= 300 && statusCode < 400 && headers.location && redirects > 0) {
        res.resume();
        const next = new URL(headers.location, url).toString();
        return resolve(httpGet(next, { binary, redirects: redirects - 1 }));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({ status: statusCode, body: binary ? buf : buf.toString('utf8') });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('http timeout')); });
  });
}

// --- HTML entity decode (minimal, for alttext LaTeX + body text) ------------
function decodeEntities(s) {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ' '; } })
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(parseInt(d, 10)); } catch { return ' '; } })
    .replace(/&amp;/g, '&');
}

// --- ar5iv HTML -> clean text (LaTeX math preserved) ------------------------
function ar5ivToText(html) {
  let title = '';
  const th = html.match(/<h1[^>]*ltx_title_document[^>]*>([\s\S]*?)<\/h1>/i)
          || html.match(/<title>([\s\S]*?)<\/title>/i);
  if (th) title = decodeEntities(th[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ')).replace(/\s*\|\s*ar5iv.*$/i, '').trim();

  let s = html;
  const bibIdx = s.search(/<(section|div|ul|ol)[^>]*ltx_bibliography/i);
  if (bibIdx > 0) s = s.slice(0, bibIdx);
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ')
       .replace(/<style[\s\S]*?<\/style>/gi, ' ')
       .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
       // figures dropped EXCEPT tables (ltx_table) — table loss breaks grounding of quantitative claims
       .replace(/<figure(?![^>]*ltx_table)[\s\S]*?<\/figure>/gi, ' ');

  s = s.replace(/<math\b([^>]*)>[\s\S]*?<\/math>/gi, (full, attrs) => {
    const am = attrs.match(/\balttext="([^"]*)"/i);
    if (!am) return ' ';
    const latex = decodeEntities(am[1]).trim();
    if (!latex) return ' ';
    const display = /\bdisplay="block"/i.test(attrs) || /ltx_displaymath/i.test(attrs);
    return display ? ` $$${latex}$$ ` : ` $${latex}$ `.replace(/\$\$/g, '$');
  });

  // ltx_table figure -> markdown table (caption + | cell | rows) — preserves quantitative results
  s = s.replace(/<figure[^>]*ltx_table[\s\S]*?<\/figure>/gi, (block) => {
    const cap = ((block.match(/<figcaption[\s\S]*?<\/figcaption>/i) || [''])[0])
      .replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    const tbl = (block.match(/<table[\s\S]*?<\/table>/i) || [''])[0];
    const rows = [...tbl.matchAll(/<tr[\s\S]*?<\/tr>/gi)].map(r =>
      '| ' + [...r[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)]
        .map(c => c[1].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()).join(' | ') + ' |');
    return '\n' + (cap ? cap + '\n' : '') + rows.join('\n') + '\n';
  });
  s = s.replace(/<\/(p|div|section|li|tr|h[1-6]|table|figcaption)>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  s = s.replace(/[ \t\f\v]+/g, ' ')
       .replace(/ *\n */g, '\n')
       .replace(/\n{3,}/g, '\n\n')
       .trim();
  return { title, text: s };
}

// --- PDF -> text via pdftotext (stdin->stdout, no temp file) -----------------
function pdftotext(pdfBuffer) {
  return new Promise((resolve, reject) => {
    const p = spawn('pdftotext', ['-layout', '-', '-']);
    const out = [], err = [];
    p.stdout.on('data', (c) => out.push(c));
    p.stderr.on('data', (c) => err.push(c));
    p.on('error', (e) => reject(new Error(`pdftotext spawn failed: ${e.message} (poppler-utils installed?)`)));
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(`pdftotext exit ${code}: ${Buffer.concat(err).toString().slice(0, 200)}`));
      resolve(Buffer.concat(out).toString('utf8'));
    });
    p.stdin.on('error', () => {});
    p.stdin.write(pdfBuffer);
    p.stdin.end();
  });
}

// strip a bibliography tail from plain text (pdf path — best-effort)
function stripReferences(text) {
  const re = /\n\s*(references|bibliography)\s*\n/gi;
  let last = -1, m;
  while ((m = re.exec(text)) !== null) last = m.index;
  return last > text.length * 0.4 ? text.slice(0, last).trimEnd() : text;
}

async function paperFulltextFetch({ arxiv_id, include_references = false, max_chars = DEFAULT_MAX_CHARS } = {}) {
  const id = normalizeId(arxiv_id);
  const cap = Math.max(2000, Math.min(120000, Number(max_chars) || DEFAULT_MAX_CHARS));
  let source, title = '', text = '';

  try {
    const r = await httpGet(`https://ar5iv.labs.arxiv.org/html/${id}`);
    if (r.status === 200 && r.body && /<math|ltx_page_content|ltx_document/i.test(r.body)) {
      const parsed = ar5ivToText(r.body);
      if (parsed.text && parsed.text.length > 500) { source = 'ar5iv'; title = parsed.title; text = parsed.text; }
    }
  } catch (e) { log('ar5iv failed:', e.message); }

  if (!text) {
    try {
      const r = await httpGet(`https://arxiv.org/pdf/${id}`, { binary: true });
      if (r.status === 200 && r.body && r.body.length > 1000) {
        let t = await pdftotext(r.body);
        if (!include_references) t = stripReferences(t);
        t = t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
        if (t.length > 300) { source = 'pdf'; text = t; }
      }
    } catch (e) { log('pdf fallback failed:', e.message); }
  }

  if (!text) throw new Error(`could not fetch ${id} from ar5iv or arxiv PDF (check the id / network)`);

  let truncated = false;
  if (text.length > cap) { text = text.slice(0, cap); truncated = true; }

  return { arxiv_id: id, source, title, chars: text.length, truncated, text };
}

// --- MCP tool registry ------------------------------------------------------
const TOOLS = [
  {
    name: 'paper_fulltext_fetch',
    description: "Fetch an arXiv paper's full text with LaTeX math preserved, for grounded per-paper reading. Tries ar5iv HTML first (math kept as $…$ from alttext), falls back to arXiv PDF via pdftotext. No API key, no rate limit — arXiv is the source. Bibliography stripped by default; length capped (default 40000 chars). Returns { arxiv_id, source: 'ar5iv'|'pdf', title, chars, truncated, text }. Figures are NOT included (text-only). IMPORTANT: verify the returned title matches your target paper — a mismatch means the arxiv_id was wrong; re-resolve via bibliographic search and retry.",
    inputSchema: {
      type: 'object',
      properties: {
        arxiv_id: { type: 'string', description: 'arXiv id, e.g. "2309.16653" (version suffix / arXiv: prefix / full URL all accepted).' },
        include_references: { type: 'boolean', description: 'Keep the bibliography section (default false — dropped to save context).' },
        max_chars: { type: 'number', description: 'Max characters returned (default 40000, min 2000, max 120000). Text beyond the cap is truncated with truncated=true.' },
      },
      required: ['arxiv_id'],
    },
  },
];

async function callTool(name, args) {
  if (name === 'paper_fulltext_fetch') return await paperFulltextFetch(args || {});
  throw new Error(`unknown tool: ${name}`);
}

// --- JSON-RPC / stdio loop --------------------------------------------------
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
log(`${SERVER_NAME} ${SERVER_VERSION} ready`);
