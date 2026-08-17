#!/usr/bin/env node
// papers-search-mcp — one capability, one tool, one fixed corpus.
//
// Built for Vault Steward's `paper_semantic_search`: query -> paper
// identifiers and metadata.
//
// Why this exists rather than binding Hugging Face's own MCP: that server's
// route to papers is `hf_fs`, whose path argument reaches the whole Hub
// (measured: `ls hf://datasets` answers).  Narrowing the tool list there
// leaves the scope untouched, and `030` refuses to bind a means with no
// scope wall.  Here the wall is structural -- no path, URI, host, or repo
// argument exists, so the only reachable resource is the papers search
// endpoint.  Narrowing cannot be undone by how the tool is called.
//
// Zero dependencies. No credentials: the endpoint is public, and a token
// would widen what the server could reach without widening what it needs.

import { createInterface } from 'node:readline';

const VERSION = '0.1.0';
const ENDPOINT = 'https://huggingface.co/api/papers/search';
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const TOOL = {
  name: 'paper_semantic_search',
  description:
    'Search the Hugging Face Papers corpus by natural-language query. Returns paper ' +
    'identifiers (arXiv IDs) with metadata. Identifiers are directly resolvable by ' +
    'paper_fulltext_fetch. This tool reads only the papers corpus; it cannot address ' +
    'any other resource.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Natural-language topic or question.' },
      limit: {
        type: 'number',
        description: `Max rows (default ${DEFAULT_LIMIT}, cap ${MAX_LIMIT}).`,
      },
    },
    required: ['query'],
  },
};

function ok(id, payload) {
  return {
    jsonrpc: '2.0',
    id,
    result: { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] },
  };
}

function toolError(id, message) {
  // A refusal is a result, not a transport error: the caller must be able to
  // read why it was refused and record it as evidence.
  return {
    jsonrpc: '2.0',
    id,
    result: { content: [{ type: 'text', text: message }], isError: true },
  };
}

function normalise(row) {
  const p = row.paper ?? {};
  const arxivId = typeof p.id === 'string' ? p.id : null;
  return {
    // A stable identifier plus the locator its full text is fetched by.
    paper_id: arxivId,
    arxiv_id: arxivId,
    arxiv_url: arxivId ? `https://arxiv.org/abs/${arxivId}` : null,
    title: p.title ?? row.title ?? null,
    authors: Array.isArray(p.authors) ? p.authors.map((a) => a?.name).filter(Boolean) : [],
    published_at: p.publishedAt ?? row.publishedAt ?? null,
    summary: p.summary ?? row.summary ?? null,
    upvotes: typeof p.upvotes === 'number' ? p.upvotes : null,
    github_repo: p.githubRepo ?? null,
    // Marked so a caller never mistakes a community signal for a citation
    // count, and never treats the abstract as full text.
    source: 'huggingface-papers',
    evidence_level: 'abstract_only',
  };
}

async function search(args) {
  const query = typeof args?.query === 'string' ? args.query.trim() : '';
  if (!query) throw new Error('query is required and must be a non-empty string');

  let limit = DEFAULT_LIMIT;
  if (args.limit !== undefined) {
    const n = Number(args.limit);
    if (!Number.isFinite(n) || n <= 0) throw new Error('limit must be a positive number');
    limit = Math.min(Math.floor(n), MAX_LIMIT);
  }

  const url = `${ENDPOINT}?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': `papers-search-mcp/${VERSION}` },
  });
  if (!res.ok) throw new Error(`papers search failed: HTTP ${res.status}`);

  const rows = await res.json();
  if (!Array.isArray(rows)) throw new Error('unexpected response shape from papers search');

  const results = rows.slice(0, limit).map(normalise).filter((r) => r.paper_id);
  return {
    query,
    total_returned_by_source: rows.length,
    count: results.length,
    truncated: rows.length > results.length,
    fetched_at: new Date().toISOString(),
    results,
  };
}

const rl = createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  const text = line.trim();
  if (!text) return;

  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return;
  }
  const { id, method, params } = msg;
  const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');

  if (method === 'initialize') {
    return send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'papers-search-mcp', version: VERSION },
      },
    });
  }
  if (method === 'notifications/initialized') return;
  if (method === 'tools/list') {
    return send({ jsonrpc: '2.0', id, result: { tools: [TOOL] } });
  }
  if (method === 'tools/call') {
    const name = params?.name;
    if (name !== TOOL.name) return send(toolError(id, `unknown tool: ${name}`));
    try {
      return send(ok(id, await search(params?.arguments ?? {})));
    } catch (err) {
      return send(toolError(id, String(err.message ?? err)));
    }
  }
  if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method: ${method}` } });
  }
});

process.stderr.write(`papers-search-mcp ${VERSION} ready\n`);
