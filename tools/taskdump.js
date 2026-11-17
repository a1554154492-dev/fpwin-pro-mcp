#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const { parseProject, extractContents, contentsOf } = require('../lib/proparse');
const dir = process.argv[2];
for (const f of fs.readdirSync(dir).filter((x) => x.toLowerCase().endsWith('.pro'))) {
  const buf = fs.readFileSync(path.join(dir, f));
  const project = parseProject(buf, { file: f });
  const tasks = project.objects.filter((o) => o.type === 0x12 || /task/i.test(o.name));
  if (!tasks.length) continue;
  const contents = extractContents(buf, project);
  console.log('## ' + f);
  for (const t of tasks) {
    console.log('   ' + t.name + ' type=0x' + t.type.toString(16) + ' id=0x' + t.id.toString(16) + ' attrs=' + t.attrs + ' children=' + (t.children || []).map(c => c.name + '(0x' + c.type.toString(16) + ')').join(','));
    for (const ch of contentsOf(contents, t.id)) {
      console.log('      own chunk @0x' + ch.frameOffset.toString(16) + ' kind=' + ch.kind + ' size=' + ch.size + (ch.text ? ' TEXT ' + JSON.stringify(ch.text.slice(0, 200)) : ' bin ' + ch.data.slice(0, 64).toString('hex')));
    }
    for (const c of t.children || []) {
      for (const ch of contentsOf(contents, c.id)) {
        console.log('      ' + c.name + ' chunk @0x' + ch.frameOffset.toString(16) + ' kind=' + ch.kind + ' size=' + ch.size + (ch.text ? ' TEXT ' + JSON.stringify(ch.text.slice(0, 300)) : ' bin ' + ch.data.slice(0, 64).toString('hex')));
      }
    }
  }
}
