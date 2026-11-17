#!/usr/bin/env node
'use strict';
/**
 * proparse-cli.js - standalone CLI for FPWIN Pro 7 binary `.pro` project files.
 *
 * Zero dependencies. Reads the SC container directly (no IDE, no MCP server) and
 * prints the object tree, the POU list or the raw parse result as JSON.
 *
 * Usage:
 *   node proparse-cli.js <file.pro>                    # summary + indented object tree
 *   node proparse-cli.js <file.pro> --pous             # only PROGRAM / FUNCTION_BLOCK / FUNCTION
 *   node proparse-cli.js <file.pro> --json             # full parse result as JSON
 *   node proparse-cli.js <file.pro> --json --out x.json# write JSON to a file
 *   node proparse-cli.js <file.pro> --asc other.asc     # cross-check names against an .asc export
 *   node proparse-cli.js <file.pro> --all              # keep folder pseudo-objects in the tree
 *   node proparse-cli.js <file.pro> --duts             # DUT (TYPE … END_TYPE) field lists
 *   node proparse-cli.js <file.pro> --globals          # global variable list (CONFIGURATION VAR_GLOBAL)
 *   node proparse-cli.js <file.pro> --tasks            # task settings + assigned PROGRAMs + binding-record id map
 *   node proparse-cli.js <file.pro> --sfc              # SFC chart elements + 22-byte stream trailer
 *   node proparse-cli.js <file.pro> --tables           # SC table catalogue (SCOBJ_TAB.dat/.idx, …)
 *   node proparse-cli.js <file.pro> --coverage         # decoded-coverage counts for this project
 *   node proparse-cli.js <file.pro> --records          # list every parsed frame (debug)
 *
 * Exit codes: 0 ok, 1 parse/validation failure, 2 usage error.
 */

const fs = require('fs');
const path = require('path');
const {
  parseProject, walk, pous, extractContents, pouSource, pouDeclarations, pouLanguage,
  duts, dutDeclarations, globalVariables, taskGroups, tasks,
  sfcCharts, sectionLanguage, tables,
} = require('./lib/proparse');

const USAGE = [
  'usage: node proparse-cli.js <file.pro> [options]',
  '',
  'options:',
  '  --tree            indented object tree (default)',
  '  --pous            list PROGRAM / FUNCTION_BLOCK / FUNCTION objects only',
  '  --bodies          list every POU with its extracted source size',
  '  --decls           list every POU with its decoded variable declarations',
  '  --decl <name>     print the decoded variable declarations of one POU',
  '  --duts            list DUT (TYPE … END_TYPE) objects with their decoded fields',
  '  --dut <name>      print the decoded fields of one DUT',
  '  --globals         print the global variable list(s)',
  '  --tasks           list tasks: settings + assigned PROGRAMs + binding-record ids (assignment order)',
  '  --sfc             list SFC charts: elements + 22-byte stream trailer (Steps folder id)',
  '  --tables          list the SC table catalogue (.dat / .idx records, §2.3 of PRO-FORMAT.md)',
  '  --coverage        print decoded coverage for this project (POU sources, declarations,',
  '                    task binding names, dangling/empty ids, SFC) — reuses existing results',
  '  --body <name>     print the reconstructed source text of one POU',
  '  --out-dir <dir>   write each extracted POU source to <dir>/<POU>.body.txt',
  '  --json            emit the full parse result as JSON (adds sources with --bodies;',
  '                    includes counts.tables, coverage, tasks[].assignments/danglingIds/emptyIds',
  '                    and sfc[].trailer)',
  '  --out <path>      write the output to <path> instead of stdout',
  '  --all             include folder pseudo-objects in the tree',
  '  --records         list every parsed frame (debug)',
  '  --asc <file.asc>  cross-check parsed object names against an .asc export',
  '  -h, --help        show this help',
  '',
  'coverage / 覆盖范围:',
  '  --coverage and the --json top-level "coverage" object report what was actually decoded;',
  '  they only reuse pous/pouSource/pouDeclarations/duts/globalVariables/tasks/sfcCharts.',
  '  The structure (container / frame chain / object tree) decodes on all 42 containers audited;',
  '  content coverage can still be partial — run --coverage to see the numbers for one project.',
  '  Still unknown (see PRO-FORMAT.md §9/§10): .idx index entries (every .idx page on disk is',
  '  the reserved 0xFF page), the SFC link-table "token" word, the 22-byte SFC trailer last field',
  '  (u32 vs u16+u16), and the 7.5/7.7 content dialects (POU body = u32 char count + UTF-16;',
  '  the 7.5/7.7 SFC element stream differs from 6.00).',
].join('\n');

