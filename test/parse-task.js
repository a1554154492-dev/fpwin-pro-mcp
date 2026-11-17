#!/usr/bin/env node
'use strict';
/**
 * parse-task.js - validate decoded task settings against .asc TASK blocks.
 *
 * .asc exports the configured tasks inside the configuration section:
 *   TASK
 *       @'Timer Interrupt'(SINGLE:=FALSE, INTERVAL:=T#10ms, PRIORITY:=31)
 *   TASK
 *       Programs(SINGLE:=TRUE, INTERVAL:=0, PRIORITY:=31)
 * .pro stores every task as a child object (type 0x0E) of the type 0x12
 * "Tasks" folder; each child owns a kind 6 frame "0xFFFFFFFF + strings
 * [SINGLE, INTERVAL, PRIORITY]".
 *
 * The .pro keeps the full template task set (27 entries: Programs, Programs 2,
 * Interrupt 0…23, Timer Interrupt) for every project; the .asc only prints the
 * tasks the selected PLC model supports (e.g. 6 interrupts for an FP-X). The
 * assertion is therefore: every exported task exists and its settings match.
 *
 * usage: node test/parse-task.js <dirWithPairs> [--diff]
 */
const fs = require('fs');
const path = require('path');
const { parseProject, extractContents, tasks } = require('../lib/proparse');

const TASK_RE = /TASK\s*\r?\n\s*(?:@'([^']+)'|([A-Za-z_][\w]*))\s*\(([^)]*)\)/g;
const PARAM_RE = /(SINGLE|INTERVAL|PRIORITY)\s*:=\s*([^,)]+)/g;

/** .asc TASK blocks -> [{name, single, interval, priority}] */
function ascTasks(text) {
  const out = [];
  let m;
  TASK_RE.lastIndex = 0;
  while ((m = TASK_RE.exec(text))) {
    const t = { name: m[1] || m[2], single: null, interval: null, priority: null };
    let p;
    PARAM_RE.lastIndex = 0;
    while ((p = PARAM_RE.exec(m[3]))) {
      const key = p[1].toLowerCase();
      t[key] = p[2].trim();
    }
    out.push(t);
  }
  return out;
}

const dir = process.argv[2] || path.join(__dirname, '..', 'fixtures', 'samples');
const showDiff = process.argv.includes('--diff');
let projects = 0, withTasks = 0, expected = 0, matched = 0, fieldsExpected = 0, fieldsMatched = 0;
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
  const expectedTasks = ascTasks(fs.readFileSync(ascPath, 'utf8'));
  if (!expectedTasks.length) continue;
  withTasks++;
  const byName = new Map(proTasks.map((t) => [t.name, t]));
  for (const e of expectedTasks) {
    expected++;
    const g = byName.get(e.name);
    if (!g) { diffs.push({ file: f, task: e.name, reason: 'task object missing in .pro' }); continue; }
    matched++;
    for (const k of ['single', 'interval', 'priority']) {
      fieldsExpected++;
      if ((g[k] || null) === (e[k] || null)) fieldsMatched++;
      else if (diffs.length < 10) diffs.push({ file: f, task: e.name, field: k, asc: e[k], pro: g[k] });
    }
  }
}

const okAll = matched === expected && fieldsMatched === fieldsExpected && fieldsExpected > 0;
console.log('projects=' + projects + ' withTasks=' + withTasks + ' tasks=' + expected + ' matched=' + matched +
  ' settings=' + fieldsExpected + ' settingsMatched=' + fieldsMatched +
  ' coverage=' + (fieldsExpected ? (100 * fieldsMatched / fieldsExpected).toFixed(1) : 'n/a') + '%');
if (showDiff) for (const d of diffs) console.log('DIFF ' + JSON.stringify(d));
console.log(okAll ? 'result: all exported task settings match' : 'result: MISMATCHES');
process.exitCode = okAll ? 0 : 1;
