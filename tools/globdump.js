#!/usr/bin/env node
'use strict';
/**
 * globdump.js - dump the string tokens of global-variable and DUT-field records.
 * usage: node tools/globdump.js <file.pro> [--glob|--dut] [--limit=6]
 */
const fs = require('fs');
const { parseProject, extractContents, contentsOf } = require('../lib/proparse');

const file = process.argv[2];
if (!file) { console.error('usage: globdump.js <file.pro> [--glob|--dut] [--limit=6]'); process.exit(2); }
const limit = Number((process.argv.find((a) => a.startsWith('--limit=')) || '--limit=6').split('=')[1]);
const buf = fs.readFileSync(file);
const project = parseProject(buf, { file });
const contents = extractContents(buf, project);

function readU32(d, o) { return d.readUInt32LE(o); }
function readStr(d, o, chars) {
  if (chars < 0 || o + 4 + chars * 2 > d.length) return null;
  let s = '';
  for (let i = 0; i < chars; i++) {
    const c = d[o + 4 + i * 2] | (d[o + 4 + i * 2 + 1] << 8);
    if (c < 0x20 || (c > 0x7e && c < 0xa0)) return null;
    s += String.fromCharCode(c);
  }
  return s;
}

function tokenize(d) {
  const out = [];
  let i = 0;
  while (i + 4 <= d.length) {
    const len = readU32(d, i);
    const s = readStr(d, i, len);
    if (s !== null) { out.push({ kind: 'str', v: s }); i += 4 + s.length * 2; }
    else { out.push({ kind: 'bin', v: '0x' + readU32(d, i).toString(16) }); i += 4; }
  }
  return out;
}

function show(owner, chunks) {
  console.log('## ' + (owner ? owner.name + ' type=0x' + owner.type.toString(16) + ' id=0x' + owner.id.toString(16) : '?'));
  for (const ch of chunks.slice(0, limit)) {
    console.log(' @0x' + ch.frameOffset.toString(16) + ' size=' + ch.size + ' kind=' + ch.kind);
    console.log('   hex   : ' + ch.data.toString('hex'));
    console.log('   tokens: ' + JSON.stringify(tokenize(ch.data)));
  }
}

const wantDut = process.argv.includes('--dut');
const wantGlob = process.argv.includes('--glob');
if (wantGlob || (!wantDut && !wantGlob)) {
  const glob = project.objects.find((o) => o.type === 0x0d);
  if (glob) show(glob, contentsOf(contents, glob.id).filter((c) => !c.text));
}
if (wantDut) {
  for (const dut of project.objects.filter((o) => o.type === 0x0c).slice(0, 2)) {
    console.log('DUT object ' + dut.name + ' attrs=' + dut.attrs + ' children=' + (dut.children || []).map((c) => c.name + '(0x' + c.type.toString(16) + ')').join(','));
    for (const c of dut.children || []) show(c, contentsOf(contents, c.id).filter((x) => !x.text));
  }
}
