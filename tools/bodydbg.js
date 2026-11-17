#!/usr/bin/env node
'use strict';
/**
 * bodydbg.js - inspect the content chunks that make up one POU body.
 * usage: node tools/bodydbg.js <file.pro> <pouName>
 */
const fs = require('fs');
const { parseProject, extractContents, pous, contentsOf } = require('../lib/proparse');

const file = process.argv[2];
const pouName = process.argv[3];
if (!file || !pouName) { console.error('usage: bodydbg.js <file.pro> <pouName>'); process.exit(2); }
const buf = fs.readFileSync(file);
const project = parseProject(buf, { file });
const contents = extractContents(buf, project);
const pou = pous(project).find((p) => p.name === pouName);
if (!pou) { console.error('POU not found: ' + pouName + ' (have: ' + pous(project).map((p) => p.name).join(', ') + ')'); process.exit(1); }
console.log('POU ' + pou.name + ' id=0x' + pou.id.toString(16) + ' type=0x' + pou.type.toString(16));
for (const c of pou.children || []) {
  const chunks = contentsOf(contents, c.id);
  console.log(' section ' + JSON.stringify(c.name) + ' type=0x' + c.type.toString(16) + ' id=0x' + c.id.toString(16) +
    ' chunks=' + chunks.length);
  for (const ch of chunks) {
    const head = ch.text ? JSON.stringify(ch.text.slice(0, 60)) : ch.data.slice(0, 24).toString('hex');
    const tail = ch.text ? JSON.stringify(ch.text.slice(-40)) : '';
    console.log('   @0x' + ch.frameOffset.toString(16) + ' kind=' + ch.kind + ' size=' + ch.size +
      (ch.text ? ' TEXT' : ' bin') + ' head=' + head + (tail ? ' tail=' + tail : ''));
  }
}
