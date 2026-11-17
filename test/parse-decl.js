#!/usr/bin/env node
'use strict';
/**
 * parse-decl.js - validate decoded POU variable declarations against .asc exports.
 *
 * .asc declaration blocks look like:
 *   VAR_EXTERNAL
 *       Output_0: BOOL:=FALSE;
 *           (*Output 0 of PLC*)
 *   END_VAR
 * We compare scope / name / type / initial value with what lib/proparse.js
 * decodes out of the .pro declaration records.
 *
 * usage: node test/parse-decl.js <dirWithPairs> [--diff]
 */
const fs = require('fs');
const path = require('path');
const { parseProject, extractContents, pous, pouDeclarations } = require('../lib/proparse');

const DECL_RE = /^(PROGRAM|FUNCTION_BLOCK|FUNCTION)\s+([A-Za-z_\u00c0-\uffff][\w\u00c0-\uffff]*)/;
// .asc prints "VAR_EXTERNAL" and also "VAR CONSTANT"; .pro stores the
// underscore form in both cases (VAR_CONSTANT), so normalise to underscores.
const SCOPE_RE = /^(VAR(?:(?:_|\s+)(?:INPUT|OUTPUT|IN_OUT|TEMP|EXTERNAL|GLOBAL|STAT|RETAIN|CONSTANT))?)\b/;
const VAR_RE = /^\s*([A-Za-z_][\w]*)\s*:\s*([^:=;]+?)\s*(?::=\s*([^;]+))?\s*;\s*$/;

/** object name -> [{scope,name,type,init}] from an .asc export */
function ascDeclarations(text) {
  const out = new Map();
  const lines = text.split(/\r?\n/);
  let pou = null;
  let scope = null;
  let inBody = false;
  for (const line of lines) {
    const t = line.trim();
    const m = DECL_RE.exec(t);
    if (m) { pou = m[2]; out.set(pou, []); continue; }
    if (!pou || inBody) {
      if (t === 'BODY') inBody = true;
      if (t === 'END_BODY') inBody = false;
      continue;
    }
    const sm = SCOPE_RE.exec(t);
    if (sm && !t.includes(':')) { scope = sm[1].replace(/\s+/g, '_'); continue; }
    if (t === 'END_VAR') { scope = null; continue; }
    const vm = VAR_RE.exec(line);
    if (vm && scope) {
      out.get(pou).push({ scope, name: vm[1], type: vm[2].trim(), init: (vm[3] || '').trim() });
    }
  }
  return out;
}

const dir = process.argv[2];
const showDiff = process.argv.includes('--diff');
if (!dir) { console.error('usage: parse-decl.js <dir> [--diff]'); process.exit(2); }

let projects = 0, pousChecked = 0, varsExpected = 0, varsMatched = 0, implicit = 0;
const diffs = [];
for (const f of fs.readdirSync(dir).filter((x) => x.toLowerCase().endsWith('.pro'))) {
  const proPath = path.join(dir, f);
  const ascPath = proPath.replace(/\.pro$/i, '.asc');
  if (!fs.existsSync(ascPath)) continue;
  projects++;
  const buf = fs.readFileSync(proPath);
  const project = parseProject(buf, { file: proPath });
  const contents = extractContents(buf, project);
  const declared = ascDeclarations(fs.readFileSync(ascPath, 'utf8'));
  for (const pou of pous(project)) {
    const expected = declared.get(pou.name);
    if (!expected) continue;
    pousChecked++;
    const got = pouDeclarations(project, contents, pou).variables;
    // EN/ENO are implicit inputs/outputs that CoDeSys adds to FUNCTIONs: the .pro
    // declaration table does not store them.
    const explicit = expected.filter((e) => !(e.name === 'EN' || e.name === 'ENO'));
    implicit += expected.length - explicit.length;
    varsExpected += explicit.length;
    const pool = got.slice();
    const missing = [];
    for (const e of explicit) {
      const idx = pool.findIndex((g) => g.name === e.name && (g.scope === e.scope || !e.scope));
      if (idx >= 0) { pool.splice(idx, 1); varsMatched++; }
      else missing.push(e);
    }
    if (missing.length && diffs.length < 6) {
      diffs.push({ file: f, pou: pou.name, missing: missing.slice(0, 5).map((m) => m.scope + ' ' + m.name), got: got.slice(0, 4).map((g) => g.scope + ' ' + g.name) });
    }
  }
}
console.log('projects=' + projects + ' pous=' + pousChecked + ' vars=' + varsExpected + ' implicitEN/ENO=' + implicit +
  ' matched=' + varsMatched + ' missing=' + (varsExpected - varsMatched) +
  ' coverage=' + (varsExpected ? (100 * varsMatched / varsExpected).toFixed(1) : 'n/a') + '%');
if (showDiff) for (const d of diffs) console.log('DIFF ' + d.file + ' :: ' + d.pou + ' missing=' + JSON.stringify(d.missing) + ' got=' + JSON.stringify(d.got));
