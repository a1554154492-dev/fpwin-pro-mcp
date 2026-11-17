#!/usr/bin/env node
'use strict';
/**
 * dutdump.js - locate DUT (TYPE ... END_TYPE) field declarations inside a .pro.
 * usage: node tools/dutdump.js <file.pro> [fieldName...]
 */
const fs = require('fs');
const { parseProject, extractContents, contentsOf } = require('../lib/proparse');
const file = process.argv[2];
if (!file) { console.error('usage: dutdump.js <file.pro> [field...]'); process.exit(2); }
const buf = fs.readFileSync(file);
const project = parseProject(buf, { file });
const contents = extractContents(buf, project);
const byId = new Map(project.objects.map((o) => [o.id, o]));
console.log('objects=' + project.objects.length + ' contents=' + contents.length + ' records=' + project.records.length);
for (const dut of project.objects.filter((o) => o.type === 0x0c)) {
  console.log('\n## DUT ' + dut.name + ' id=0x' + dut.id.toString(16) + ' @0x' + dut.offset.toString(16) + ' len=' + dut.length + ' attrs=' + dut.attrs);
  const own = contentsOf(contents, dut.id);
  console.log('   own chunks: ' + own.length);
  for (const ch of own) console.log('     @0x' + ch.frameOffset.toString(16) + ' kind=' + ch.kind + ' size=' + ch.size + (ch.text ? ' TEXT' : ' bin') + ' head=' + ch.data.slice(0, 80).toString('hex'));
  // frames physically right after the object record
  const after = project.records.filter((r) => r.offset > dut.offset && r.offset < dut.offset + 0x800).slice(0, 4);
  for (const r of after) console.log('   next frame @0x' + r.offset.toString(16) + ' tag=' + r.tag + ' kind=' + r.kind + ' len=' + r.length);
}
const needles = process.argv.slice(3);
for (const n of needles) {
  const pat = Buffer.from(n, 'utf16le');
  for (const c of contents) {
    let i = c.data.indexOf(pat);
    while (i >= 0) {
      const owner = byId.get(c.ownerId);
      console.log('HIT ' + n + ' chunk@0x' + c.frameOffset.toString(16) + ' kind=' + c.kind + ' owner=' + (owner ? owner.name + '(0x' + owner.type.toString(16) + ')' : 'id=0x' + c.ownerId.toString(16)) + ' +0x' + i.toString(16));
      i = c.data.indexOf(pat, i + 2);
    }
  }
}
