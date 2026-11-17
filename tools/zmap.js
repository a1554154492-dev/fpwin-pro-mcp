#!/usr/bin/env node
'use strict';
/**
 * zmap.js - map the zlib-compressed payloads inside a .pro container.
 *
 * FPWIN stores declaration / body / config sections as zlib streams whose bytes
 * start at frame offset +0x22. Text payloads are UTF-16LE (BODY, WORKSPACE,
 * VAR … END_VAR, BEGIN_OBJECT …); binary payloads are address/symbol tables.
 *
 * usage: node tools/zmap.js <file.pro> [--all] [--limit=200]
 *   default: list only text payloads; --all adds binary ones; --limit caps output
 */
const fs = require('fs');
const zlib = require('zlib');
const { parseProject } = require('../lib/proparse');

const file = process.argv[2];
if (!file) { console.error('usage: zmap.js <file.pro> [--all] [--limit=200]'); process.exit(2); }
const all = process.argv.includes('--all');
const limit = Number((process.argv.find((a) => a.startsWith('--limit=')) || '--limit=200').split('=')[1]);
const buf = fs.readFileSync(file);
const project = parseProject(buf, { file });
const frames = project.records.slice().sort((a, b) => a.offset - b.offset);

function frameAt(off) {
  let lo = 0, hi = frames.length - 1, best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].offset <= off) { best = frames[mid]; lo = mid + 1; } else hi = mid - 1;
  }
  if (!best) return null;
  return off < best.offset + best.length ? best : null;
}

function utf16Text(out) {
  if (out.length < 32 || out.length % 2) {
    // still allow odd length text (last byte cut)
  }
  const n = out.length & ~1;
  if (n < 32) return null;
  let printable = 0;
  let ctrl = 0;
  for (let i = 0; i < n; i += 2) {
    const c = out[i] | (out[i + 1] << 8);
    if (c === 0) return null;
    if (c === 9 || c === 10 || c === 13 || (c >= 32 && c < 0x7f)) printable++;
    else if (c < 32) ctrl++;
  }
  const ratio = printable / (n / 2);
  if (ratio < 0.9 || ctrl / (n / 2) > 0.02) return null;
  return out.slice(0, n).toString('utf16le');
}

const headers = [[0x78, 0x01], [0x78, 0x5e], [0x78, 0x9c], [0x78, 0xda]];
let textCount = 0, binCount = 0, printed = 0;
for (let i = 0x800; i + 2 < buf.length; i++) {
  let isHdr = false;
  for (const [a, b] of headers) if (buf[i] === a && buf[i + 1] === b) { isHdr = true; break; }
  if (!isHdr) continue;
  let out;
  try {
    out = zlib.inflateSync(buf.slice(i), { finishFlush: zlib.constants.Z_SYNC_FLUSH });
  } catch (e) { continue; }
  if (out.length < 16) continue;
  const f = frameAt(i);
  if (!f) continue;
  const text = utf16Text(out);
  if (!text) { binCount++; continue; }
  textCount++;
  if (printed >= limit) continue;
  printed++;
  const owner = f.name ? (f.typeName + ' ' + JSON.stringify(f.name) + ' id=0x' + f.id.toString(16)) : 'data';
  console.log('frame @0x' + f.offset.toString(16).padStart(6, '0') + ' len=' + String(f.length).padStart(5) +
    ' +0x' + (i - f.offset).toString(16) + ' out=' + out.length + 'B  ' + owner);
  const preview = text.split(/\r?\n/).slice(0, 3).join(' \\n ');
  console.log('   ' + JSON.stringify(preview.slice(0, 200)));
}
console.log('---');
console.log('text streams=' + textCount + ' binary streams=' + binCount + ' frames=' + frames.length);
