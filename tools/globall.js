#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const { parseProject, extractContents, globalVariables, contentsOf } = require('../lib/proparse');
const dir = process.argv[2];
for (const f of fs.readdirSync(dir).filter((x) => x.toLowerCase().endsWith('.pro'))) {
  const buf = fs.readFileSync(path.join(dir, f));
  const project = parseProject(buf, { file: f });
  const contents = extractContents(buf, project);
  const g = globalVariables(project, contents);
  console.log('## ' + f + '  lists=' + g.lists.length + ' vars=' + g.variables.length);
  for (const list of g.lists) {
    console.log('   list ' + list.object.name + ' id=0x' + list.object.id.toString(16) + ' chunks=' + contentsOf(contents, list.object.id).length);
    for (const ch of contentsOf(contents, list.object.id)) {
      console.log('      chunk @0x' + ch.frameOffset.toString(16) + ' kind=' + ch.kind + ' size=' + ch.size + (ch.text ? ' TEXT' : ' bin'));
    }
    for (const v of list.variables) console.log('      VAR ' + v.scope + ' ' + v.name + ': ' + v.typeName + (v.initialValue ? ' := ' + v.initialValue : '') + (v.address ? ' AT ' + v.address : ''));
  }
}
