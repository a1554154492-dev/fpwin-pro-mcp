#!/usr/bin/env node
'use strict';
/**
 * parse-lang.js - validate POU implementation-language detection against the
 * .asc exports (the export carries a line like `'LD'` before the BODY block).
 *
 * usage: node test/parse-lang.js <dirWithPairs> [--diff]
 */
const fs = require('fs');
const path = require('path');
const { parseProject, extractContents, pous, pouLanguage } = require('../lib/proparse');

const DECL_RE = /^(PROGRAM|FUNCTION_BLOCK|FUNCTION)\s+([A-Za-z_\u00c0-\uffff][\w\u00c0-\uffff]*)/;

function ascLanguages(text) {
  const out = new Map();
  const lines = text.split(/\r?\n/);
  let pou = null;
  for (const line of lines) {
    const t = line.trim();
    const m = DECL_RE.exec(t);
    if (m) { pou = m[2]; continue; }
    const lm = /^'([A-Za-z]{2,4})'$/.exec(t);
    if (lm && pou) { out.set(pou, lm[1]); pou = null; }
  }
  return out;
}

const dir = process.argv[2];
const showDiff = process.argv.includes('--diff');
if (!dir) { console.error('usage: parse-lang.js <dir> [--diff]'); process.exit(2); }

let projects = 0, checked = 0, ok = 0, bad = 0;
const diffs = [];
for (const f of fs.readdirSync(dir).filter((x) => x.toLowerCase().endsWith('.pro'))) {
  const proPath = path.join(dir, f);
  const ascPath = proPath.replace(/\.pro$/i, '.asc');
  if (!fs.existsSync(ascPath)) continue;
  projects++;
  const buf = fs.readFileSync(proPath);
  const project = parseProject(buf, { file: proPath });
  const contents = extractContents(buf, project);
  const langs = ascLanguages(fs.readFileSync(ascPath, 'utf8'));
  for (const pou of pous(project)) {
    const want = langs.get(pou.name);
    if (!want) continue;
    checked++;
    const got = pouLanguage(project, contents, pou);
    if (got.language === want) ok++;
    else { bad++; if (diffs.length < 8) diffs.push({ file: f, pou: pou.name, want, got: got.language, evidence: got.evidence, section: got.sectionType, name: got.sectionName }); }
  }
}
console.log('projects=' + projects + ' pous=' + checked + ' ok=' + ok + ' bad=' + bad +
  ' accuracy=' + (checked ? (100 * ok / checked).toFixed(1) : 'n/a') + '%');
if (showDiff) for (const d of diffs) console.log('DIFF ' + d.file + ' :: ' + d.pou + ' want=' + d.want + ' got=' + d.got + ' evidence=' + d.evidence + ' section=' + (d.section === null ? 'none' : '0x' + d.section.toString(16)));
if (bad > 0) process.exitCode = 1;
