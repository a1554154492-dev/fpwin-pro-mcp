#!/usr/bin/env node
'use strict';
/**
 * parse-sfc.js - validate decoded SFC charts against .asc SFC exports.
 *
 * .asc exports an SFC POU as a text chart:
 *   'SFC'
 *   SFC *
 *   INITIAL_STEP #17#select_drink :
 *   % a_select_drink
 *   % green_light\tN
 *   END_STEP
 *   TRANSITION #18#enough_money FROM #17#select_drink TO #19#return_money
 *   %%BODY LD 0
 *   ... BODY ... END_BODY
 *   END_TRANSITION
 *   FINAL_STEP #32# :
 *   END_SFC
 * and later ACTION <name> : %%BODY ... END_BODY blocks.
 *
 * .pro stores the chart as a binary element stream (see lib/proparse.js
 * parseSfcChart); element bodies (transition/action text) are ordinary text
 * content frames. This test compares element names/kinds, step action lists,
 * transition bodies (language + BODY text) and action definitions.
 *
 * usage: node test/parse-sfc.js <dirWithPairs> [--diff]
 */
const fs = require('fs');
const path = require('path');
const { parseProject, extractContents, sfcCharts } = require('../lib/proparse');

const POU_RE = /^(?:PROGRAM|FUNCTION_BLOCK|FUNCTION)\s+([A-Za-z_\u00c0-\uffff][\w\u00c0-\uffff]*)/;
const STEP_RE = /^(INITIAL_STEP|STEP|FINAL_STEP)\s+#\d+#([^\s:]*)\s*:/;
const TRANS_RE = /^TRANSITION\s+#\d+#([^\s:]*)\s+FROM\s+.+?\s+TO\s+/;
const TRANS_FULL_RE = /^TRANSITION\s+#\d+#([^\s:]*)\s+FROM\s+(.+?)\s+TO\s+(.+)$/;
const BODY_HEAD_RE = /^%%BODY\s+([A-Z]+)\b/;
const ACTION_DEF_RE = /^ACTION\s+([^\s:]+)\s*:/;

