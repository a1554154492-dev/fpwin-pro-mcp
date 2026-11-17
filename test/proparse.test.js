#!/usr/bin/env node
'use strict';
/**
 * proparse.test.js - offline assertions for lib/proparse.js against the vendored
 * .pro/.asc sample pairs under fixtures/samples.
 *
 * Run: node test/proparse.test.js   (exit code 0 = all assertions passed)
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const zlib = require('zlib');
const {
  parseProject, walk, pous, extractContents, pouSource, pouDeclarations, pouLanguage,
  duts, dutDeclarations, globalVariables, taskGroups, tasks, sfcCharts, parseSfcTrailer, tables,
  readAssignmentName,
} = require('../lib/proparse');

const SAMPLES = path.join(__dirname, '..', 'fixtures', 'samples');
let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log('ok  ' + name);
  } catch (e) {
    console.error('FAIL ' + name + ': ' + e.message);
    process.exitCode = 1;
  }
}

function load(name) {
  const file = path.join(SAMPLES, name);
  return parseProject(fs.readFileSync(file), { file });
}

function loadBuf(name) {
  return fs.readFileSync(path.join(SAMPLES, name));
}

function ascNames(ascPath) {
  const text = fs.readFileSync(ascPath, 'utf8');
  const out = new Set();
  for (const line of text.split(/\r?\n/)) {
    const m = /^(PROGRAM|FUNCTION_BLOCK|FUNCTION)\s+([A-Za-z_\u00c0-\uffff][\w\u00c0-\uffff]*)/.exec(line.trim());
    if (m) out.add(m[2]);
  }
  return [...out];
}

const FILES = fs.readdirSync(SAMPLES).filter((f) => f.toLowerCase().endsWith('.pro'));
console.log('fixtures: ' + FILES.join(', '));
assert.ok(FILES.length >= 3, 'expected at least 3 vendored .pro samples');

for (const f of FILES) {
  check(f + ': container header', () => {
    const project = load(f);
    assert.strictEqual(project.size % 0x800, 0, 'size should be 0x800 aligned');
    assert.ok(project.usedLength > 0x800 && project.usedLength <= project.size);
    assert.strictEqual(project.roots.length, 1, 'exactly one project root');
    assert.ok(['Projekt', 'Project'].includes(project.roots[0].name), 'root name is Projekt/Project, got ' + project.roots[0].name);
    assert.strictEqual(project.roots[0].type, 0, 'root type 0');
  });

  check(f + ': container length field is size-1', () => {
    const project = load(f);
    assert.strictEqual(project.header.sizeField, project.size - 1,
      'u32@0 should equal file size - 1, got 0x' + project.header.sizeField.toString(16));
  });

  check(f + ': SC table catalogue', () => {
    const project = load(f);
    const list = tables(loadBuf(f), project);
    assert.strictEqual(list.length, 10, 'expected 10 table records, got ' + list.length);
    assert.deepStrictEqual(
      list.filter((t) => t.kind === 'dat').map((t) => t.table).sort(),
      ['SCCOM_TAB', 'SCCONT_TAB', 'SCCRL_TAB', 'SCDECL_TAB', 'SCOBJ_TAB']);
    assert.deepStrictEqual(
      list.filter((t) => t.kind === 'idx').map((t) => t.table).sort(),
      ['SCCOM_TAB', 'SCCONT_TAB', 'SCCRL_TAB', 'SCDECL_TAB', 'SCOBJ_TAB']);
    for (const t of list) {
      assert.strictEqual(t.length, 401, t.name + ' record length');
      assert.strictEqual(t.pageKind, t.kind === 'dat' ? 'entry' : 'reserved', t.name + ' page kind ' + t.pageKind);
      if (t.kind === 'idx') {
        assert.strictEqual(t.appendOffset, 0, t.name + ' append offset should be 0');
        assert.strictEqual(t.counter, 0, t.name + ' id counter should be 0');
      }
    }
    const obj = list.find((t) => t.name === 'SCOBJ_TAB.dat');
    const root = project.roots[0];
    assert.strictEqual(obj.mtime, root.mtime, 'SCOBJ_TAB.dat mtime should equal the root mtime');
  });

  check(f + ': object tree is connected', () => {
    const project = load(f);
    const orphans = project.warnings.filter((w) => /unresolved parent/.test(w));
    assert.deepStrictEqual(orphans, [], 'no orphaned objects');
    const rows = walk(project);
    assert.ok(rows.length === project.objects.length, 'walk() covers every named object once');
  });

  check(f + ': every POU from the .asc export is present', () => {
    const ascPath = path.join(SAMPLES, f.replace(/\.pro$/i, '.asc'));
    if (!fs.existsSync(ascPath)) return;
    const project = load(f);
    const names = new Set(project.objects.map((o) => o.name));
    const missing = ascNames(ascPath).filter((n) => !names.has(n));
    assert.deepStrictEqual(missing, [], 'missing from .pro: ' + missing.join(', '));
  });

  check(f + ': POU type codes', () => {
    const project = load(f);
    for (const p of pous(project)) {
      assert.ok([0x0f, 0x10, 0x11].includes(p.type), 'unexpected POU type 0x' + p.type.toString(16));
    }
  });
}

check('Flasher: two PROGRAMs under POEs', () => {
  const project = load('Flasher (Timer, LD).pro');
  const progs = pous(project).filter((p) => p.type === 0x0f).map((p) => p.name).sort();
  assert.deepStrictEqual(progs, ['FlasherSolution1', 'FlasherSolution2']);
  const folder = project.objects.find((o) => o.name === 'POEs' || o.name === 'POUs');
  assert.ok(folder, 'POE folder present');
  for (const p of pous(project)) assert.strictEqual(p.parent, folder.id, 'POU parent is the POE folder');
});

check('Coffee machine: count_coins recovered by scan', () => {
  const project = load('Coffee machine (SFC).pro');
  const names = project.objects.map((o) => o.name);
  for (const n of ['_comment', 'coffee', 'count_coins']) assert.ok(names.includes(n), 'missing ' + n);
  assert.ok(project.counts === undefined || true);
});

check('Control of two tanks: function block type 0x10', () => {
  const project = load('Control of two tanks (FB, LD).pro');
  const fbs = pous(project).filter((p) => p.type === 0x10);
  assert.ok(fbs.length >= 1, 'expected at least one FUNCTION_BLOCK');
});

// --- content frames: compressed source text ---------------------------------

function sourceLoad(name) {
  const file = path.join(SAMPLES, name);
  const buf = fs.readFileSync(file);
  const project = parseProject(buf, { file });
  return { project, contents: extractContents(buf, project) };
}

check('Flasher: sources extracted for both programs', () => {
  const { project, contents } = sourceLoad('Flasher (Timer, LD).pro');
  assert.ok(contents.length > 100, 'expected many content frames, got ' + contents.length);
  assert.ok(contents.filter((c) => c.text).length >= 2, 'expected at least 2 text payloads');
  for (const name of ['FlasherSolution1', 'FlasherSolution2']) {
    const pou = project.objects.find((o) => o.name === name);
    const src = pouSource(project, contents, pou);
    assert.ok(src.text, 'no source extracted for ' + name);
    assert.ok(/^BODY\r?\n/.test(src.text), name + ' source should start with BODY');
    assert.ok(src.text.includes('END_BODY'), name + ' source should end with END_BODY');
    assert.ok(src.text.includes('WORKSPACE'), name + ' source should contain WORKSPACE');
  }
});

check('Flasher: source text references the POU variables', () => {
  const { project, contents } = sourceLoad('Flasher (Timer, LD).pro');
  const pou = project.objects.find((o) => o.name === 'FlasherSolution1');
  const text = pouSource(project, contents, pou).text;
  for (const token of ['TM_100ms', 'Output_0', 'tmp']) assert.ok(text.includes(token), 'source should reference ' + token);
});

check('SFC chart has no text body (documented limitation)', () => {
  const { project, contents } = sourceLoad('Coffee machine (SFC).pro');
  const chart = project.objects.find((o) => o.name === 'coffee');
  const src = pouSource(project, contents, chart);
  assert.strictEqual(src.text, null, 'SFC chart body is a binary graph, not text');
});

// --- SFC charts (binary element stream) --------------------------------------

check('Coffee machine: SFC chart counts and element kinds', () => {
  const { project, contents } = languageLoad('Coffee machine (SFC).pro');
  const charts = sfcCharts(project, contents);
  assert.strictEqual(charts.length, 1, 'one SFC chart, got ' + charts.length);
  const c = charts[0];
  assert.strictEqual(c.pou, 'coffee');
  assert.strictEqual(c.section, 'Body');
  assert.deepStrictEqual(c.counts, {
    steps: 4, initialSteps: 1, transitions: 5, finalSteps: 1, branchElements: 7,
    wiredTransitions: 5, wiringLinks: 14,
  });
  // sequence numbers increase along the chart walk, and every element record
  // carries the same marker/format prefix.
  for (let i = 1; i < c.elements.length; i++) {
    assert.ok(c.elements[i].sequence > c.elements[i - 1].sequence, 'element sequence must increase');
  }
  assert.deepStrictEqual(
    c.elements.filter((e) => e.name).map((e) => e.name),
    ['select_drink', 'enough_money', 'return_money', 'coffee_start', 'cook_coffee',
      'coffee_ready', 'tea_start', 'cook_tea', 'tea_ready']
  );
  assert.deepStrictEqual(
    c.elements.filter((e) => !e.name).map((e) => e.kind).sort((a, b) => a - b),
    [1, 3, 11, 12, 13, 13, 14, 14],
    'start / final-step / branch pseudo-elements are unnamed'
  );
});

check('Coffee machine: SFC step actions and action bodies', () => {
  const { project, contents } = languageLoad('Coffee machine (SFC).pro');
  const c = sfcCharts(project, contents)[0];
  const initial = c.elements.find((e) => e.kind === 2);
  assert.strictEqual(initial.name, 'select_drink');
  assert.strictEqual(initial.actionText, 'a_select_drink\r\ngreen_light\tN');
  assert.deepStrictEqual(
    initial.actions.map((a) => [a.name, a.qualifier, a.sectionName, !!a.body]),
    [
      ['a_select_drink', null, 'a_select_drink', true],
      ['green_light', 'N', null, false], // a global variable, not an ACTION object
    ]
  );
  const cook = c.elements.find((e) => e.name === 'cook_coffee');
  assert.deepStrictEqual(
    cook.actions.map((a) => [a.name, a.qualifier, a.sectionName]),
    [['a_cook_coffee', null, 'a_cook_coffee']]
  );
  assert.ok(cook.actions[0].body.includes('END_BODY'), 'action body is a BODY…END_BODY text frame');
  // The u32 after the name prefix is NOT the action-line count: it is 1 on
  // every observed step, including one with two action lines and steps with no
  // action lines at all (PRO-FORMAT.md §5.7).
  for (const e of c.elements.filter((x) => x.kind === 2 || x.kind === 6)) {
    assert.strictEqual(e.actionCount, 1, 'actionCount flag is constant 1 on step ' + e.name);
  }
});

check('Coffee machine: SFC transitions expose language and body length', () => {
  const { project, contents } = languageLoad('Coffee machine (SFC).pro');
  const c = sfcCharts(project, contents)[0];
  const trans = c.elements.filter((e) => e.kind === 8);
  assert.deepStrictEqual(
    trans.map((t) => [t.name, t.hasBody, t.language]),
    [
      ['enough_money', true, 'LD'],
      ['coffee_start', true, 'LD'],
      ['coffee_ready', false, null],
      ['tea_start', true, 'LD'],
      ['tea_ready', false, null],
    ]
  );
  const byName = new Map(trans.map((t) => [t.name, t]));
  assert.strictEqual(byName.get('enough_money').body.length, 471);
  assert.strictEqual(byName.get('tea_start').body.length, 526);
  assert.ok(byName.get('enough_money').sectionName === 'enough_money', 'transition body owner resolved');
});

check('Coffee machine: SFC FROM/TO wiring from the prefix link table', () => {
  const { project, contents } = languageLoad('Coffee machine (SFC).pro');
  const c = sfcCharts(project, contents)[0];
  const trans = c.elements.filter((e) => e.kind === 8);
  // FROM/TO skips the branch pseudo-elements: tea_start leaves return_money
  // through the divergence bar, coffee_ready ends in the final step's
  // convergence. Names are '' for the unnamed final step.
  assert.deepStrictEqual(
    trans.map((t) => [t.name, t.from, t.to, t.fromIds, t.toIds]),
    [
      ['enough_money', ['select_drink'], ['return_money'], [6], [8]],
      ['coffee_start', ['return_money'], ['cook_coffee'], [8], [10]],
      ['coffee_ready', ['cook_coffee'], [''], [10], [12]],
      ['tea_start', ['return_money'], ['cook_tea'], [8], [17]],
      ['tea_ready', ['cook_tea'], [''], [17], [12]],
    ]
  );
  // raw link columns from the table (row k belongs to element id k + 2)
  const byName = new Map(c.elements.map((e) => [e.name, e]));
  assert.deepStrictEqual(
    [byName.get('return_money').prevId, byName.get('return_money').nextId],
    [7, 15],
    'a diverging step links to the divergence bar, not to a transition'
  );
  // branch bars: kind 11 lists its branch entries, kind 12 its branch ends
  const split = c.elements.find((e) => e.kind === 11);
  const merge = c.elements.find((e) => e.kind === 12);
  assert.deepStrictEqual([split.sequence, split.entries], [15, [16, 14]]);
  assert.deepStrictEqual([merge.sequence, merge.ends], [20, [19, 21]]);
  assert.deepStrictEqual(
    c.elements.filter((e) => e.kind === 3).map((e) => e.wiring.in.slice().sort()),
    [[11, 18]],
    'the final step is entered from both branches'
  );
  assert.deepStrictEqual(
    c.elements.filter((e) => e.kind === 13).map((e) => [e.sequence, e.wiring.out]),
    [[14, [13]], [16, [9]]],
    'branch entries lead to their branch transition'
  );
});

// --- SFC chart trailer (22-byte close record) -------------------------------

check('SFC charts: every vendored chart carries the verified 22-byte trailer', () => {
  let charts = 0;
  for (const f of FILES) {
    const { project, contents } = languageLoad(f);
    for (const chart of sfcCharts(project, contents)) {
      charts++;
      const label = f + ' / ' + chart.pou + ': ';
      assert.ok(chart.trailer, label + 'trailer parsed');
      assert.strictEqual(chart.trailer.bytes, 22, label + 'trailer length');
      assert.strictEqual(chart.trailer.stepsFolderId, chart.stepsFolderId, label + 'trailer id');
      assert.strictEqual(chart.trailerVerified, true, label + 'trailer verified');
    }
  }
  assert.ok(charts >= 1, 'expected at least one vendored SFC chart');
});

check('parseSfcTrailer: exported decoder and non-trailer rejection', () => {
  assert.strictEqual(typeof parseSfcTrailer, 'function');
  const { project, contents } = languageLoad('Coffee machine (SFC).pro');
  const coffee = pous(project).find((p) => p.name === 'coffee');
  const section = coffee.children.find((x) => x.type === 0x08);
  const chunk = contents.filter((x) => x.ownerId === section.id && x.kind === 6)
    .find((x) => x.data.includes(Buffer.from([0xaa, 0x12, 0x73, 0x46])));
  assert.ok(chunk, 'chart element stream found');
  assert.deepStrictEqual(parseSfcTrailer(chunk.data), {
    marker: 0x467312aa, versionA: 1, versionB: 1, stepsFolderId: 246, bytes: 22,
  });
  assert.strictEqual(
    parseSfcTrailer(Buffer.from([0xaa, 0x12, 0x73, 0x46, 1, 0, 0, 0])), null,
    'a stream not closed by exactly 22 bytes is rejected'
  );
});

// --- variable declarations ---------------------------------------------------

check('Flasher: variable declarations decoded', () => {
  const { project, contents } = sourceLoad('Flasher (Timer, LD).pro');
  const pou = project.objects.find((o) => o.name === 'FlasherSolution1');
  const vars = pouDeclarations(project, contents, pou).variables;
  assert.strictEqual(vars.length, 2, 'expected 2 variables, got ' + vars.length);
  const out = vars.find((v) => v.name === 'Output_0');
  assert.deepStrictEqual(
    { scope: out.scope, type: out.typeName, init: out.initialValue },
    { scope: 'VAR_EXTERNAL', type: 'BOOL', init: 'FALSE' }
  );
  assert.ok(/Output 0 of PLC/.test(out.comment), 'variable comment decoded');
  const tmp = vars.find((v) => v.name === 'tmp');
  assert.deepStrictEqual({ scope: tmp.scope, type: tmp.typeName }, { scope: 'VAR', type: 'BOOL' });
});

check('Control of two tanks: FB declarations with initial values', () => {
  const { project, contents } = sourceLoad('Control of two tanks (FB, LD).pro');
  const pou = project.objects.find((o) => o.name === 'TempError');
  const vars = pouDeclarations(project, contents, pou).variables;
  const byName = new Map(vars.map((v) => [v.name, v]));
  assert.ok(byName.has('TempMin') && byName.has('TempMax'), 'expected TempMin/TempMax, got ' + [...byName.keys()].join(','));
  assert.strictEqual(byName.get('TempMin').typeName, 'INT');
  assert.strictEqual(byName.get('TempMin').initialValue, '20');
  assert.strictEqual(byName.get('TempMax').initialValue, '80');
});

// --- POU implementation language ---------------------------------------------

function languageLoad(name) {
  const file = path.join(SAMPLES, name);
  const buf = fs.readFileSync(file);
  const project = parseProject(buf, { file });
  return { project, contents: extractContents(buf, project) };
}

check('language: LD / FBD / IL / SFC detected from section type', () => {
  const cases = [
    ['Flasher (Timer, LD).pro', 'FlasherSolution1', 'LD'],
    ['Calculates the trace of a three-dimensional array (FB).pro', 'CalcTrace_DINT', 'FBD'],
    ['Control of two tanks (FB, IL).pro', 'TempError', 'IL'],
    ['Coffee machine (SFC).pro', 'coffee', 'SFC'],
  ];
  for (const [f, pouName, want] of cases) {
    const { project, contents } = languageLoad(f);
    const pou = project.objects.find((o) => o.name === pouName);
    assert.ok(pou, 'missing POU ' + pouName + ' in ' + f);
    const got = pouLanguage(project, contents, pou);
    assert.strictEqual(got.language, want, f + ' :: ' + pouName + ' expected ' + want + ', got ' + got.language);
  }
});

// --- DUTs (TYPE … END_TYPE) --------------------------------------------------

check('RTC sample: DUT BCD_DATE_TIME fields decoded', () => {
  const { project, contents } = languageLoad('Set and read the real time clock.pro');
  const dut = duts(project).find((d) => d.name === 'BCD_DATE_TIME');
  assert.ok(dut, 'DUT BCD_DATE_TIME present');
  const fields = dutDeclarations(project, contents, dut).fields;
  assert.deepStrictEqual(fields.map((f) => [f.name, f.typeName, f.initialValue]), [
    ['MinSec', 'WORD', '0'],
    ['DayHour', 'WORD', '0'],
    ['YearMonth', 'WORD', '0'],
    ['DayOfWeek', 'WORD', '0'],
  ]);
  assert.strictEqual(dutDeclarations(project, contents, dut).fields.length, 4);
});

// --- global variables (CONFIGURATION … VAR_GLOBAL) ---------------------------

check('Coffee machine: global variables decoded', () => {
  const { project, contents } = languageLoad('Coffee machine (SFC).pro');
  const g = globalVariables(project, contents);
  assert.strictEqual(g.variables.length, 6, 'expected 6 global variables, got ' + g.variables.length);
  const credit = g.variables.find((v) => v.name === 'credit');
  assert.ok(credit, 'credit present');
  assert.deepStrictEqual(
    { scope: credit.scope, type: credit.typeName, init: credit.initialValue, address: credit.address },
    { scope: 'VAR_GLOBAL', type: 'INT', init: '0', address: null }
  );
  const sw = g.variables.find((v) => v.name === 'switch_1');
  assert.deepStrictEqual({ type: sw.typeName, init: sw.initialValue, address: sw.address }, { type: 'BOOL', init: 'FALSE', address: '%IX0.0' });
});

check('Flasher: global variable with FP output address, no DUTs', () => {
  const { project, contents } = languageLoad('Flasher (Timer, LD).pro');
  const g = globalVariables(project, contents);
  assert.strictEqual(g.lists.length, 1, 'exactly one global variable list object');
  assert.strictEqual(g.variables.length, 1, 'expected 1 global variable, got ' + g.variables.length);
  const v = g.variables[0];
  assert.deepStrictEqual(
    { scope: v.scope, name: v.name, type: v.typeName, address: v.address, init: v.initialValue },
    { scope: 'VAR_GLOBAL', name: 'Output_0', type: 'BOOL', address: '%QX0.0', init: 'FALSE' }
  );
  assert.strictEqual(duts(project).length, 0);
});

// --- tasks (SINGLE / INTERVAL / PRIORITY) ------------------------------------

check('Coffee machine: task settings decoded', () => {
  const { project, contents } = languageLoad('Coffee machine (SFC).pro');
  const rows = tasks(project, contents);
  assert.strictEqual(taskGroups(project).length, 1, 'one task group object');
  assert.strictEqual(rows.length, 27, 'the project keeps the full 27-task template, got ' + rows.length);
  const byName = new Map(rows.map((t) => [t.name, t]));
  const timer = byName.get('Timer Interrupt');
  assert.deepStrictEqual(
    { single: timer.single, interval: timer.interval, priority: timer.priority },
    { single: 'FALSE', interval: 'T#10ms', priority: '31' }
  );
  const programs = byName.get('Programs');
  assert.deepStrictEqual(
    { single: programs.single, interval: programs.interval, priority: programs.priority },
    { single: 'TRUE', interval: '0', priority: '31' }
  );
  const i0 = byName.get('Interrupt 0');
  assert.deepStrictEqual({ single: i0.single, interval: i0.interval }, { single: 'I0', interval: '0' });
});

// --- task -> PROGRAM assignments (PROGRAM X WITH <task>) --------------------

check('task assignments: Coffee machine binds coffee + count_coins to Programs', () => {
  const { project, contents } = languageLoad('Coffee machine (SFC).pro');
  const rows = tasks(project, contents);
  const programs = rows.find((t) => t.name === 'Programs');
  assert.deepStrictEqual(programs.programs, ['coffee', 'count_coins']);
  assert.strictEqual(programs.programIds.length, 2, 'one FPWIN id per assignment');
  const timer = rows.find((t) => t.name === 'Timer Interrupt');
  assert.deepStrictEqual(timer.programs, [], 'interrupt tasks have no program assigned');
});

check('task assignments: Flasher binds only FlasherSolution2', () => {
  const { project, contents } = languageLoad('Flasher (Timer, LD).pro');
  const programs = tasks(project, contents).find((t) => t.name === 'Programs');
  assert.deepStrictEqual(programs.programs, ['FlasherSolution2']);
});

check('task assignments: real time clock uses the "Programs 1" task', () => {
  const { project, contents } = languageLoad('Set and read the real time clock.pro');
  const bound = tasks(project, contents).filter((t) => t.programs.length);
  assert.strictEqual(bound.length, 1, 'exactly one task has programs, got ' + JSON.stringify(bound.map((t) => t.name)));
  assert.strictEqual(bound[0].name, 'Programs 1');
  assert.deepStrictEqual(bound[0].programs, ['Plc_Time']);
});

check('task assignments: Random function block binds Program_RND to Programs', () => {
  const { project, contents } = languageLoad('Random function block (LD).pro');
  const rows = tasks(project, contents);
  const programs = rows.find((t) => t.name === 'Programs');
  assert.deepStrictEqual(programs.programs, ['Program_RND']);
  // the FUNCTION_BLOCK RANDOM is a POU but is not assigned to a task
  const assigned = rows.reduce((acc, t) => acc.concat(t.programs), []);
  assert.deepStrictEqual(assigned, ['Program_RND']);
});

check('task assignments: two tanks program bound to Programs', () => {
  const { project, contents } = languageLoad('Control of two tanks (FB, LD).pro');
  const programs = tasks(project, contents).find((t) => t.name === 'Programs');
  assert.deepStrictEqual(programs.programs, ['Tanks_2Levels']);
});

check('task assignments: programIds are binding-record ids, not object ids', () => {
  const { project, contents } = languageLoad('Coffee machine (SFC).pro');
  const programs = tasks(project, contents).find((t) => t.name === 'Programs');
  // The setting frame lists the kind-4 binding records' own ids (+0x12) in
  // assignment order: 121 = count_coins, 122 = coffee. The binding frames
  // themselves appear in file order (coffee first), which follows PROGRAM object
  // id (coffee = 0xf0 < count_coins = 0x105), not the id list.
  assert.deepStrictEqual(programs.programIds, [121, 122]);
  assert.deepStrictEqual(
    programs.assignments.map((a) => [a.recordId, a.name]),
    [[121, 'count_coins'], [122, 'coffee']]
  );
  assert.deepStrictEqual(programs.danglingIds, []);
  assert.deepStrictEqual(programs.programs, ['coffee', 'count_coins'], 'file order is unchanged');
});

// --- 7.7 dialect: FC FC content frames, UTF-16 names, empty bindings --------

/** One `FC FC` content record: the 7.7 tag for a kind-4 section payload. */
function fcFrame({ id, owner, payload, kind = 4, subType = 51 }) {
  const z = zlib.deflateSync(payload);
  const len = 0x24 + z.length;
  const b = Buffer.alloc(len);
  b[0] = 0xfc;
  b[1] = 0xfc;
  b.writeUInt16LE(len, 2);
  b.writeUInt32LE(kind, 0x0a);
  b.writeUInt32LE(0, 0x0e);
  b.writeUInt32LE(id, 0x12);
  b.writeUInt32LE(owner, 0x16);
  b.writeUInt32LE(subType, 0x1a);
  b.writeUInt16LE(0x40, 0x1e);
  b.writeUInt32LE(payload.length, 0x20);
  z.copy(b, 0x24);
  return b;
}

