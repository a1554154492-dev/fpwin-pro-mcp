#!/usr/bin/env node
'use strict';
/**
 * langprobe.js - compare the POU language declared in the .asc export with the
 * signals available inside the .pro (body section type code, body text markers).
 *
 * usage: node tools/langprobe.js <dirWithPairs>
 */
const fs = require('fs');
const path = require('path');
const { parseProject, extractContents, pous, pouSource } = require('../lib/proparse');

const DECL_RE = /^(PROGRAM|FUNCTION_BLOCK|FUNCTION)\s+([A-Za-z_\u00c0-\uffff][\w\u00c0-\uffff]*)/;

/** name -> language code ("'LD'" → "LD") from the .asc export */
function ascLanguages(text) {
  const out = new Map();
  const lines = text.split(/\r?\n/);
  let pou = null;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    const m = DECL_RE.exec(t);
    if (m) { pou = m[2]; continue; }
    const lm = /^'([A-Za-z]{2,4})'$/.exec(t);
    if (lm && pou) { out.set(pou, lm[1]); pou = null; }
  }
  return out;
}

const dir = process.argv[2];
if (!dir) { console.error('usage: langprobe.js <dir>'); process.exit(2); }
const stats = new Map();
const rows = [];
for (const f of fs.readdirSync(dir).filter((x) => x.toLowerCase().endsWith('.pro'))) {
  const proPath = path.join(dir, f);
  const ascPath = proPath.replace(/\.pro$/i, '.asc');
  if (!fs.existsSync(ascPath)) continue;
  const buf = fs.readFileSync(proPath);
  const project = parseProject(buf, { file: proPath });
  const contents = extractContents(buf, project);
  const langs = ascLanguages(fs.readFileSync(ascPath, 'utf8'));
  for (const pou of pous(project)) {
    const want = langs.get(pou.name);
    if (!want) continue;
    const src = pouSource(project, contents, pou);
    const sectionType = src.section ? src.section.type : null;
    const bodyText = src.text || '';
    const nw = (bodyText.match(/NETWORK_LIST_TYPE\s*:=\s*(NWTYPE\w+)/) || [])[1] || '';
    const firstTok = (bodyText.match(/^BODY\r?\n\s*(\w+)?/) || [])[1] || '';
    const key = want + '|' + (sectionType === null ? '-' : '0x' + sectionType.toString(16)) + '|' + nw;
    stats.set(key, (stats.get(key) || 0) + 1);
    if (rows.length < 12) rows.push({ file: f, pou: pou.name, want, sectionType, nw, firstTok });
  }
}
for (const r of rows) {
  console.log(r.file + ' :: ' + r.pou + '  asc=' + r.want +
    '  section=' + (r.sectionType === null ? 'none' : '0x' + r.sectionType.toString(16)) +
    '  nwtype=' + (r.nw || '-') + '  first=' + (r.firstTok || '-'));
}
console.log('--- asc language | section type | NETWORK_LIST_TYPE : count ---');
for (const [k, v] of [...stats.entries()].sort((a, b) => b[1] - a[1])) console.log('  ' + k + ' : ' + v);
