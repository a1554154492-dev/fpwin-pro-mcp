#!/usr/bin/env node
/** Focused test for one IDE tool call. Usage: node test/one.js <tool> '<json-args>' */
'use strict';
const { spawn } = require('child_process');
const path = require('path');

const serverPath = path.join(__dirname, '..', 'server.js');
const child = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = '';
const pending = new Map();
let nextId = 1;

child.stdout.setEncoding('utf8');
child.stdout.on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      const r = pending.get(msg.id);
      if (r) { pending.delete(msg.id); r(msg); }
    } catch {}
  }
});

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout')); } }, 200000);
  });
}

(async () => {
  const tool = process.argv[2];
  const rawArgs = process.argv[3] || '{}';
  const fs = require('fs');
  const args = rawArgs.trim().startsWith('{') ? JSON.parse(rawArgs) : JSON.parse(fs.readFileSync(rawArgs, 'utf8'));
  await request('initialize', { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'one', version: '0' } });
  const r = await request('tools/call', { name: tool, arguments: args });
  const out = r.result && r.result.content ? r.result.content[0].text : JSON.stringify(r.error);
  console.log(out.length > 8000 ? out.slice(0, 8000) + '\n...' : out);
  child.stdin.end();
  child.kill();
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); child.kill(); process.exit(1); });
