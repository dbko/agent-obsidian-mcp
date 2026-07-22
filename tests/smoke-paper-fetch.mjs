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

  const list = await srv.rpc('tools/list', {});
  const names = (list.result?.tools || []).map(t => t.name);
  check('tool surface = paper_fulltext_fetch only', JSON.stringify(names) === JSON.stringify(['paper_fulltext_fetch']), names.join(','));
  check('fetch_citations is gone', !names.includes('fetch_citations'));

  let r = await srv.callTool('paper_fulltext_fetch', {});
  check('missing arxiv_id refused', r.isError || /required/.test(r.text));
  r = await srv.callTool('paper_fulltext_fetch', { arxiv_id: 'not-an-id' });
  check('bad arxiv_id refused', r.isError || /unrecognized/.test(r.text));
  r = await srv.callTool('fetch_paper', { arxiv_id: '2309.16653' });
  check('legacy tool name is gone', r.isError && /unknown tool/.test(r.text));

  if (process.env.SMOKE_NETWORK === '1') {
    r = await srv.callTool('paper_fulltext_fetch', { arxiv_id: '1706.03762', max_chars: 5000 }, 90000);
    check('network fetch returns text', !r.isError && r.data?.chars > 1000, r.text?.slice(0, 120));
    check('network fetch source tagged', r.data?.source === 'ar5iv' || r.data?.source === 'pdf');
  } else {
    console.log('  (network fetch skipped — set SMOKE_NETWORK=1 to include)');
  }
} finally {
  srv.kill();
}

process.exit(summary('paper-fetch-mcp smoke'));