function fail(msg, code) {
  console.error(msg);
  process.exit(code === undefined ? 2 : code);
}

function readAscNames(ascPath) {
  const text = fs.readFileSync(ascPath, 'utf8');
  const names = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^(PROGRAM|FUNCTION_BLOCK|FUNCTION)\s+([A-Za-z_\u00c0-\uffff][\w\u00c0-\uffff]*)/.exec(line.trim());
    if (m) names.push({ kind: m[1], name: m[2] });
  }
  return names;
}

function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv.includes('-h') || argv.includes('--help')) {
    console.log(USAGE);
    process.exit(argv.length ? 0 : 2);
  }
  const file = path.resolve(argv[0]);
  if (!fs.existsSync(file)) fail('file not found: ' + file);

  const opt = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : null;
  };
  const wantJson = argv.includes('--json');
  const wantPous = argv.includes('--pous');
  const wantBodies = argv.includes('--bodies');
  const wantDecls = argv.includes('--decls');
  const wantDecl = opt('--decl');
  const wantDuts = argv.includes('--duts');
  const wantDut = opt('--dut');
  const wantGlobals = argv.includes('--globals');
  const wantTasks = argv.includes('--tasks');
  const wantSfc = argv.includes('--sfc');
  const wantBody = opt('--body');
  const outDir = opt('--out-dir');
  const wantRecords = argv.includes('--records');
  const wantTables = argv.includes('--tables');
  const wantCoverage = argv.includes('--coverage');
  const includeFolders = argv.includes('--all');
  const outPath = opt('--out');
  const ascPath = opt('--asc');

  let project;
  const buf = fs.readFileSync(file);
  try {
    project = parseProject(buf, { file });
  } catch (e) {
    fail('cannot parse ' + file + ': ' + e.message, 1);
  }
  const needSource = Boolean(wantJson || wantPous || wantBodies || wantBody || wantDecls || wantDecl ||
    wantDuts || wantDut || wantGlobals || wantTasks || wantSfc || wantCoverage || outDir ||
    (wantJson && argv.includes('--source')));
  const contents = needSource ? extractContents(buf, project) : null;
  const sourceOf = (pou) => (contents ? pouSource(project, contents, pou) : { text: null, language: null });
  const declsOf = (pou) => (contents ? pouDeclarations(project, contents, pou).variables : []);
  const langOf = (pou) => (contents ? (pouLanguage(project, contents, pou).language || '-') : '-');
  const dutRows = () => (contents ? duts(project).map((d) => ({ dut: d, fields: dutDeclarations(project, contents, d).fields })) : []);
  const globVars = () => (contents ? globalVariables(project, contents) : { lists: [], variables: [] });
  const taskRows = () => (contents ? tasks(project, contents) : []);
  let sfcCache = null;
  const sfcRows = () => {
    if (sfcCache === null) sfcCache = contents ? sfcCharts(project, contents) : [];
    return sfcCache;
  };
  const tableRows = () => tables(buf, project);
  // Decoded-coverage counters. Pure aggregation of the public results above; no new parsing.
  const coverageRows = () => {
    const allPous = pous(project);
    let withSource = 0;
    let declarations = 0;
    for (const p of allPous) {
      if (sourceOf(p).text) withSource++;
      declarations += declsOf(p).length;
    }
    const dr = dutRows();
    const gv = globVars();
    const tr = taskRows();
    let bindings = 0, resolvedBindings = 0;
    const danglingIds = [], emptyIds = [];
    for (const t of tr) {
      bindings += t.programIds.length;
      resolvedBindings += t.assignments.filter((a) => a.name).length;
      danglingIds.push(...t.danglingIds);
      emptyIds.push(...t.emptyIds);
    }
    const charts = sfcRows();
    let elements = 0, transitions = 0, wiredTransitions = 0, fromToLinks = 0;
    for (const c of charts) {
      elements += c.elements.length;
      transitions += c.counts.transitions;
      wiredTransitions += c.counts.wiredTransitions;
      for (const e of c.elements) {
        if (e.kind === 8) fromToLinks += (e.from ? e.from.length : 0) + (e.to ? e.to.length : 0);
      }
    }
    return {
      pous: { total: allPous.length, withSource, withoutSource: allPous.length - withSource },
      declarations,
      duts: { total: dr.length, fields: dr.reduce((n, r) => n + r.fields.length, 0) },
      globalVariables: { lists: gv.lists.length, variables: gv.variables.length },
      tasks: { total: tr.length, bindings, resolvedBindings, danglingIds, emptyIds },
      sfc: { charts: charts.length, elements, transitions, wiredTransitions, fromToLinks },
      warnings: project.warnings.length,
      unknown: [
        '.idx index entries (every .idx page on disk is the reserved 0xFF page)',
        'SFC link-table token',
        'SFC trailer last field (u32 vs u16+u16)',
        '7.5/7.7 POU body dialect (u32 char count + UTF-16)',
        '7.5/7.7 SFC element stream',
      ],
    };
  };

  const lines = [];
  const push = (s) => lines.push(s);

  if (wantJson) {
    lines.push(JSON.stringify({
      file,
      size: project.size,
      usedLength: project.usedLength,
      header: project.header,
      counts: {
        records: project.records.length,
        objects: project.objects.length,
        roots: project.roots.length,
        pous: pous(project).length,
        sfcCharts: sfcRows().length,
        sfcElements: sfcRows().reduce((n, c) => n + c.elements.length, 0),
        tables: tableRows().length,
        recoveredByScan: project.records.filter((r) => r.recoveredByScan).length,
      },
      pous: pous(project).map((o) => {
        const src = sourceOf(o);
        return {
          name: o.name,
          type: o.type,
          typeName: o.typeName,
          language: contents ? pouLanguage(project, contents, o).language : null,
          id: '0x' + o.id.toString(16),
          parent: '0x' + o.parent.toString(16),
          offset: '0x' + o.offset.toString(16),
          mtime: o.mtime,
          mtimeIso: o.mtimeIso,
          sourceLength: src.text ? src.text.length : 0,
          ...(needSource ? { source: src.text } : {}),
        };
      }),
      duts: dutRows().map(({ dut, fields }) => ({
        name: dut.name,
        id: '0x' + dut.id.toString(16),
        fields: fields.map((f) => ({ name: f.name, type: f.typeName, initialValue: f.initialValue, comment: f.comment })),
      })),
      tasks: taskRows().map((t) => ({
        name: t.name,
        single: t.single,
        interval: t.interval,
        priority: t.priority,
        programs: t.programs,
        programIds: t.programIds,
        assignments: t.assignments,
        danglingIds: t.danglingIds,
        emptyIds: t.emptyIds,
      })),
      sfc: sfcRows().map((c) => ({
        pou: c.pou,
        section: c.section,
        counts: c.counts,
        trailer: c.trailer,
        stepsFolder: c.stepsFolder,
        stepsFolderId: c.stepsFolderId,
        trailerVerified: c.trailerVerified,
        elements: c.elements.map((e) => ({
          sequence: e.sequence,
          kind: e.kind,
          kindName: e.kindName,
          name: e.name,
          prevId: e.prevId === undefined ? null : e.prevId,
          nextId: e.nextId === undefined ? null : e.nextId,
          wiring: e.wiring || { in: [], out: [] },
          ...(e.actionText !== undefined ? {
            actionCount: e.actionCount,
            actionText: e.actionText,
            actions: (e.actions || []).map((a) => ({
              name: a.name,
              qualifier: a.qualifier,
              sectionName: a.sectionName,
              hasBody: !!a.body,
              bodyLength: a.body ? a.body.length : 0,
            })),
          } : {}),
          ...(e.kind === 8 ? {
            from: e.from || [],
            to: e.to || [],
            hasBody: e.hasBody,
            language: e.language,
            sectionName: e.sectionName,
            bodyLength: e.body ? e.body.length : 0,
          } : {}),
          ...(e.kind === 11 ? { entries: e.entries || [] } : {}),
          ...(e.kind === 12 ? { ends: e.ends || [] } : {}),
        })),
      })),
      globalVariables: globVars().variables.map((v) => ({
        scope: v.scope,
        name: v.name,
        type: v.typeName,
        initialValue: v.initialValue,
        address: v.address,
        comment: v.comment,
      })),
      tables: tableRows().map((t) => ({
        name: t.name,
        table: t.table,
        kind: t.kind,
        formatVersion: '0x' + t.formatVersion.toString(16),
        frameOffset: '0x' + t.frameOffset.toString(16),
        length: t.length,
        pageOffset: '0x' + t.pageOffset.toString(16),
        pageKind: t.pageKind,
        appendOffset: '0x' + t.appendOffset.toString(16),
        counter: t.counter,
        seq: t.seq,
        tableCode: '0x' + t.tableCode.toString(16),
        mtime: t.mtime,
        mtimeIso: t.mtimeIso,
      })),
      coverage: coverageRows(),
      warnings: project.warnings,
    }, null, 2));
  } else {
    push(path.basename(file));
    push('  size        ' + project.size + ' bytes (used 0x' + project.usedLength.toString(16) + ' = ' + project.usedLength + ')');
    push('  frames      ' + project.records.length + ' (blocks ' + project.records.filter((r) => r.tag === 'block').length +
      ', pages ' + project.records.filter((r) => r.tag === 'page').length + ')');
    push('  objects     ' + project.objects.length + ' named, ' + pous(project).length + ' POU(s), ' +
      duts(project).length + ' DUT(s), ' + taskGroups(project).length + ' task group(s)');
    const catalogue = tableRows();
    if (catalogue.length) {
      const dats = catalogue.filter((t) => t.kind === 'dat').length;
      const idxs = catalogue.filter((t) => t.kind === 'idx');
      const populated = idxs.filter((t) => t.pageKind !== 'reserved').length;
      push('  catalogue   ' + catalogue.length + ' table record(s) (' + dats + ' .dat / ' + idxs.length + ' .idx' +
        (populated === 0 ? ', .idx pages empty' : ', ' + populated + ' .idx with data') + ')');
    }
    if (project.warnings.length) {
      push('  warnings    ' + project.warnings.length);
      for (const w of project.warnings) push('    ! ' + w);
    }
    push('');

    if (wantCoverage) {
      const cv = coverageRows();
      push('coverage (decoded / total)');
      push('  POUs          ' + cv.pous.withSource + '/' + cv.pous.total + ' with text source (' +
        cv.pous.withoutSource + ' without a text body; ' + cv.sfc.charts + ' SFC chart(s))');
      push('  declarations  ' + cv.declarations + ' record(s)');
      push('  DUTs          ' + cv.duts.total + ' object(s) / ' + cv.duts.fields + ' field(s)');
      push('  globals       ' + cv.globalVariables.variables + ' variable(s) in ' +
        cv.globalVariables.lists + ' list(s)');
      push('  tasks         ' + cv.tasks.total + ', binding names ' + cv.tasks.resolvedBindings + '/' +
        cv.tasks.bindings + ' (dangling ' + cv.tasks.danglingIds.length +
        ', empty ' + cv.tasks.emptyIds.length + ')');
      push('  SFC           ' + cv.sfc.charts + ' chart(s), ' + cv.sfc.elements + ' element record(s), ' +
        cv.sfc.transitions + ' transition(s), ' + cv.sfc.wiredTransitions + '/' + cv.sfc.transitions +
        ' with FROM/TO links (' + cv.sfc.fromToLinks + ' endpoint(s))');
      push('  warnings      ' + cv.warnings);
      push('  unknown       .idx index entries; SFC link-table token; SFC trailer last field (u32 vs u16+u16);');
      push('                7.5/7.7 POU body text and SFC element stream (see PRO-FORMAT.md §9/§10)');
    } else if (wantDecl) {
      const pou = pous(project).find((p) => p.name === wantDecl);
      if (!pou) fail('POU not found: ' + wantDecl, 1);
      const vars = declsOf(pou);
      push('declarations of ' + pou.name + ' [' + pou.typeName + '] ' + vars.length + ' variable(s)');
      for (const v of vars) {
        push('  ' + String(v.scope).padEnd(14) + v.name + ' : ' + v.typeName +
          (v.initialValue ? ' := ' + v.initialValue : '') + (v.comment ? '   (*' + v.comment + '*)' : ''));
      }
    } else if (wantDut) {
      const d = duts(project).find((x) => x.name === wantDut);
      if (!d) fail('DUT not found: ' + wantDut + ' (have: ' + duts(project).map((x) => x.name).join(', ') + ')', 1);
      const fields = contents ? dutDeclarations(project, contents, d).fields : [];
      push('DUT ' + d.name + '  ' + fields.length + ' field(s)');
      for (const f of fields) {
        push('  ' + String(f.name).padEnd(24) + f.typeName + (f.initialValue ? ' := ' + f.initialValue : '') +
          (f.comment ? '   (*' + f.comment + '*)' : ''));
      }
    } else if (wantDuts) {
      const rows = dutRows();
      push('DUTs');
      for (const { dut, fields } of rows) {
        push('  ' + String(dut.name).padEnd(28) + fields.length + ' field(s)  (id=0x' + dut.id.toString(16) + ')');
        for (const f of fields) push('      ' + String(f.name).padEnd(24) + f.typeName + (f.initialValue ? ' := ' + f.initialValue : ''));
      }
      if (!rows.length) push('  (none)');
    } else if (wantTasks) {
      const rows = taskRows();
      push('tasks');
      for (const t of rows) {
        push('  ' + String(t.name).padEnd(20) + 'SINGLE=' + String(t.single).padEnd(8) +
          'INTERVAL=' + String(t.interval).padEnd(10) + 'PRIORITY=' + t.priority +
          (t.programs.length ? '  PROGRAMS=' + t.programs.join(',') : ''));
        if (t.programIds.length) {
          const empty = new Set(t.emptyIds || []);
          const map = t.programIds.map((id) => {
            const a = (t.assignments || []).find((x) => x.recordId === id);
            if (a && a.name) return id + '=' + a.name;
            return id + (empty.has(id) ? '=(empty)' : '=(record gone)');
          });
          push('      ' + ' '.repeat(17) + 'binding ids: ' + map.join('  '));
          if (!t.programs || !t.programs.length) {
            push('      ' + ' '.repeat(17) +
              'note: no binding record carries a program name; names unavailable');
          }
          if (t.danglingIds && t.danglingIds.length) {
            push('      ' + ' '.repeat(17) + 'dangling ids: ' + t.danglingIds.join(',') +
              ' (binding record no longer present)');
          }
          if (t.emptyIds && t.emptyIds.length) {
            push('      ' + ' '.repeat(17) + 'empty ids: ' + t.emptyIds.join(',') +
              ' (binding record present, payload zeroed)');
          }
        }
      }
      if (!rows.length) push('  (none)');
    } else if (wantSfc) {
      const charts = sfcRows();
      push('SFC charts');
      if (!charts.length) push('  (none)');
      for (const chart of charts) {
        push('  ' + chart.pou + '   steps=' + chart.counts.steps + ' transitions=' + chart.counts.transitions +
          ' final=' + chart.counts.finalSteps + ' branch-elements=' + chart.counts.branchElements);
        if (chart.trailer) {
          push('    trailer      marker=0x' + chart.trailer.marker.toString(16) + ' bytes=' + chart.trailer.bytes +
            ' stepsFolderId=' + chart.trailer.stepsFolderId +
            ' (' + (chart.stepsFolder || '?') + '/' + (chart.stepsFolderId || '?') + ')' +
            ' verified=' + chart.trailerVerified);
        } else {
          push('    trailer      (none: stream is not closed by a 22-byte record)');
        }
        for (const e of chart.elements) {
          if (e.kind === 2 || e.kind === 6) {
            const acts = (e.actions || []).map((a) => a.name + (a.qualifier ? '/' + a.qualifier : ''));
            push('    ' + String(e.kindName).padEnd(13) + String(e.name).padEnd(22) +
              (acts.length ? 'actions: ' + acts.join(', ') : '') +
              (e.wiring && e.wiring.out.length ? '  -> ' + e.wiring.out.join(',') : ''));
          } else if (e.kind === 8) {
            push('    ' + String(e.kindName).padEnd(13) + String(e.name).padEnd(22) +
              (e.from && e.from.length ? 'FROM ' + e.from.map((n) => n || '·').join(',') + ' ' : '') +
              (e.to && e.to.length ? 'TO ' + e.to.map((n) => n || '·').join(',') + '  ' : '') +
              (e.hasBody ? 'body: ' + (e.language || '?') + ' (' + (e.body ? e.body.length : 0) + ' chars)' : 'no body'));
          } else if (e.kind === 11 || e.kind === 12) {
            const ids = e.kind === 11 ? e.entries : e.ends;
            push('    ' + String(e.kindName).padEnd(13) + String(e.name || '') + '  ' +
              (e.kind === 11 ? 'entries: ' : 'ends: ') + (ids || []).join(','));
          } else {
            push('    ' + String(e.kindName).padEnd(13) + String(e.name || ''));
          }
        }
      }
    } else if (wantTables) {
      const rows = tableRows();
      push('SC table catalogue (401-byte FA FA records, see PRO-FORMAT.md §2.3)');
      if (!rows.length) push('  (none)');
      for (const t of rows) {
        push('  ' + String(t.name).padEnd(17) +
          'page=' + ('0x' + t.pageOffset.toString(16)).padEnd(8) +
          '(' + String(t.pageKind).padEnd(9) + ') append=' +
          ('0x' + t.appendOffset.toString(16)).padEnd(9) +
          'counter=' + String(t.counter).padEnd(7) +
          'code=' + ('0x' + t.tableCode.toString(16)).padEnd(9) +
          'mtime=' + (t.mtimeIso || '-'));
      }
      const populated = rows.filter((t) => t.kind === 'idx' && t.pageKind !== 'reserved').length;
      if (rows.length && !populated) {
        push('  note: every .idx page is the reserved 0xFF page — FPWIN writes only the .dat side');
      }
    } else if (wantGlobals) {
      const g = globVars();
      push('global variables');
      for (const list of g.lists) {
        push('  list ' + list.object.name + '  ' + list.variables.length + ' variable(s)');
        for (const v of list.variables) {
          push('    ' + String(v.scope).padEnd(14) + v.name + ' : ' + v.typeName +
            (v.address ? ' AT ' + v.address : '') +
            (v.initialValue ? ' := ' + v.initialValue : '') +
            (v.comment ? '   (*' + v.comment + '*)' : ''));
        }
      }
      if (!g.lists.length) push('  (none)');
    } else if (wantDecls) {
      push('POU declarations');
      for (const p of pous(project)) {
        const vars = declsOf(p);
        push('  ' + String(p.typeName).padEnd(16) + String(p.name).padEnd(28) + vars.length + ' var(s)');
      }
    } else if (wantBody) {
      const pou = pous(project).find((p) => p.name === wantBody);
      if (!pou) fail('POU not found: ' + wantBody + ' (have: ' + pous(project).map((p) => p.name).join(', ') + ')', 1);
      const src = sourceOf(pou);
      if (!src.text) fail('no text source stored for POU ' + wantBody + ' (SFC charts and binary bodies are not text)', 1);
      push('source of ' + pou.name + ' [' + pou.typeName + '] ' + src.text.length + ' chars');
      push(src.text);
    } else if (wantBodies || outDir) {
      push('POU sources');
      for (const p of pous(project)) {
        const src = sourceOf(p);
        push('  ' + String(p.typeName).padEnd(16) + String(p.name).padEnd(28) +
          (src.text ? src.text.length + ' chars' : 'no text body (SFC chart / binary)'));
        if (outDir && src.text) {
          fs.mkdirSync(path.resolve(outDir), { recursive: true });
          const safe = p.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
          const target = path.join(path.resolve(outDir), safe + '.body.txt');
          fs.writeFileSync(target, src.text, 'utf8');
        }
      }
    } else if (wantPous) {
      push('POUs');
      for (const p of pous(project)) {
        push('  ' + String(p.typeName).padEnd(16) + String(langOf(p)).padEnd(5) + p.name + '  (id=0x' + p.id.toString(16) + ', parent=0x' + p.parent.toString(16) + ')');
      }
    } else {
      push('object tree');
      for (const r of walk(project)) {
        if (!includeFolders && r.typeName.startsWith('folder:')) continue;
        push('  ' + '  '.repeat(r.depth) + r.name + '  [' + r.typeName + ', id=0x' + r.id.toString(16) + ', @0x' + r.offset.toString(16) + ']');
      }
    }

    if (ascPath) {
      if (!fs.existsSync(ascPath)) fail('asc file not found: ' + ascPath); // eslint-disable-line no-unused-expressions
      const declared = readAscNames(ascPath);
      const names = new Set(project.objects.map((o) => o.name));
      const missing = declared.filter((d) => !names.has(d.name));
      push('');
      push('cross-check vs ' + path.basename(ascPath));
      push('  asc declarations ' + declared.length + ', missing in .pro: ' + missing.length);
      for (const m of missing) push('    MISS ' + m.kind + ' ' + m.name);
      if (missing.length) process.exitCode = 1;
    }
  }

  if (wantRecords) {
    push('');
    push('frames (offset / tag / length / kind / name)');
    for (const r of project.records) {
      push('  0x' + r.offset.toString(16).padStart(6, '0') + '  ' + r.tag.padEnd(5) + ' ' + String(r.length).padStart(6) + '  ' +
        r.kind + '  ' + (r.name || ''));
    }
  }

  const text = lines.join('\n') + '\n';
  if (outPath) {
    fs.writeFileSync(path.resolve(outPath), text, 'utf8');
    console.log('wrote ' + path.resolve(outPath) + ' (' + text.length + ' bytes)');
  } else {
    process.stdout.write(text);
  }
}

main();
