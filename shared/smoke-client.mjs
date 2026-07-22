// shared/smoke-client.mjs — minimal JSON-RPC stdio client + assert helpers for smoke tests.
// Test-time only; NOT shipped inside the package tgz assets.

import { spawn } from 'node:child_process';

export function startServer(scriptPath, env = {}) {
  const child = spawn(process.execPath, [scriptPath], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buf = '';
  const pending = new Map();
  let nextId = 1;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve } = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg);
      }
    }
  });
  child.stderr.setEncoding('utf8');
  const stderrLines = [];
  child.stderr.on('data', (c) => stderrLines.push(c));

  function rpc(method, params, timeoutMs = 20000) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { pending.delete(id); reject(new Error(`rpc timeout: ${method}`)); }, timeoutMs);
      pending.set(id, { resolve: (m) => { clearTimeout(t); resolve(m); } });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  async function callTool(name, args, timeoutMs) {
    const r = await rpc('tools/call', { name, arguments: args }, timeoutMs);
    if (r.error) throw new Error(`rpc error: ${JSON.stringify(r.error)}`);
    const text = r.result?.content?.[0]?.text ?? '';
    if (r.result?.isError) return { isError: true, text };
    try { return { isError: false, data: JSON.parse(text), text }; }
    catch { return { isError: false, text }; }
  }

  return { child, rpc, callTool, stderr: () => stderrLines.join(''), kill: () => child.kill() };
}

let failures = 0;
export function check(label, cond, detail = '') {
  if (cond) { console.log(`  ok  ${label}`); }
  else { failures++; console.error(`  FAIL ${label}${detail ? ' — ' + detail : ''}`); }
}
export function summary(name) {
  if (failures === 0) { console.log(`== ${name}: ALL PASS ==`); return 0; }
  console.error(`== ${name}: ${failures} FAILURE(S) ==`);
  return 1;
}
