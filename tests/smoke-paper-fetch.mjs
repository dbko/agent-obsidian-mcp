// tests/smoke-paper-fetch.mjs — offline smoke: protocol, tool surface, input validation.
// Set SMOKE_NETWORK=1 to additionally run one real arXiv fetch (network + pdftotext path).

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, check, summary } from '../shared/smoke-client.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(here, '..', 'packages', 'paper-fetch-mcp', 'server.mjs');

const srv = startServer(SERVER);
await new Promise(r => setTimeout(r, 300));

try {
  const init = await srv.rpc('initialize', { protocolVersion: '2025-03-26' });
  check('initialize', init.result?.serverInfo?.name === 'paper-fetch-mcp');
  check('version is 0.2.0', init.result?.serverInfo?.version === '0.2.0', init.result?.serverInfo?.version);

  const list = await srv.rpc('tools/list', {});
  const names = (list.result?.tools || []).map(t => t.name);
  check('tool surface = paper_fulltext_fetch only', JSON.stringify(names) === JSON.stringify(['paper_fulltext_fetch']), names.join(','));
  check('fetch_citations is gone', !names.includes('fetch_citations'));

  let r = await srv.callTool('paper_fulltext_fetch', {});
  check('missing paper_id refused', r.isError || /required/.test(r.text));
  r = await srv.callTool('paper_fulltext_fetch', { paper_id: 'not-an-id' });
  check('bad paper_id refused', r.isError || /unrecognized/.test(r.text));
  r = await srv.callTool('fetch_paper', { paper_id: '2309.16653' });
  check('legacy tool name is gone', r.isError && /unknown tool/.test(r.text));

  if (process.env.SMOKE_NETWORK === '1') {
    r = await srv.callTool('paper_fulltext_fetch', { paper_id: '1706.03762', limit_lines: 20 }, 90000);
    check('arXiv fetch returns located text', !r.isError && r.data?.returned_lines === 20 && /^\[L000001\]/.test(r.data?.text || ''), r.text?.slice(0, 160));
    check('network fetch source tagged', r.data?.source === 'ar5iv' || r.data?.source === 'pdf');
    check('network fetch returns stable evidence metadata', /^[a-f0-9]{64}$/.test(r.data?.content_sha256 || '') && r.data?.identifiers?.arxiv === '1706.03762' && r.data?.source_url, JSON.stringify(r.data));
    r = await srv.callTool('paper_fulltext_fetch', { paper_id: '10.48550/arXiv.1706.03762', limit_lines: 5 }, 90000);
    check('DOI resolves to open full text', !r.isError && r.data?.identifiers?.doi && r.data?.returned_lines === 5, r.text?.slice(0, 180));
    r = await srv.callTool('paper_fulltext_fetch', { paper_id: 'W2626778328', limit_lines: 5 }, 90000);
    check('OpenAlex ID resolves to identified open full text', !r.isError && r.data?.identifiers?.openalex === 'W2626778328' && r.data?.identifiers?.arxiv === '1706.03762' && r.data?.returned_lines === 5, r.text?.slice(0, 180));
  } else {
    console.log('  (network fetch skipped — set SMOKE_NETWORK=1 to include)');
  }
} finally {
  srv.kill();
}

process.exit(summary('paper-fetch-mcp smoke'));
