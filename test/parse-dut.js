#!/usr/bin/env node
'use strict';
/**
 * parse-dut.js - validate decoded DUT (TYPE … END_TYPE) field lists against .asc.
 *
 * .asc export shape:
 *   TYPE
 *       DUT_1:
 *           STRUCT
 *               Int1: INT:=0;
 *           END_STRUCT;
 *   END_TYPE
 * lib/proparse.js stores one binary content chunk per field, owned by the DUT
 * object (type 0x0c), with the POU declaration layout minus the scope token.
 *
 * usage: node test/parse-dut.js <dirWithPairs> [--diff]
 */
const fs = require('fs');
const path = require('path');
const { parseProject, extractContents, duts, dutDeclarations } = require('../lib/proparse');

const FIELD_RE = /^([A-Za-z_][\w]*)\s*:\s*(.+?)\s*(?::=\s*(.*?))?;$/;
const DUT_HEAD_RE = /^([A-Za-z_][\w]*)\s*:\s*(?:$|(STRUCT|UNION)\b)/i;

/** .asc TYPE blocks -> Map<dutName, {kind, fields:[{name,type,init}]}> */
function ascDuts(text) {
  const out = new Map();
  let inType = false;
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const t = raw.trim();
    if (!t || t.startsWith('(*')) continue;
    if (/^TYPE\b/.test(t)) { inType = true; cur = null; continue; }
    if (!inType) continue;
    if (/^END_TYPE\b/.test(t)) { inType = false; cur = null; continue; }
    const head = DUT_HEAD_RE.exec(t);
    if (head) { cur = { name: head[1], kind: head[2] ? head[2].toUpperCase() : null, fields: [] }; out.set(cur.name, cur); continue; }
    if (/^(STRUCT|UNION)\b/i.test(t)) { if (cur) cur.kind = t.slice(0, 5).toUpperCase(); continue; }
    if (/^END_STRUCT\b/i.test(t)) continue;
    const fm = FIELD_RE.exec(t);
    if (fm && cur) cur.fields.push({ name: fm[1], type: fm[2].trim(), init: (fm[3] || '').trim() });
  }
  return out;
}

const dir = process.argv[2] || path.join(__dirname, '..', 'fixtures', 'samples');
const showDiff = process.argv.includes('--diff');

let projects = 0, projectsWithType = 0, dutsExpected = 0, dutsMatched = 0;
let fieldsExpected = 0, fieldsMatched = 0;
const diffs = [];
for (const f of fs.readdirSync(dir).filter((x) => x.toLowerCase().endsWith('.pro'))) {
  const proPath = path.join(dir, f);
  const ascPath = proPath.replace(/\.pro$/i, '.asc');
  if (!fs.existsSync(ascPath)) continue;
  projects++;
  const expected = ascDuts(fs.readFileSync(ascPath, 'utf8'));
  if (!expected.size) continue;
  projectsWithType++;
  const buf = fs.readFileSync(proPath);
  const project = parseProject(buf, { file: proPath });
  const contents = extractContents(buf, project);
  const decoded = new Map();
  for (const dut of duts(project)) decoded.set(dut.name, dutDeclarations(project, contents, dut).fields);

  for (const [name, e] of expected) {
    dutsExpected++;
    const got = decoded.get(name);
    if (!got) { diffs.push({ file: f, dut: name, reason: 'DUT missing in .pro', ascFields: e.fields.length }); continue; }
    dutsMatched++;
    // field by field, in declaration order
    const n = Math.min(got.length, e.fields.length);
    for (let i = 0; i < n; i++) {
      fieldsExpected++;
      const a = e.fields[i];
      const g = got[i];
      const ok = g.name === a.name && g.typeName === a.type && g.initialValue === a.init;
      if (ok) fieldsMatched++;
      else if (diffs.length < 12) diffs.push({ file: f, dut: name, field: i, asc: a, pro: { name: g.name, type: g.typeName, init: g.initialValue } });
    }
    // extra/missing tail fields count as expected-but-unmatched
    for (let i = n; i < e.fields.length; i++) { fieldsExpected++; if (diffs.length < 12) diffs.push({ file: f, dut: name, field: i, reason: 'field missing in .pro', asc: e.fields[i] }); }
    if (got.length > e.fields.length && diffs.length < 12) diffs.push({ file: f, dut: name, reason: 'extra .pro fields: ' + got.slice(e.fields.length).map((g) => g.name).join(',') });
  }
}

const pct = fieldsExpected ? (100 * fieldsMatched / fieldsExpected).toFixed(1) : 'n/a';
console.log('projects=' + projects + ' withTYPE=' + projectsWithType + ' duts=' + dutsExpected + ' matched=' + dutsMatched +
  ' fields=' + fieldsExpected + ' fieldMatched=' + fieldsMatched + ' coverage=' + pct + '%');
if (showDiff) for (const d of diffs) console.log('DIFF ' + d.file + ' :: ' + d.dut + ' :: ' + JSON.stringify(d));
const ok = dutsMatched === dutsExpected && fieldsMatched === fieldsExpected;
console.log(ok ? 'result: all DUT fields match' : 'result: MISMATCHES');
process.exitCode = ok ? 0 : 1;
