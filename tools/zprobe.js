#!/usr/bin/env node
'use strict';
/**
 * zprobe.js - look for compressed payloads inside a .pro container.
 *
 * CoDeSys 2.3 object payloads (declarations / bodies) may be zlib-compressed.
 * This walks every offset that looks like a zlib header (0x78 0x01/0x9C/0xDA,
 * or raw deflate) and tries to inflate with Z_SYNC_FLUSH so trailing bytes do
 * not fail the stream. Printable chunks are reported.
 *
 * usage: node tools/zprobe.js <file.pro> [--max=40]
 */
const fs = require('fs');
const zlib = require('zlib');

const file = process.argv[2];
if (!file) { console.error('usage: zprobe.js <file.pro>'); process.exit(2); }
const max = Number((process.argv.find((a) => a.startsWith('--max=')) || '--max=40').split('=')[1]);
const buf = fs.readFileSync(file);

const HEADERS = [
  { b: [0x78, 0x01], name: 'zlib-no/level1', raw: false },
  { b: [0x78, 0x5e], name: 'zlib-fast', raw: false },
  { b: [0x78, 0x9c], name: 'zlib-default', raw: false },
  { b: [0x78, 0xda], name: 'zlib-best', raw: false },
];

let found = 0;
for (const h of HEADERS) {
  for (let i = 0; i + 2 < buf.length; i++) {
    if (buf[i] !== h.b[0] || buf[i + 1] !== h.b[1]) continue;
    try {
      const out = zlib.inflateSync(buf.slice(i), { finishFlush: zlib.constants.Z_SYNC_FLUSH });
      if (out.length < 24) continue;
      const printable = [...out].filter((c) => (c >= 32 && c < 127) || c === 9 || c === 10 || c === 13).length;
      const ratio = printable / out.length;
      if (ratio < 0.5) continue;
      found++;
      console.log('@0x' + i.toString(16) + ' ' + h.name + ' -> ' + out.length + ' bytes, printable ' + (ratio * 100).toFixed(0) + '%');
      console.log('   ' + JSON.stringify(out.toString('utf8').slice(0, 220)));
      if (found >= max) { console.log('stop after ' + found); process.exit(0); }
    } catch (e) { /* not a stream */ }
  }
}
console.log('zlib-like streams found: ' + found);

// Raw deflate heuristic: try offsets right after FAFA/FEFE frame headers.
let rawHits = 0;
for (let i = 0x800; i < buf.length - 4 && rawHits < 8; i++) {
  if (buf[i] !== 0xfa || buf[i + 1] !== 0xfa) continue;
  const len = buf.readUInt16LE(i + 2);
  if (len < 32 || i + len > buf.length) continue;
  const start = i + 0x2d;
  try {
    const out = zlib.inflateRawSync(buf.slice(start), { finishFlush: zlib.constants.Z_SYNC_FLUSH });
    if (out.length < 24) continue;
    const printable = [...out].filter((c) => (c >= 32 && c < 127) || c === 9 || c === 10 || c === 13).length;
    if (printable / out.length < 0.5) continue;
    rawHits++;
    console.log('RAW @0x' + start.toString(16) + ' (frame @0x' + i.toString(16) + ') -> ' + out.length + ' bytes');
    console.log('   ' + JSON.stringify(out.toString('utf8').slice(0, 220)));
  } catch (e) { /* not raw deflate */ }
}
console.log('raw-deflate hits: ' + rawHits);