// "#17#select_drink,#19#return_money" -> ['select_drink','return_money']
function targetNames(list) {
  const out = [];
  for (const m of list.matchAll(/#\d+#([^\s,#()]*)/g)) out.push(m[1]);
  return out;
}

function parseAsc(text) {
  const charts = new Map();
  const actions = new Map();
  let pou = null, inSfc = false, inBody = false, bodyTarget = null, bodyBuf = [], bodyLang = null;
  let chart = null, lastTransition = null, lastStep = null;
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (inBody) {
      if (line === 'END_BODY') {
        const body = bodyBuf.join('\n');
        if (bodyTarget && bodyTarget.kind === 'transition') { bodyTarget.ref.body = body; bodyTarget.ref.hasBody = true; }
        else if (bodyTarget && bodyTarget.kind === 'action') actions.set(bodyTarget.name, { lang: bodyTarget.lang, body });
        inBody = false; bodyTarget = null; bodyBuf = []; bodyLang = null;
        continue;
      }
      bodyBuf.push(raw);
      continue;
    }
    const m = POU_RE.exec(line);
    if (m) { pou = m[1]; inSfc = false; chart = null; lastStep = null; lastTransition = null; continue; }
    if (/^'SFC'/.test(line)) { inSfc = false; continue; }
    if (line === 'SFC *') {
      inSfc = true;
      chart = { initial: null, steps: [], transitions: [], hasFinal: false };
      charts.set(pou, chart);
      continue;
    }
    if (line === 'END_SFC') { inSfc = false; lastTransition = null; continue; }
    const ad = ACTION_DEF_RE.exec(line);
    if (ad) { bodyTarget = { kind: 'action', name: ad[1], lang: null }; bodyLang = null; continue; }
    const bh = BODY_HEAD_RE.exec(line);
    if (bh) {
      const lang = bh[1];
      if (lastTransition && !lastTransition.lock) {
        lastTransition.lang = lang;
        lastTransition.lock = true;
        bodyTarget = { kind: 'transition', ref: lastTransition };
      } else if (bodyTarget && bodyTarget.kind === 'action') {
        bodyTarget.lang = lang;
      }
      inBody = true; bodyBuf = []; bodyLang = lang;
      continue;
    }
    if (!inSfc || !chart) continue;
    const sm = STEP_RE.exec(line);
    if (sm) {
      const kind = sm[1], name = sm[2];
      if (kind === 'INITIAL_STEP') { chart.initial = name; lastStep = { name, actions: [] }; chart.steps.push(lastStep); }
      else if (kind === 'STEP') { lastStep = { name, actions: [] }; chart.steps.push(lastStep); }
      else { chart.hasFinal = true; chart.finalName = name; lastStep = null; }
      lastTransition = null;
      continue;
    }
    const tm = TRANS_RE.exec(line);
    if (tm) {
      lastTransition = { name: tm[1], hasBody: false, body: null, lang: null, from: [], to: [] };
      const full = TRANS_FULL_RE.exec(line);
      if (full) { lastTransition.from = targetNames(full[2]); lastTransition.to = targetNames(full[3]); }
      chart.transitions.push(lastTransition);
      lastStep = null;
      continue;
    }
    if (/^%(?!%)/.test(line) && lastStep) {
      const parts = line.slice(1).split('\t');
      const name = (parts[0] || '').trim();
      const qualifier = (parts[1] || '').trim() || null;
      if (name) lastStep.actions.push({ name, qualifier });
    }
  }
  // resolve transition bodies (stored on lastTransition during scan)
  return { charts, actions };
}

function norm(s) {
  return s
    .replace(/\r\n/g, '\n')
    .replace(/^\s*END_BODY\s*$/gm, '')
    .replace(/\?[A-Za-z_@][A-Za-z0-9_@']*/g, '')
    .replace(/[^\x20-\x7e\n\t]/g, '?')
    .split('\n').map((l) => l.replace(/[ \t]+$/, '')).join('\n').trim();
}
function shape(text) {
  const idents = new Set();
  for (const m of text.matchAll(/[A-Za-z_@][A-Za-z0-9_.@:]{1,}/g)) idents.add(m[0]);
  return { idents, networks: (text.match(/NET_WORK\b/g) || []).length };
}
function jaccard(a, b) {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 1 : inter / union;
}

const dir = process.argv[2];
if (!dir) { console.error('usage: parse-sfc.js <dir> [--diff]'); process.exit(2); }
const showDiff = process.argv.includes('--diff');
let projects = 0, sfcPous = 0, chartsEqual = 0;
let stepExpected = 0, stepMatched = 0, actionExpected = 0, actionMatched = 0;
let transExpected = 0, transMatched = 0, transLangExpected = 0, transLangMatched = 0;
let transBodies = 0, transBodyEqual = 0, transBodyStructural = 0;
let actionBodies = 0, actionBodyEqual = 0;
let wiringExpected = 0, wiringMatched = 0;
const diffs = [];
for (const f of fs.readdirSync(dir).filter((x) => x.toLowerCase().endsWith('.pro'))) {
  const proPath = path.join(dir, f);
  const ascPath = proPath.replace(/\.pro$/i, '.asc');
  if (!fs.existsSync(ascPath)) continue;
  projects++;
  const buf = fs.readFileSync(proPath);
  const project = parseProject(buf, { file: proPath });
  const contents = extractContents(buf, project);
  const asc = parseAsc(fs.readFileSync(ascPath, 'utf8'));
  const proCharts = sfcCharts(project, contents);
  const proByName = new Map(proCharts.map((c) => [c.pou, c]));
  for (const [pou, want] of asc.charts) {
    sfcPous++;
    const got = proByName.get(pou);
    if (!got) { diffs.push({ file: f, pou, reason: 'chart missing in .pro' }); continue; }
    const problems = [];
    if (got.counts.initialSteps !== 1) problems.push('initialSteps=' + got.counts.initialSteps);
    if ((got.counts.finalSteps === 1) !== want.hasFinal) problems.push('hasFinal=' + (got.counts.finalSteps === 1) + ' want ' + want.hasFinal);
    const gotSteps = got.elements.filter((e) => e.kind === 6).map((e) => e.name);
    const wantSteps = want.steps.filter((s) => s.name !== want.initial).map((s) => s.name);
    const gotInitial = (got.elements.find((e) => e.kind === 2) || {}).name || null;
    if (gotInitial !== want.initial) problems.push('initial ' + gotInitial + ' != ' + want.initial);
    // element order follows the chart walk (branch traversal order differs from
    // the export order), so compare as multisets
    if (JSON.stringify(gotSteps.slice().sort()) !== JSON.stringify(wantSteps.slice().sort())) {
      problems.push('steps ' + JSON.stringify(gotSteps) + ' != ' + JSON.stringify(wantSteps));
    }
    // steps actions
    for (const ws of want.steps) {
      stepExpected++;
      const ge = got.elements.find((e) => (e.kind === 6 || e.kind === 2) && e.name === ws.name);
      if (!ge) { problems.push('step ' + ws.name + ' missing'); continue; }
      stepMatched++;
      const ga = (ge.actions || []).map((a) => a.name + (a.qualifier ? '/' + a.qualifier : ''));
      const wa = ws.actions.map((a) => a.name + (a.qualifier ? '/' + a.qualifier : ''));
      actionExpected += wa.length; actionMatched += wa.filter((x) => ga.includes(x)).length;
      if (JSON.stringify(ga) !== JSON.stringify(wa)) problems.push('actions ' + ws.name + ' ' + JSON.stringify(ga) + ' != ' + JSON.stringify(wa));
    }
    // transitions
    const gotTrans = got.elements.filter((e) => e.kind === 8).map((e) => e.name);
    const wantTrans = want.transitions.map((t) => t.name);
    if (JSON.stringify(gotTrans.slice().sort()) !== JSON.stringify(wantTrans.slice().sort())) {
      problems.push('transitions ' + JSON.stringify(gotTrans) + ' != ' + JSON.stringify(wantTrans));
    }
    for (const wt of want.transitions) {
      transExpected++;
      const gt = got.elements.find((e) => e.kind === 8 && e.name === wt.name);
      if (!gt) { problems.push('transition ' + wt.name + ' missing'); continue; }
      transMatched++;
      if (gt.hasBody !== wt.hasBody) problems.push('transition ' + wt.name + ' hasBody ' + gt.hasBody + ' != ' + wt.hasBody);
      // FROM/TO wiring (prefix link table)
      if (wt.from.length || wt.to.length) {
        wiringExpected += 2;
        const gf = (gt.from || []).slice().sort(), wf = wt.from.slice().sort();
        const gtTo = (gt.to || []).slice().sort(), wtTo = wt.to.slice().sort();
        if (JSON.stringify(gf) === JSON.stringify(wf)) wiringMatched++;
        else problems.push('transition ' + wt.name + ' FROM ' + JSON.stringify(gt.from) + ' != ' + JSON.stringify(wt.from));
        if (JSON.stringify(gtTo) === JSON.stringify(wtTo)) wiringMatched++;
        else problems.push('transition ' + wt.name + ' TO ' + JSON.stringify(gt.to) + ' != ' + JSON.stringify(wt.to));
      }
      if (wt.hasBody) {
        transLangExpected++;
        if (gt.language === wt.lang) transLangMatched++;
        else problems.push('transition ' + wt.name + ' lang ' + gt.language + ' != ' + wt.lang);
        transBodies++;
        const g = shape(norm(gt.body || ''));
        const w = shape(norm(wt.body || ''));
        if (norm(gt.body || '') === norm(wt.body || '')) transBodyEqual++;
        else if (jaccard(g.idents, w.idents) >= 0.98 && g.networks === w.networks) { transBodyEqual++; transBodyStructural++; }
        else problems.push('transition body ' + wt.name + ' differs');
      }
    }
    if (!problems.length) chartsEqual++;
    else if (diffs.length < 8) diffs.push({ file: f, pou, problems });
  }
  // action bodies (ACTION blocks)
  for (const [name, want] of asc.actions) {
    const got = proCharts.flatMap((c) => c.elements.flatMap((e) => (e.actions || []).filter((a) => a.sectionName === name)));
    if (!got.length) continue;
    actionBodies++;
    const g = norm(got[0].body || ''), w = norm(want.body || '');
    if (g === w) actionBodyEqual++;
    else {
      const gs = shape(g), ws = shape(w);
      if (jaccard(gs.idents, ws.idents) >= 0.98 && gs.networks === ws.networks) actionBodyEqual++;
      else if (diffs.length < 8) diffs.push({ file: f, action: name, reason: 'action body differs' });
    }
  }
}
console.log('projects=' + projects + ' sfcPous=' + sfcPous + ' chartsEqual=' + chartsEqual +
  ' steps=' + stepMatched + '/' + stepExpected + ' actions=' + actionMatched + '/' + actionExpected +
  ' transitions=' + transMatched + '/' + transExpected +
  ' transitionLang=' + transLangMatched + '/' + transLangExpected +
  ' transitionBodies=' + transBodyEqual + '/' + transBodies + ' (structural=' + transBodyStructural + ')' +
  ' actionBodies=' + actionBodyEqual + '/' + actionBodies +
  ' wiring=' + wiringMatched + '/' + wiringExpected);
const okAll = chartsEqual === sfcPous && stepMatched === stepExpected && actionMatched === actionExpected &&
  transMatched === transExpected && transLangMatched === transLangExpected &&
  transBodyEqual === transBodies && actionBodyEqual === actionBodies &&
  wiringMatched === wiringExpected && sfcPous > 0;
if (showDiff) for (const d of diffs) console.log('DIFF ' + JSON.stringify(d));
console.log(okAll ? 'result: all SFC charts match' : 'result: MISMATCHES');
process.exitCode = okAll ? 0 : 1;