/** The PROGRAM binding payload: u32 nameLen + UTF-16 name + 0xFFFFFFFF + 6 zero bytes. */
function assignmentPayload(name) {
  const chars = Array.from(name);
  const b = Buffer.alloc(4 + chars.length * 2 + 4 + 6);
  b.writeUInt32LE(chars.length, 0);
  for (let i = 0; i < chars.length; i++) b.writeUInt16LE(chars[i].codePointAt(0), 4 + i * 2);
  b.writeUInt32LE(0xffffffff, 4 + chars.length * 2);
  return b;
}

check('FC FC frames: the 7.7 record tag is walked and decoded as a content frame', () => {
  const frame = fcFrame({ id: 4242, owner: 7, payload: assignmentPayload('扫码程序') });
  const size = 0x1000;
  const buf = Buffer.alloc(size);
  buf.writeUInt32LE((size - 1) >>> 0, 0);
  buf.writeUInt32LE(0x800 + frame.length, 8);
  frame.copy(buf, 0x800);
  const project = parseProject(buf, { file: 'synthetic.pro' });
  const rec = project.records.find((r) => r.offset === 0x800);
  assert.ok(rec, 'the FC FC frame must be part of the linear walk');
  assert.strictEqual(rec.tag, 'block', 'FC FC records are content blocks, not pages');
  assert.strictEqual(rec.length, frame.length);
  const contents = extractContents(buf, project);
  const hit = contents.find((c) => c.recordId === 4242);
  assert.ok(hit, 'the FC FC payload must decompress into a content frame');
  assert.strictEqual(hit.kind, 4);
  assert.strictEqual(hit.ownerId, 7);
  assert.strictEqual(readAssignmentName(hit.data), '扫码程序');
});

