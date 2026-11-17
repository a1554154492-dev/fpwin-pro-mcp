#!/usr/bin/env node
'use strict';
/**
 * zextract.js - decode the compressed content frames of a .pro project.
 *
 * Content frame layout (empirically):
 *   +0x00 u16 0xFAFA     +0x02 u16 frameLen
 *   +0x04 u16 0
 *   +0x06 u32 sizeHint
 *   +0x0A u32 kind       6 = text content (BODY / config), 4 = binary (stream/table)
 *   +0x0E u32 prev       previous content frame offset
 *   +0x12 u32 ownerId    kind 6 owner
 *   +0x16 u32 ownerId    kind 4 owner
 *   +0x1A u32 …
 *   +0x1E u16/u32 length (uncompressed size)
 *   +0x20|+0x22  zlib stream
 *
 * usage: node tools/zextract.js <file.pro> [--text-only] [--body] [--sym]
 */
const fs = require('fs');
const zlib = require('zlib');
const { parseProject } = require('../lib/proparse');

const file = process.argv[2];
if (!file) { console.error('usage: zextract.js <file.pro> [--text-only] [--body] [--sym]'); process.exit(2); }
const textOnly = process.argv.includes('--text-only');
const bodyOnly = process.argv.includes('--body');
const symOnly = process.argv.includes('--sym');
const buf = fs.readFileSync(file);
const project = parseProject(buf, { file });
const byId = new Map(project.objects.map((o) => [o.id, o]));

function findZlibStart(frame) {
  const from = frame.offset + 0x12;
  const to = Math.min(frame.offset + 0x40, frame.length + frame.offset);
  for (let i = from; i < to; i++) {
    if (buf[i] === 0x78 && [0x01, 0x5e, 0x9c, 0xda].includes(buf[i + 1])) return i;
  }
  return -1;
}

function utf16Text(out) {
  const n = out.length & ~1;
  if (n < 16) return null;
  let printable = 0;
  for (let i = 0; i < n; i += 2) {
    const c = out[i] | (out[i + 1] << 8);
    if (c === 0) return null;
    if (c === 9 || c === 10 || c === 13 || (c >= 32 && c < 0x7f)) printable++;
  }
  return printable / (n / 2) >= 0.9 ? out.slice(0, n).toString('utf16le') : null;
}

const rows = [];
for (const f of project.records) {
  if (f.tag !== 'block' || f.kind === 'object') continue;
  const z = findZlibStart(f);
  if (z < 0) continue;
  const kind = buf.readUInt32LE(f.offset + 0x0a);
  const ownerId = kind === 6 ? buf.readUInt32LE(f.offset + 0x12) : buf.readUInt32LE(f.offset + 0x16);
  let out;
  try {
    out = zlib.inflateSync(buf.slice(z), { finishFlush: zlib.constants.Z_SYNC_FLUSH });
  } catch (e) { continue; }
  const owner = byId.get(ownerId);
  rows.push({ frame: f, kind, ownerGuess: ownerId, owner, out, text: utf16Text(out), zlibAt: z });
}

for (const r of rows) {
  if (textOnly && !r.text) continue;
  if (bodyOnly && !(r.text && r.text.startsWith('BODY'))) continue;
  if (symOnly && !(r.owner && r.owner.type === 0x15)) continue;
  const owner = r.owner
    ? r.owner.name + ' (id=0x' + r.owner.id.toString(16) + ', type=0x' + r.owner.type.toString(16) + ')'
    : 'id=0x' + r.ownerGuess.toString(16) + ' ?';
  console.log('@0x' + r.frame.offset.toString(16).padStart(6, '0') + ' len=' + String(r.frame.length).padStart(5) +
    ' kind=' + r.kind + ' z=+0x' + (r.zlibAt - r.frame.offset).toString(16) +
    ' raw=' + r.out.length + 'B ' + (r.text ? 'TEXT' : 'bin ') + ' owner=' + owner);
  if (r.text) {
    const head = r.text.split(/\r?\n/).slice(0, 2).join(' \\n ');
    console.log('   ' + JSON.stringify(head.slice(0, 160)));
  }
}
console.log('---');
console.log('content frames=' + rows.length + ' text=' + rows.filter((r) => r.text).length + ' binary=' + rows.filter((r) => !r.text).length);
