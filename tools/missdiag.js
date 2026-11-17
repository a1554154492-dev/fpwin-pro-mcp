#!/usr/bin/env node
'use strict';
/**
 * missdiag.js - explain validation misses for .pro/.asc sample pairs.
 * For every asc-declared object name missing from the parsed .pro object names,
 * show the closest parsed names (prefix / suffix / substring) so the naming
 * quirk can be characterised.
 *
 * usage: node tools/missdiag.js <dirWithPairs>
 */
const fs = require('fs');
const path = require('path');
const { parseProject } = require('../lib/proparse');

const DECL_RE = /^(PROGRAM|FUNCTION_BLOCK|FUNCTION|VAR_GLOBAL|TYPE)\s+([A-Za-z_\u00c0-\uffff][\w\u00c0-\uffff]*)/;

function ascNames(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = DECL_RE.exec(line.trim());
    if (m) out.push(m[2]);
  }
  return [...new Set(out)];
}

const dir = process.argv[2];
if (!dir) { console.error('usage: missdiag.js <dir>'); process.exit(2); }
let totalMissing = 0, explained = 0, unexplained = [];
for (const f of fs.readdirSync(dir).filter((x) => x.toLowerCase().endsWith('.pro'))) {
  const proPath = path.join(dir, f);
  const ascPath = proPath.replace(/\.pro$/i, '.asc');
  if (!fs.existsSync(ascPath)) continue;
  const project = parseProject(fs.readFileSync(proPath), { file: proPath });
  const names = [...new Set(project.objects.map((o) => o.name))];
  const missing = ascNames(fs.readFileSync(ascPath, 'utf8')).filter((n) => !names.includes(n));
  if (!missing.length) continue;
  console.log('## ' + f);
  for (const n of missing) {
    totalMissing++;
    const near = names.filter((p) => p.includes(n) || n.includes(p));
    if (near.length) explained++;
    else unexplained.push(f + ' :: ' + n);
    console.log('   missing ' + JSON.stringify(n) + ' -> near: ' + (near.length ? near.map((x) => JSON.stringify(x)).join(', ') : '(none)'));
  }
}
console.log('---');
console.log('missing=' + totalMissing + ' explainedBySubstring=' + explained + ' unexplained=' + unexplained.length);
for (const u of unexplained) console.log('  U ' + u);
