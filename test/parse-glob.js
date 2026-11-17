#!/usr/bin/env node
'use strict';
/**
 * parse-glob.js - validate global variable lists (object type 0x0d) against .asc.
 *
 * The .asc export prints the global list inside the configuration section:
 *   CONFIGURATION scConfiguration
 *       RESOURCE scResource ON scResourceType
 *           VAR_GLOBAL
 *               key_1 AT %IX0.0: BOOL:=FALSE;
 *                   (*activate/deactivate~A*)
 *           END_VAR
 *       END_RESOURCE
 *   END_CONFIGURATION
 * (.asc comments carry a "~A" language suffix from the exporter.)
 *
 * In the .pro the same variables are declaration records in unnamed data chunks
 * owned by the type 0x0d object: [comment] type init [AT-address] VAR_GLOBAL.
 * Projects that never declare a global variable carry only the empty list header
 * chunk and must decode to zero variables.
 *
 * usage: node test/parse-glob.js <dirWithPairs> [--diff]
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { parseProject, extractContents, globalVariables, parseVariableRecord } = require('../lib/proparse');

let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('ok  ' + name); }
  catch (e) { failed++; process.exitCode = 1; console.log('FAIL ' + name + ': ' + e.message); }
}

// --- synthetic declaration records -----------------------------------------
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; }
function str(s) { return Buffer.concat([u32(s.length), Buffer.from(s, 'utf16le')]); }
function record(name, strings, opts) {
  const o = opts || {};
  const f = Buffer.alloc(2);
  f.writeUInt16LE(o.flags || 0, 0);
  return Buffer.concat([u32(name.length), Buffer.from(name, 'utf16le'), u32(o.typeRef === undefined ? 0xffffffff : o.typeRef), f, ...strings.map(str)]);
}

check('record: comment/type/init/scope', () => {
  const rec = parseVariableRecord(record('gCount', ['', 'INT', '0', 'VAR_GLOBAL']), false);
  assert.ok(rec, 'record decoded');
  assert.strictEqual(rec.name, 'gCount');
  assert.strictEqual(rec.scope, 'VAR_GLOBAL');
  assert.strictEqual(rec.typeName, 'INT');
  assert.strictEqual(rec.initialValue, '0');
  assert.strictEqual(rec.comment, '');
});

check('record: FP address (%IX0.0) variant', () => {
  const rec = parseVariableRecord(record('bFlag', ['', 'BOOL', 'FALSE', '%IX0.0', 'VAR_GLOBAL']), false);
  assert.ok(rec, 'record decoded');
  assert.strictEqual(rec.address, '%IX0.0');
  assert.strictEqual(rec.typeName, 'BOOL');
  assert.strictEqual(rec.initialValue, 'FALSE');
});

check('record: comment is preserved', () => {
  const rec = parseVariableRecord(record('gTemp', ['a comment', 'REAL', '1.0', 'VAR_GLOBAL']), false);
  assert.ok(rec);
  assert.strictEqual(rec.comment, 'a comment');
  assert.strictEqual(rec.typeName, 'REAL');
});

check('record: explicit empty AT slot (Coffee machine "credit")', () => {
  const rec = parseVariableRecord(record('credit', ['', 'INT', '0', '', 'VAR_GLOBAL']), false);
  assert.ok(rec);
  assert.strictEqual(rec.typeName, 'INT', 'type must not be the value token');
  assert.strictEqual(rec.initialValue, '0');
  assert.strictEqual(rec.address, null);
});

check('record: empty initial value is not an AT slot', () => {
  const rec = parseVariableRecord(record('timer', ['', 'TON', '', 'VAR']), false);
  assert.ok(rec);
  assert.strictEqual(rec.typeName, 'TON');
  assert.strictEqual(rec.initialValue, '');
  assert.strictEqual(rec.address, null);
});

check('record with no scope token is rejected in strict mode', () => {
  assert.strictEqual(parseVariableRecord(record('x', ['', 'INT', '0']), false), null);
});

// --- .asc ground truth ------------------------------------------------------
/** CONFIGURATION … VAR_GLOBAL … END_VAR -> [{name,type,init,address}] */
function ascGlobals(text) {
  const out = [];
  let inGlob = false;
  for (const raw of text.split(/\r?\n/)) {
    const t = raw.trim();
    if (!inGlob) {
      if (/^VAR_GLOBAL\b/.test(t) && !t.includes(':')) inGlob = true;
      continue;
    }
    if (t === 'END_VAR') { inGlob = false; continue; }
    if (!t || t.startsWith('(*')) continue;
    const m = /^([A-Za-z_][\w]*)(?:\s+AT\s+([%\w.]+))?\s*:\s*(.+?)\s*(?::=\s*(.*?))?;\s*$/.exec(t);
    if (m) out.push({ name: m[1], address: m[2] || null, type: m[3].trim(), init: (m[4] || '').trim() });
  }
  return out;
}

const dir = process.argv[2] || path.join(__dirname, '..', 'fixtures', 'samples');
const showDiff = process.argv.includes('--diff');

const stats = { projects: 0, withList: 0, expected: 0, matched: 0 };
const diffs = [];
for (const f of fs.readdirSync(dir).filter((x) => x.toLowerCase().endsWith('.pro'))) {
  const proPath = path.join(dir, f);
  const ascPath = proPath.replace(/\.pro$/i, '.asc');
  if (!fs.existsSync(ascPath)) continue;
  stats.projects++;
  const buf = fs.readFileSync(proPath);
  const project = parseProject(buf, { file: proPath });
  const contents = extractContents(buf, project);
  const got = globalVariables(project, contents);
  if (got.lists.length) stats.withList++;
  const expected = ascGlobals(fs.readFileSync(ascPath, 'utf8'));
  stats.expected += expected.length;
  const pool = got.variables.slice();
  for (const e of expected) {
    const idx = pool.findIndex((g) => g.name === e.name && g.typeName === e.type && g.initialValue === e.init && (g.address || null) === e.address);
    if (idx >= 0) { pool.splice(idx, 1); stats.matched++; }
    else if (diffs.length < 10) {
      const loose = got.variables.find((g) => g.name === e.name);
      diffs.push({ file: f, name: e.name, asc: e, pro: loose ? { type: loose.typeName, init: loose.initialValue, address: loose.address } : null });
    }
  }
  if (pool.length && diffs.length < 10) diffs.push({ file: f, reason: 'extra .pro variables', extra: pool.slice(0, 4).map((v) => v.name) });
}

check('every project exposes a global variable list object', () => {
  assert.strictEqual(stats.withList, stats.projects, 'withList=' + stats.withList + ' projects=' + stats.projects);
});

check('decoded global variables match the .asc configuration section', () => {
  assert.strictEqual(stats.matched, stats.expected, 'matched ' + stats.matched + ' of ' + stats.expected + ' expected');
  assert.strictEqual(stats.expected, stats.matched, 'coverage');
});

console.log('projects=' + stats.projects + ' withGlobalList=' + stats.withList +
  ' varsExpected=' + stats.expected + ' matched=' + stats.matched +
  ' coverage=' + (stats.expected ? (100 * stats.matched / stats.expected).toFixed(1) : 'n/a') + '%');
if (showDiff) for (const d of diffs) console.log('DIFF ' + JSON.stringify(d));
console.log('---');
console.log('passed=' + passed + (failed ? ' failed=' + failed : ' all ok'));
