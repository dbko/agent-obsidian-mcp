# paper-fetch-mcp

Zero-dependency stdio MCP server that fetches arXiv paper full text for grounded reading.

**Tool**: `paper_fulltext_fetch(arxiv_id, include_references?, max_chars?)` → `{ arxiv_id, source: 'ar5iv'|'pdf', title, chars, truncated, text }`

- Tries ar5iv HTML first — LaTeX math preserved as `$…$` (from `<math alttext>`), tables kept as markdown.
- Falls back to the arXiv PDF via `pdftotext -layout` (requires poppler-utils).
- Bibliography stripped by default; output length capped (default 40 000 chars).
- No API key, no rate limit; caller should verify the returned title matches the intended paper.

**Run**: `node server.mjs` — speaks line-delimited JSON-RPC (MCP) on stdio. Runtime deps: Node ≥ 18, `pdftotext`.