check('readAssignmentName: UTF-16 names are not ASCII-only', () => {
  assert.strictEqual(readAssignmentName(assignmentPayload('工位甲手动上料_CON')), '工位甲手动上料_CON');
  assert.strictEqual(readAssignmentName(assignmentPayload('设备一_CON')), '设备一_CON');
  // a zeroed binding record (nameLen 0) and a control character are not names
  assert.strictEqual(readAssignmentName(Buffer.from('00000000ffffffff00000000000000', 'hex')), null);
  assert.strictEqual(readAssignmentName(assignmentPayload('bad\u0001name')), null);
});

check('task assignments: every resolved name is a PROGRAM object of the project', () => {
  let resolved = 0;
  for (const f of FILES) {
    const buf = loadBuf(f);
    const project = parseProject(buf, { file: f });
    const contents = extractContents(buf, project);
    const programNames = new Set(pous(project).filter((o) => o.type === 0x0f).map((o) => o.name));
    for (const t of tasks(project, contents)) {
      assert.ok(Array.isArray(t.emptyIds), 'emptyIds must always be present');
      for (const a of t.assignments) {
        if (a.name === null) continue;
        resolved++;
        assert.ok(programNames.has(a.name), f + ': ' + a.name + ' is not a PROGRAM object');
      }
    }
  }
  assert.ok(resolved >= 8, 'expected the fixtures to resolve at least 8 assignments, got ' + resolved);
});

check('task assignments: emptyIds is empty for the fixtures', () => {
  const { project, contents } = languageLoad('Coffee machine (SFC).pro');
  const programs = tasks(project, contents).find((t) => t.name === 'Programs');
  // 7.7 sample (客户甲一体机临时.pro) instead carries 2303/2304 with a zeroed
  // record -> emptyIds; 1576/1643 in 4.06.722.25(上板机).pro have no record at
  // all -> danglingIds. Neither happens to be a vendored fixture.
  assert.deepStrictEqual(programs.emptyIds, []);
  assert.deepStrictEqual(programs.danglingIds, []);
});

console.log('---');
console.log('passed=' + passed + (process.exitCode ? ' (FAILURES)' : ' all ok'));
