# paper-fetch-mcp

Zero-dependency stdio MCP server that resolves arXiv, DOI, or OpenAlex work IDs to open full text for grounded reading.

**Tool**: `paper_fulltext_fetch(paper_id, include_references?, offset_line?, limit_lines?)`

- arXiv uses ar5iv first and PDF fallback. DOI/OpenAlex IDs resolve metadata and use an arXiv location, OA PDF, or full-article HTML.
- Returns canonical identifiers, source URL, metadata, whole-content SHA-256, total lines, and globally numbered paged text.
- Read successive pages while `has_more` is true before treating the paper as fully read.
- Bibliography is omitted by default. Figures are not evidence unless represented in extracted text.
- DOI and OpenAlex resolution use public network services; no secret is logged.

## What it refuses, and why

Full text is read **only from locations OpenAlex marks open access**. `doi.org` is never
followed: it resolves to the publisher, and a paywall page carries `<article>` markup plus
thousands of characters of subscription copy, so it passes every structural test while
containing none of the paper. Measured on `10.1038/nature14539`, the text returned by the
old path was *"Receive 52 print issues"*, *"Buy this article"*, *"Purchase on SpringerLink"*.

Two classes are therefore refused rather than approximated:

- **Paywalled works** — no open location exists.
- **Green-OA works whose only open copy is a repository landing page**, not a PDF or a
  structurally identified full-article HTML source. `10.1038/nature14539` is open at
  `hal.science/hal-04206682`, but as a landing page, so it is refused.

An arXiv ID is taken **only from an arXiv-hosted URL**. The old-style arXiv pattern
(`archive/7digits`) matches any `word/7digits` substring, so reading it out of arbitrary
OpenAlex locations turned `pubmed.ncbi.nlm.nih.gov/16060722` into the arXiv ID
`gov/1606072` — which then sent open-access papers down the arXiv branch, past the open
PDF sitting in the same location list.

**Run**: `node server.mjs` — speaks line-delimited JSON-RPC (MCP) on stdio. Runtime deps: Node ≥ 18, `pdftotext`.
