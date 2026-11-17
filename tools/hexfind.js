#!/usr/bin/env node
'use strict';
const fs = require('fs');
const { parseProject, extractContents, contentsOf } = require('../lib/proparse');
const file = process.argv[2];
const buf = fs.readFileSync(file);
const project = parseProject(buf, { file });
const contents = extractContents(buf, project);
for (const ch of contents) {
  const d = ch.data;
  if (ch.text) continue;
  const pat = Buffer.from(process.argv[3], 'utf16le');
  if (d.indexOf(pat) < 0) continue;
  console.log('frame@0x' + ch.frameOffset.toString(16) + ' kind=' + ch.kind + ' size=' + d.length + ' owner=0x' + ch.ownerId.toString(16));
  console.log(d.toString('hex').replace(/(.{64})/g, '$1\n'));
}
