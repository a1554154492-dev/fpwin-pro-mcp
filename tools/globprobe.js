#!/usr/bin/env node
'use strict';
/**
 * globprobe.js - locate global variable declarations inside a .pro project.
 * usage: node tools/globprobe.js <file.pro> <varName>
 */
const fs = require('fs');
const { parseProject, extractContents, contentsOf } = require('../lib/proparse');

const file = process.argv[2];
const needle = process.argv[3];
if (!file || !needle) { console.error('usage: globprobe.js <file.pro> <varName>'); process.exit(2); }
const buf = fs.readFileSync(file);
const project = parseProject(buf, { file });
const contents = extractContents(buf, project);

const glob = project.objects.find((o) => o.type === 0x0d);
if (glob) {
  console.log('global object: ' + glob.name + ' id=0x' + glob.id.toString(16) + ' attrs=' + glob.attrs +
    ' children=' + (glob.children || []).map((c) => c.name + '(0x' + c.type.toString(16) + ')').join(','));
  for (const ch of contentsOf(contents, glob.id)) {
    console.log('  own chunk @0x' + ch.frameOffset.toString(16) + ' size=' + ch.size + (ch.text ? ' TEXT' : ' bin') +
      ' hex=' + ch.data.slice(0, 64).toString('hex'));
  }
}

const pat = Buffer.from(needle, 'utf16le');
for (const c of contents) {
  const i = c.data.indexOf(pat);
  if (i < 0) continue;
  const owner = c.owner ? c.owner.name + ' (id=0x' + c.owner.id.toString(16) + ', type=0x' + c.owner.type.toString(16) + ')' : 'id=0x' + c.ownerId.toString(16);
  console.log('HIT ' + JSON.stringify(needle) + ' in chunk @0x' + c.frameOffset.toString(16) + ' kind=' + c.kind + ' owner=' + owner + ' at +0x' + i.toString(16));
  const start = Math.max(0, i - 64);
  console.log('   hex: ' + c.data.slice(start, i + 96).toString('hex'));
}
const named = project.objects.filter((o) => o.type === 0x0d || /glob/i.test(o.name));
console.log('objects: ' + named.map((o) => o.name + '(0x' + o.type.toString(16) + ', id=0x' + o.id.toString(16) + ')').join(', '));
