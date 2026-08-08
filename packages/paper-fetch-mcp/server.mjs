#!/usr/bin/env node
// paper-fetch-mcp — zero-dependency stdio MCP server: resolve arXiv/DOI/OpenAlex IDs
// to open full text and return paged, stable line locators.
//
// Tool (canonical name per workflow capability registry):
//   paper_fulltext_fetch(paper_id, include_references?, offset_line?, limit_lines?)
//     -> identifiers + metadata + source URL + content digest + globally numbered lines
//
// Strategy per call:
//   1. ar5iv HTML (https://ar5iv.labs.arxiv.org/html/{id}) -> text + LaTeX from <math alttext>
//   2. fallback: arXiv PDF (https://arxiv.org/pdf/{id}) -> pdftotext -layout (poppler)
//   -> strip bibliography (unless include_references), cap length.
//
// Runtime dependencies: node >= 18, pdftotext (poppler-utils) for the PDF fallback.
// Node built-ins only. stdout is reserved for JSON-RPC frames; logs go to stderr.

import http from 'node:http';
import https from 'node:https';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const PROTOCOL = '2025-03-26';
const SERVER_NAME = 'paper-fetch-mcp';
const SERVER_VERSION = '0.2.0';
const DEFAULT_LIMIT_LINES = 500;
const HTTP_TIMEOUT_MS = 45000;

const log = (...a) => process.stderr.write(a.join(' ') + '\n');

// --- identifier normalize --------------------------------------------------
function normalizeArxivId(raw) {
  const s = raw.trim();
  const m = s.match(/(\d{4}\.\d{4,5})(v\d+)?/) || s.match(/([a-z\-]+(?:\.[A-Z]{2})?\/\d{7})(v\d+)?/i);
  return m ? m[1] : null;
}

function parsePaperId(raw) {
  if (!raw || typeof raw !== 'string')
    throw new Error('paper_id is required (arXiv ID, DOI, or OpenAlex work ID)');
  const value = raw.trim();
  const openalex = value.match(/(?:https?:\/\/openalex\.org\/)?(W\d+)$/i);
  if (openalex) return { kind: 'openalex', value: openalex[1].toUpperCase() };
  const doi = value.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '');
  if (/^10\.\d{4,9}\/\S+$/i.test(doi)) return { kind: 'doi', value: doi };
  const arxiv = normalizeArxivId(value);
  if (arxiv && (/arxiv/i.test(value) || /^\d{4}\.\d{4,5}(v\d+)?$/.test(value) || /^[a-z\-]+(?:\.[A-Z]{2})?\/\d{7}(v\d+)?$/i.test(value)))
    return { kind: 'arxiv', value: arxiv };
  throw new Error(`unrecognized paper_id: ${raw}`);
}

