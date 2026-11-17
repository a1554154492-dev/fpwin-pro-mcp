#!/usr/bin/env node
'use strict';
/**
 * typecensus.js - learn the .pro object type codes from the .asc ground truth.
 *
 * For each .pro/.asc pair, every asc declaration line (PROGRAM / FUNCTION_BLOCK /
 * FUNCTION / VAR_GLOBAL / TYPE name) is looked up by name in the parsed .pro
 * object table; the observed type code is tallied per declaration kind.
 *
 * usage: node tools/typecensus.js <dirWithPairs>
 */
const fs = require('fs');
const path = require('path');
const { parseProject } = require('../lib/proparse');

const DECL_RE = /^(PROGRAM|FUNCTION_BLOCK|FUNCTION|VAR_GLOBAL|TYPE)\s+([A-Za-z_\u00c0-\uffff][\w\u00c0-\uffff]*)/;

function ascDecls(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = DECL_RE.exec(line.trim());
    if (m) out.push({ kind: m[1], name: m[2] });
  }
  return out;
}

const dir = process.argv[2];
if (!dir) { console.error('usage: typecensus.js <dir>'); process.exit(2); }
const census = new Map(); // kind -> Map(typeCode -> {count, examples[]})
let paired = 0, unresolved = 0;
for (const f of fs.readdirSync(dir).filter((x) => x.toLowerCase().endsWith('.pro'))) {
  const proPath = path.join(dir, f);
  const ascPath = proPath.replace(/\.pro$/i, '.asc');
  if (!fs.existsSync(ascPath)) continue;
  paired++;
  const project = parseProject(fs.readFileSync(proPath), { file: proPath });
  const byName = new Map(project.objects.map((o) => [o.name, o]));
  for (const d of ascDecls(fs.readFileSync(ascPath, 'utf8'))) {
    const hit = byName.get(d.name);
    if (!hit) { unresolved++; continue; }
    if (!census.has(d.kind)) census.set(d.kind, new Map());
    const m = census.get(d.kind);
    const key = hit.type;
    if (!m.has(key)) m.set(key, { count: 0, examples: [] });
    const e = m.get(key);
    e.count++;
    if (e.examples.length < 3 && !e.examples.includes(d.name)) e.examples.push(d.name);
  }
}
console.log('pairs=' + paired + ' unresolvedDecls=' + unresolved);
for (const [kind, m] of census) {
  console.log('## ' + kind);
  for (const [type, e] of [...m.entries()].sort((a, b) => b[1].count - a[1].count)) {
    console.log('   0x' + type.toString(16).padStart(2, '0') + '  x' + String(e.count).padStart(3) + '  ' + e.examples.join(', '));
  }
}
