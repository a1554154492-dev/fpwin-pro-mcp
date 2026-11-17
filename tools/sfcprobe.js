#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const { parseProject, extractContents, pous, contentsOf } = require('../lib/proparse');

const dir = process.argv[2] || 'D:/FP7752/Samples/English';
for (const [file, name] of [['Coffee machine (SFC).pro', 'coffee'], ['Bake a pizza (SFC).pro', 'Pizza'], ['Traffic control system (SFC).pro', 'TrafficLights']]) {
  const filePath = path.join(dir, file);
  if (!fs.existsSync(filePath)) { console.log('missing ' + file); continue; }
  const buf = fs.readFileSync(filePath);
  const project = parseProject(buf, { file: filePath });
  const contents = extractContents(buf, project);
  const pou = pous(project).find((p) => p.name === name);
  console.log('## ' + file + ' :: ' + name + ' id=0x' + pou.id.toString(16) + ' type=0x' + pou.type.toString(16) +
    ' children=' + ((pou.children || []).length));
  for (const c of (pou.children || []).slice(0, 10)) {
    console.log('   child ' + JSON.stringify(c.name) + ' type=0x' + c.type.toString(16) +
      ' id=0x' + c.id.toString(16) + ' textChunks=' + contentsOf(contents, c.id).filter((x) => x.text).length +
      ' binChunks=' + contentsOf(contents, c.id).filter((x) => !x.text).length);
  }
  const own = contentsOf(contents, pou.id);
  console.log('   own content chunks=' + own.length + ' text=' + own.filter((x) => x.text).length);
  const kids = project.objects.filter((o) => o.parent === pou.id);
  console.log('   objects with this parent: ' + kids.map((o) => o.name + '(0x' + o.type.toString(16) + ')').join(', '));
}