// --- HTTP GET with redirect follow (text or binary) -------------------------
function httpGet(url, { binary = false, redirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const transport = new URL(url).protocol === 'http:' ? http : https;
    const req = transport.get(url, { timeout: HTTP_TIMEOUT_MS, headers: { 'User-Agent': `${SERVER_NAME}/${SERVER_VERSION}`, 'Accept-Encoding': 'identity' } }, (res) => {
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
        resolve({ status: statusCode, headers, url, body: binary ? buf : buf.toString('utf8') });
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

function normalizeText(text, includeReferences) {
  let value = includeReferences ? text : stripReferences(text);
  value = value.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return value.split('\n').map((line) => line.trimEnd()).filter((line) => line.trim().length > 0);
}

async function resolveOpenAlex(parsed) {
  const lookup = parsed.kind === 'doi' ? `doi:${parsed.value}` : parsed.value;
  const url = `https://api.openalex.org/works/${lookup}`;
  const r = await httpGet(url);
  if (r.status === 404 && parsed.kind === 'doi') return null;
  if (r.status !== 200) throw new Error(`OpenAlex resolution failed (${r.status}) for ${parsed.value}`);
  let work;
  try { work = JSON.parse(r.body); }
  catch { throw new Error('OpenAlex returned invalid JSON'); }

  const locations = [work.best_oa_location, work.primary_location, ...(work.locations || [])].filter(Boolean);
  let arxiv = null;
  for (const loc of locations) {
    const joined = `${loc.landing_page_url || ''} ${loc.pdf_url || ''}`;
    arxiv ||= normalizeArxivId(joined);
  }
  const pdfUrls = [...new Set(locations.map((loc) => loc.pdf_url).filter(Boolean))];
  const landingUrls = [...new Set(locations.map((loc) => loc.landing_page_url).filter(Boolean))];
  return {
    metadata: {
      title: work.title || '',
      year: work.publication_year || null,
      authors: (work.authorships || []).map((a) => a.author?.display_name).filter(Boolean),
    },
    identifiers: {
      openalex: (work.id || '').replace(/^https?:\/\/openalex\.org\//i, '') || null,
      doi: (work.doi || '').replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '') || (parsed.kind === 'doi' ? parsed.value : null),
      arxiv,
    },
    pdfUrls,
    landingUrls,
  };
}

async function fetchArxiv(id) {
  let title = '', text = '';

  try {
    const r = await httpGet(`https://ar5iv.labs.arxiv.org/html/${id}`);
    if (r.status === 200 && r.body && /<math|ltx_page_content|ltx_document/i.test(r.body)) {
      const parsed = ar5ivToText(r.body);
      if (parsed.text && parsed.text.length > 500)
        return { source: 'ar5iv', source_url: `https://ar5iv.labs.arxiv.org/html/${id}`, title: parsed.title, text: parsed.text };
    }
  } catch (e) { log('ar5iv failed:', e.message); }

  const sourceUrl = `https://arxiv.org/pdf/${id}`;
  const r = await httpGet(sourceUrl, { binary: true });
  if (r.status === 200 && r.body && r.body.length > 1000) {
    text = await pdftotext(r.body);
    if (text.length > 300) return { source: 'pdf', source_url: sourceUrl, title, text };
  }
  throw new Error(`could not fetch arXiv ${id} from ar5iv or PDF`);
}

async function fetchOpenPdf(urls) {
  for (const url of urls) {
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) continue;
      const r = await httpGet(parsed.toString(), { binary: true });
      const contentType = String(r.headers?.['content-type'] || '').toLowerCase();
      if (r.status !== 200 || !r.body || r.body.length < 1000) continue;
      if (!contentType.includes('pdf') && r.body.subarray(0, 5).toString() !== '%PDF-') continue;
      const text = await pdftotext(r.body);
      if (text.length > 300) return { source: 'oa-pdf', source_url: parsed.toString(), title: '', text };
    } catch (e) { log('OA PDF failed:', e.message); }
  }
  throw new Error('no retrievable open-access PDF was found');
}

async function fetchDoiOrOpenHtml(doi, urls = []) {
  const candidates = [...new Set([...(doi ? [`https://doi.org/${doi}`] : []), ...urls])];
  for (const url of candidates) {
    try {
      const r = await httpGet(url);
      if (r.status !== 200 || !r.body) continue;
      const arxiv = normalizeArxivId(`${r.url || ''} ${r.body.slice(0, 5000)}`);
      if (arxiv) return { arxiv, fetched: await fetchArxiv(arxiv) };
      const fulltextSignal = /<article\b|article[-_ ]body|full[-_ ]text|citation_pdf_url/i.test(r.body);
      if (!fulltextSignal) continue;
      const parsed = ar5ivToText(r.body);
      if (parsed.text.length > 5000)
        return { arxiv: null, fetched: { source: 'oa-html', source_url: r.url || url, title: parsed.title, text: parsed.text } };
    } catch (e) { log('DOI/OA HTML failed:', e.message); }
  }
  throw new Error('DOI/OpenAlex metadata did not lead to retrievable open full text');
}

async function paperFulltextFetch({ paper_id, include_references = false, offset_line = 1, limit_lines = DEFAULT_LIMIT_LINES } = {}) {
  const parsed = parsePaperId(paper_id);
  let metadata = { title: '', year: null, authors: [] };
  let identifiers = { openalex: null, doi: null, arxiv: null };
  let fetched;

  if (parsed.kind === 'arxiv') {
    identifiers.arxiv = parsed.value;
    fetched = await fetchArxiv(parsed.value);
    metadata.title = fetched.title;
  } else {
    const resolved = await resolveOpenAlex(parsed);
    if (resolved) {
      metadata = resolved.metadata;
      identifiers = resolved.identifiers;
    } else {
      identifiers.doi = parsed.value;
    }
    if (identifiers.arxiv) {
      fetched = await fetchArxiv(identifiers.arxiv);
    } else {
      try { fetched = await fetchOpenPdf(resolved?.pdfUrls || []); }
      catch {
        const fallback = await fetchDoiOrOpenHtml(identifiers.doi, resolved?.landingUrls || []);
        if (fallback.arxiv) identifiers.arxiv = fallback.arxiv;
        fetched = fallback.fetched;
      }
    }
    if (!metadata.title) metadata.title = fetched.title;
  }

  const lines = normalizeText(fetched.text, include_references);
  if (lines.length === 0) throw new Error('full text extraction returned no usable lines');
  const start = Math.max(1, Number(offset_line) || 1);
  const cap = Math.max(1, Math.min(5000, Number(limit_lines) || DEFAULT_LIMIT_LINES));
  if (start > lines.length) throw new Error(`offset_line ${start} exceeds total_lines ${lines.length}`);
  const selected = lines.slice(start - 1, start - 1 + cap);
  const end = start + selected.length - 1;
  const text = selected.map((line, i) => `[L${String(start + i).padStart(6, '0')}] ${line}`).join('\n');
  const contentSha256 = createHash('sha256').update(lines.join('\n')).digest('hex');

  return {
    requested_id: paper_id,
    identifiers,
    title: metadata.title,
    year: metadata.year,
    authors: metadata.authors,
    source: fetched.source,
    source_url: fetched.source_url,
    locator_scheme: 'content_sha256 + global extracted line number',
    content_sha256: contentSha256,
    total_lines: lines.length,
    offset_line: start,
    returned_lines: selected.length,
    end_line: end,
    has_more: end < lines.length,
    text,
  };
}

// --- MCP tool registry ------------------------------------------------------
const TOOLS = [
  {
    name: 'paper_fulltext_fetch',
    description: 'Resolve an arXiv ID, DOI, or OpenAlex work ID to retrievable open full text. Returns canonical identifiers, metadata, source URL, content digest, and paged globally numbered lines. DOI/OpenAlex resolution is metadata-only until an arXiv or open PDF source is found. Read successive pages while has_more=true before treating the paper as fully read.',
    inputSchema: {
      type: 'object',
      properties: {
        paper_id: { type: 'string', description: 'arXiv ID/URL, DOI/URL, or OpenAlex work ID/URL.' },
        include_references: { type: 'boolean', description: 'Keep the bibliography section (default false — dropped to save context).' },
        offset_line: { type: 'number', description: '1-indexed global extracted line to start from (default 1).' },
        limit_lines: { type: 'number', description: 'Lines to return (default 500, max 5000).' },
      },
      required: ['paper_id'],
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
