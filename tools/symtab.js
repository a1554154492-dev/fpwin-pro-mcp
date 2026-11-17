#!/usr/bin/env node
'use strict';
/**
 * symtab.js - dump the decompressed "The_Symbol_Table" (type 0x15) content of a
 * .pro project: hex dump plus every UTF-16LE string with its offset.
 *
 * usage: node tools/symtab.js <file.pro> [--type=0x15] [--strings=120] [--hex=0x120]
 */
const fs = require('fs');
const zlib = require('zlib');
const { parseProject } = require('../lib/proparse');

const file = process.argv[2];
if (!file) { console.error('usage: symtab.js <file.pro> [--type=0x15]'); process.exit(2); }
const typeArg = process.argv.find((a) => a.startsWith('--type='));
const wantType = typeArg ? parseInt(typeArg.split('=')[1], 16) : 0x15;
const strLimit = Number((process.argv.find((a) => a.startsWith('--strings=')) || '--strings=120').split('=')[1]);
const hexLimit = Number((process.argv.find((a) => a.startsWith('--hex=')) || '--hex=0x120').split('=')[1]);
const buf = fs.readFileSync(file);
const project = parseProject(buf, { file });
const byId = new Map(project.objects.map((o) => [o.id, o]));

function findZlibStart(off) {
  for (let i = off + 0x12; i < Math.min(off + 0x40, buf.length); i++) {
    if (buf[i] === 0x78 && [0x01, 0x5e, 0x9c, 0xda].includes(buf[i + 1])) return i;
  }
  return -1;
}

let target = null;
for (const f of project.records) {
  if (f.tag !== 'block' || f.kind === 'object') continue;
  const kind = buf.readUInt32LE(f.offset + 0x0a);
  const ownerId = kind === 6 ? buf.readUInt32LE(f.offset + 0x12) : buf.readUInt32LE(f.offset + 0x16);
  const owner = byId.get(ownerId);
  if (!owner || owner.type !== wantType) continue;
  const z = findZlibStart(f.offset);
  if (z < 0) continue;
  try {
    target = { owner, frame: f, z, out: zlib.inflateSync(buf.slice(z), { finishFlush: zlib.constants.Z_SYNC_FLUSH }) };
  } catch (e) { /* ignore */ }
  break;
}
if (!target) { console.error('no content frame owned by a type 0x' + wantType.toString(16) + ' object'); process.exit(1); }

console.log('owner=' + target.owner.name + ' frame=0x' + target.frame.offset.toString(16) + ' raw=' + target.out.length + 'B');
const out = target.out;
console.log('--- hex (first ' + hexLimit + ' bytes) ---');
for (let i = 0; i < Math.min(hexLimit, out.length); i += 16) {
  const row = out.slice(i, i + 16);
  const hex = [...row].map((x) => x.toString(16).padStart(2, '0')).join(' ');
  const asc = [...row].map((x) => (x >= 32 && x < 127 ? String.fromCharCode(x) : '.')).join('');
  console.log(i.toString(16).padStart(5, '0') + '  ' + hex.padEnd(48) + '  ' + asc);
}

console.log('--- UTF-16LE strings ---');
const strings = [];
let start = -1;
for (let i = 0; i + 1 < out.length; i += 2) {
  const c = out[i] | (out[i + 1] << 8);
  const ok = c >= 0x20 && c < 0x7f;
  if (ok) { if (start < 0) start = i; }
  else if (start >= 0) {
    if ((i - start) / 2 >= 2) strings.push({ off: start, s: out.slice(start, i).toString('utf16le') });
    start = -1;
  }
}
for (const s of strings.slice(0, strLimit)) console.log('  @0x' + s.off.toString(16).padStart(4, '0') + ' ' + JSON.stringify(s.s));
console.log('strings=' + strings.length);
