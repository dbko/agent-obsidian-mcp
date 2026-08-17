# papers-search-mcp

Semantic search over the Hugging Face Papers corpus: natural-language query in, paper
identifiers (arXiv IDs) and metadata out. Identifiers are directly resolvable by
`paper-fetch-mcp`'s `paper_fulltext_fetch`.

Zero dependencies, Node ≥ 18, stdio JSON-RPC, no credentials. Endpoint:
`https://huggingface.co/api/papers/search` (public, keyless).

## Why it is shaped this way

**The scope wall is structural, not configured.** Hugging Face's own MCP reaches papers
only through `hf_fs`, whose path argument answers for the whole Hub (measured:
`ls hf://datasets` responds). Narrowing that server's tool list leaves the scope wide,
and a binding contract that requires least privilege cannot accept a means whose reach
is decided by how it is called. Here the single tool `paper_semantic_search(query, limit)`
takes **no path, URI, host, or repo argument at all** — the only reachable resource is
the papers search endpoint, and no call shape can widen it.

**No token on purpose.** The endpoint is public; a credential would widen what the server
*could* reach without widening what it *needs*.

## Tool

`paper_semantic_search { query, limit? }` — results carry `arxiv_id`, `arxiv_url`,
`title`, `authors`, `published_at`, `summary`, `upvotes`. `limit` defaults to 20,
capped at 100.

## Smoke

```bash
node ../../tests/smoke-papers-search.mjs                 # protocol + refusals, offline
SMOKE_NETWORK=1 node ../../tests/smoke-papers-search.mjs # + live corpus query
```
