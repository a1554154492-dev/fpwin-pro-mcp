#!/usr/bin/env node
'use strict';
const fs = require('fs');
const { parseProject, extractContents, contentsOf } = require('../lib/proparse');
const file = process.argv[2];
const buf = fs.readFileSync(file);
const project = parseProject(buf, { file });
const contents = extractContents(buf, project);
const byId = new Map(project.objects.map((o) => [o.id, o]));
const groups = project.objects.filter((o) => o.type === 0x12);
for (const g of groups) {
  console.log('## tasks group ' + g.name + ' id=0x' + g.id.toString(16));
  for (const child of g.children || []) {
    for (const ch of contentsOf(contents, child.id)) {
      if (ch.text) continue;
      const d = ch.data;
      const ids = [];
      // collect every u32 in the frame; also decode strings
      const strings = [];
      let i = 0;
      while (i + 4 <= d.length) {
        const len = d.readUInt32LE(i);
        if (len > 0 && len < 64 && i + 4 + len * 2 <= d.length) {
          let s = '';
          let ok = true;
          for (let k = 0; k < len; k++) {
            const c = d[i + 4 + k * 2] | (d[i + 4 + k * 2 + 1] << 8);
            if (c < 0x20 || (c > 0x7e && c < 0xa0)) { ok = false; break; }
            s += String.fromCharCode(c);
          }
          if (ok) { strings.push(s); i += 4 + len * 2; continue; }
        }
        ids.push(len >>> 0);
        i += 4;
      }
      console.log('  ' + child.name.padEnd(20) + ' strings=' + JSON.stringify(strings) + ' words=' + ids.map((n) => '0x' + n.toString(16)).join(','));
      const resolved = ids.map((n) => byId.get(n)).filter(Boolean).map((o) => o.name + '(0x' + o.type.toString(16) + ')');
      if (resolved.length) console.log('     resolves: ' + resolved.join(', '));
    }
  }
}
