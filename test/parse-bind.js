#!/usr/bin/env node
'use strict';
/**
 * parse-bind.js - validate decoded PROGRAM -> task assignments against the .asc
 * "PROGRAM <name> WITH <task>: scProgramType" declarations.
 *
 * .pro layout (recovered 2026-11-17):
 *   - every task is a child object (type 0x0E) of the type 0x12 "Tasks" folder;
 *   - each assigned PROGRAM owns one kind 4 content frame under the task object:
 *       u32 nameLen + UTF-16LE name + u32 0xFFFFFFFF + 6 zero bytes
 *     (frames are in assignment order and keep the PROGRAM's original case);
 *   - the task's kind 6 settings frame ends with
 *       u32 0xFFFFFFFF + u32 count + count u32 ids
 *     where the ids are FPWIN's per-assignment numbers (same order, own numbering).
 *
 * usage: node test/parse-bind.js <dirWithPairs> [--diff]
 */
const fs = require('fs');
const path = require('path');
const { parseProject, extractContents, tasks } = require('../lib/proparse');

const WITH_RE = /PROGRAM\s+([A-Za-z_]\w*)\s+WITH\s+(?:@'([^']+)'|([A-Za-z_]\w*))\s*:\s*\w+/g;

/** .asc PROGRAM ... WITH ... lines -> [{program, task}] */
function ascBindings(text) {
  const out = [];
  let m;
  WITH_RE.lastIndex = 0;
  while ((m = WITH_RE.exec(text))) out.push({ program: m[1], task: m[2] || m[3] });
  return out;
}

const dir = process.argv[2] || path.join(__dirname, '..', 'fixtures', 'samples');
const showDiff = process.argv.includes('--diff');
let projects = 0, withBindings = 0, expected = 0, matched = 0, countMismatch = 0;
const diffs = [];
for (const f of fs.readdirSync(dir).filter((x) => x.toLowerCase().endsWith('.pro'))) {
  const proPath = path.join(dir, f);
  const ascPath = proPath.replace(/\.pro$/i, '.asc');
  if (!fs.existsSync(ascPath)) continue;
  projects++;
  const buf = fs.readFileSync(proPath);
  const project = parseProject(buf, { file: proPath });
  const contents = extractContents(buf, project);
  const proTasks = tasks(project, contents);
  const byName = new Map(proTasks.map((t) => [t.name, t]));
  const want = ascBindings(fs.readFileSync(ascPath, 'utf8'));
  if (want.length) withBindings++;
  for (const e of want) {
    expected++;
    const t = byName.get(e.task);
    if (!t) { diffs.push({ file: f, task: e.task, reason: 'task object missing in .pro' }); continue; }
    if (t.programs.includes(e.program)) matched++;
    else diffs.push({ file: f, task: e.task, program: e.program, pro: t.programs });
  }
  for (const t of proTasks) {
    if (t.programs.length !== t.programIds.length) {
      countMismatch++;
      diffs.push({ file: f, task: t.name, reason: 'assignment count mismatch', programs: t.programs.length, ids: t.programIds.length });
    }
  }
}

const okAll = matched === expected && expected > 0 && countMismatch === 0;
console.log('projects=' + projects + ' withBindings=' + withBindings + ' bindings=' + expected +
  ' matched=' + matched + ' coverage=' + (expected ? (100 * matched / expected).toFixed(1) : 'n/a') + '%' +
  ' countMismatch=' + countMismatch);
if (showDiff) for (const d of diffs) console.log('DIFF ' + JSON.stringify(d));
console.log(okAll ? 'result: all exported PROGRAM -> task bindings match' : 'result: MISMATCHES');
process.exitCode = okAll ? 0 : 1;
