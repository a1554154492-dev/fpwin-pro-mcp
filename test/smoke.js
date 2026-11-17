#!/usr/bin/env node
/**
 * Minimal MCP stdio smoke test: drives server.js over JSON-RPC and prints each result.
 * Usage: node test/smoke.js [tool arguments...]
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const serverPath = path.join(__dirname, '..', 'server.js');
const child = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'inherit'] });

let buf = '';
const pending = new Map();
let nextId = 1;

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const resolver = pending.get(msg.id);
    if (resolver) { pending.delete(msg.id); resolver(msg); }
  }
});

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout ' + method)); } }, 180000);
  });
}

function show(label, value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  console.log(`\n===== ${label} =====`);
  console.log(text.length > 6000 ? text.slice(0, 6000) + '\n... (truncated)' : text);
}

async function call(name, args) {
  const r = await request('tools/call', { name, arguments: args || {} });
  const payload = r.result && r.result.content && r.result.content[0] ? r.result.content[0].text : JSON.stringify(r.error);
  let parsed;
  try { parsed = JSON.parse(payload); } catch { parsed = payload; }
  show(name + ' ' + JSON.stringify(args || {}), parsed);
  return parsed;
}

(async () => {
  const init = await request('initialize', { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } });
  show('initialize', init.result && init.result.serverInfo ? init.result.serverInfo : init.error);

  const list = await request('tools/list', {});
  const tools = list.result && list.result.tools ? list.result.tools.map((t) => t.name) : list.error;
  show('tools/list', tools);

  const root = path.join(__dirname, '..', 'fixtures');
  const args = process.argv.slice(2);
  if (args.includes('--offline')) {
    await call('fpwin_info');
    await call('fpwin_doctor');
    if (fs.existsSync(path.join(root, 'sample.asc'))) await call('fpwin_asc_parse', { file: path.join(root, 'sample.asc'), includeVariables: true, maxObjects: 60 });
    if (fs.existsSync(path.join(root, 'EmptyPrj.pro'))) await call('fpwin_pro_inspect', { file: path.join(root, 'EmptyPrj.pro'), maxStrings: 40 });
  }
  if (args.includes('--ide')) {
    if (fs.existsSync(path.join(root, 'sample6.pro'))) await call('fpwin_snapshot', { file: path.join(root, 'sample6.pro'), timeoutMs: 120000 });
  }
  if (args.includes('--batch')) {
    await call('fpwin_batch', { commands: 'bogus_command_xyz', timeoutMs: 30000 });
  }
  child.stdin.end();
  child.kill();
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); child.kill(); process.exit(1); });
