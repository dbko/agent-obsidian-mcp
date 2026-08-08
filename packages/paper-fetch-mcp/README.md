# paper-fetch-mcp

Zero-dependency stdio MCP server that resolves arXiv, DOI, or OpenAlex work IDs to open full text for grounded reading.

**Tool**: `paper_fulltext_fetch(paper_id, include_references?, offset_line?, limit_lines?)`

- arXiv uses ar5iv first and PDF fallback. DOI/OpenAlex IDs resolve metadata and use an arXiv location, OA PDF, or full-article HTML.
- Returns canonical identifiers, source URL, metadata, whole-content SHA-256, total lines, and globally numbered paged text.
- Read successive pages while `has_more` is true before treating the paper as fully read.
- Bibliography is omitted by default. Figures are not evidence unless represented in extracted text.
- DOI and OpenAlex resolution use public network services; no secret is logged.

**Run**: `node server.mjs` — speaks line-delimited JSON-RPC (MCP) on stdio. Runtime deps: Node ≥ 18, `pdftotext`.
