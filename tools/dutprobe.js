#!/usr/bin/env node
'use strict';
/**
 * dutprobe.js - inspect how DUTs (TYPE … END_TYPE) and global variable lists are
 * stored in a .pro project: object tree placement, section children, content
 * chunks (hex + UTF-16 strings) next to the .asc ground truth.
 *
 * usage: node tools/dutprobe.js <file.pro> [--asc]
 */
const fs = require('fs');
const path = require('path');
const { parseProject, extractContents, contentsOf } = require('../lib/proparse');

const file = process.argv[2];
if (!file) { console.error('usage: dutprobe.js <file.pro> [--asc]'); process.exit(2); }
const showAsc = process.argv.includes('--asc');
const buf = fs.readFileSync(file);
const project = parseProject(buf, { file });
const contents = extractContents(buf, project);

const dutFolder = project.objects.find((o) => o.type === 0x03 || /DUT/i.test(o.name));
const globFolder = project.objects.find((o) => o.type === 0x0d || /glob/i.test(o.name));
console.log('DUT folder: ' + (dutFolder ? dutFolder.name + ' id=0x' + dutFolder.id.toString(16) : 'none'));
console.log('global folder: ' + (globFolder ? globFolder.name + ' id=0x' + globFolder.id.toString(16) : 'none'));

const candidates = project.objects.filter((o) => (dutFolder && o.parent === dutFolder.id) ||
  (globFolder && o.parent === globFolder.id) ||
  o.type === 0x03 || o.type === 0x0d);
for (const o of candidates.slice(0, 12)) {
  console.log('\n## ' + o.name + '  type=0x' + o.type.toString(16) + ' id=0x' + o.id.toString(16) + ' parent=0x' + o.parent.toString(16) + ' @0x' + o.offset.toString(16));
  console.log('   attrs=' + o.attrs + ' children=' + (o.children || []).map((c) => c.name + '(0x' + c.type.toString(16) + ')').join(', '));
  const own = contentsOf(contents, o.id);
  for (const ch of own.slice(0, 4)) {
    console.log('   own chunk @0x' + ch.frameOffset.toString(16) + ' kind=' + ch.kind + ' size=' + ch.size + (ch.text ? ' TEXT' : ' bin'));
    console.log('     hex: ' + ch.data.slice(0, 96).toString('hex'));
  }
  for (const c of o.children || []) {
    const chs = contentsOf(contents, c.id);
    for (const ch of chs.slice(0, 3)) {
      console.log('   ' + c.name + ' chunk @0x' + ch.frameOffset.toString(16) + ' kind=' + ch.kind + ' size=' + ch.size + (ch.text ? ' TEXT' : ' bin'));
      console.log('     hex: ' + ch.data.slice(0, 96).toString('hex'));
      if (ch.text) console.log('     text: ' + JSON.stringify(ch.text.slice(0, 160)));
    }
  }
}

if (showAsc) {
  const ascPath = file.replace(/\.pro$/i, '.asc');
  if (fs.existsSync(ascPath)) {
    const text = fs.readFileSync(ascPath, 'utf8');
    const lines = text.split(/\r?\n/);
    let inType = false;
    let count = 0;
    for (const line of lines) {
      if (/^TYPE\b/.test(line.trim())) { inType = true; console.log('\nASC> ' + line.trim()); continue; }
      if (inType) {
        console.log('ASC> ' + line);
        if (/^END_TYPE/.test(line.trim())) { inType = false; count++; if (count >= 4) break; }
      }
    }
  }
}
