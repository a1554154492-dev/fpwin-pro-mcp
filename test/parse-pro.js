#!/usr/bin/env node
'use strict';
/**
 * parse-pro.js - validate lib/proparse.js against the shipped .pro/.asc sample pairs.
 *
 * The .asc export is the ground truth for "which objects does this project contain";
 * the .pro container is what we parse. For every pair we require that each
 * PROGRAM / FUNCTION_BLOCK / FUNCTION declared in the .asc appears as a named
 * object in the .pro tree.
 *
 * usage:
 *   node test/parse-pro.js <dirWithPairs>            # validate every .pro/.asc pair
 *   node test/parse-pro.js <file.pro> --tree         # print the object tree of one file
 *   node test/parse-pro.js <file.pro> --json         # dump the parsed objects as JSON
 */
const fs = require('fs');
const path = require('path');
const { parseProject, walk } = require('../lib/proparse');

const DECL_RE = /^(PROGRAM|FUNCTION_BLOCK|FUNCTION|VAR_GLOBAL|TYPE)\s+([A-Za-z_\u00c0-\uffff][\w\u00c0-\uffff]*)/;

function ascDeclaredNames(ascText) {
  const names = [];
  for (const line of ascText.split(/\r?\n/)) {
    const m = DECL_RE.exec(line.trim());
    if (m) names.push({ kind: m[1], name: m[2] });
  }
  return names;
}

function fmtTree(project) {
  return walk(project)
    .map((n) => '  '.repeat(n.depth) + n.name + '  [' + n.typeName + ', id=0x' + n.id.toString(16) + ', @0x' + n.offset.toString(16) + ']')
    .join('\n');
}

function main() {
  const target = process.argv[2];
  const tree = process.argv.includes('--tree');
  const json = process.argv.includes('--json');
  if (!target) {
    console.error('usage: node test/parse-pro.js <dir-or-file> [--tree] [--json]');
    process.exit(2);
  }
  const stat = fs.statSync(target);

  if (stat.isFile()) {
    const project = parseProject(fs.readFileSync(target), { file: target });
    if (json) {
      console.log(JSON.stringify(project.objects.map((o) => ({
        id: o.id, parent: o.parent, type: o.type, typeName: o.typeName, name: o.name, offset: o.offset,
      })), null, 2));
      return;
    }
    console.log(target);
    console.log('size=' + project.size + ' used=' + project.usedLength + ' records=' + project.records.length +
      ' objects=' + project.objects.length + ' roots=' + project.roots.length);
    if (project.warnings.length) {
      console.log('warnings:');
      for (const w of project.warnings) console.log('  ! ' + w);
    }
    console.log(tree ? fmtTree(project) : JSON.stringify(project.roots.map((r) => r.name)));
    return;
  }

  const files = fs.readdirSync(target).filter((f) => f.toLowerCase().endsWith('.pro'));
  let ok = 0, bad = 0;
  for (const f of files) {
    const proPath = path.join(target, f);
    const ascPath = proPath.replace(/\.pro$/i, '.asc');
    let project;
    try {
      project = parseProject(fs.readFileSync(proPath), { file: proPath });
    } catch (e) {
      console.log('FAIL  ' + f + '  parse error: ' + e.message);
      bad++;
      continue;
    }
    const proNames = new Set(project.objects.map((o) => o.name));
    if (!fs.existsSync(ascPath)) {
      console.log('PARSE ' + f + '  objects=' + project.objects.length + ' (no .asc twin)');
      ok++;
      continue;
    }
    const declared = ascDeclaredNames(fs.readFileSync(ascPath, 'utf8'));
    const missing = declared.filter((d) => !proNames.has(d.name));
    if (missing.length === 0) {
      ok++;
      console.log('OK    ' + f + '  ascObjects=' + declared.length + ' proObjects=' + project.objects.length +
        ' used=' + project.usedLength);
    } else {
      bad++;
      console.log('MISS  ' + f + '  ascObjects=' + declared.length + ' proObjects=' + project.objects.length +
        ' missing=' + missing.map((m) => m.kind + ' ' + m.name).join(', '));
    }
  }
  console.log('---');
  console.log('pairs ok=' + ok + ' bad=' + bad + ' total=' + files.length);
  if (bad > 0) process.exitCode = 1;
}

main();
