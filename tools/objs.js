#!/usr/bin/env node
'use strict';
/**
 * objs.js - list *named* FA FA records of an FPWIN Pro .pro container.
 *
 * Empirical framing (see HANDOFF-2026-11-16.md):
 *   FA FA <u16 totalLen> <payload> <UTF-16LE name>
 * The name is the last field of the record; payload header is 41 bytes for
 * object records.
 *
 * usage: node objs.js <file.pro> [--all]
 */
const fs = require('fs');

function u16(b, o) { return b.readUInt16LE(o); }
function u32(b, o) { return b.readUInt32LE(o); }

function trailName(buf, from, end, maxBytes) {
  // read printable UTF-16LE ending exactly at `end`
  const limit = Math.max(from, end - (maxBytes || 256));
  for (let start = end - 2; start >= limit; start -= 2) {
    const b0 = buf[start], b1 = buf[start + 1];
    const ok = b1 === 0 && b0 >= 0x20;
    if (!ok) {
      const s = buf.slice(start + 2, end).toString('utf16le');
      return s.length >= 2 ? s : null;
    }
  }
  return null;
}

function main() {
  const file = process.argv[2];
  if (!file) { console.error('usage: objs.js <file.pro> [--all]'); process.exit(2); }
  const all = process.argv.includes('--all');
  const buf = fs.readFileSync(file);
  const used = u32(buf, 8);
  const small = process.argv.find((a) => a.startsWith('--max='));
  const maxName = small ? Number(small.split('=')[1]) : 64;
  let off = 0x800;
  const rows = [];
  while (off + 4 <= Math.min(used, buf.length)) {
    const t = buf[off], t2 = buf[off + 1];
    if (!((t === 0xfa && t2 === 0xfa) || (t === 0xfe && t2 === 0xfe))) {
      off++;
      continue;
    }
    const len = u16(buf, off + 2);
    if (len < 8) { off++; continue; }
    const end = off + len;
    if (end > buf.length) break;
    if (t === 0xfa) {
      const name = trailName(buf, off + 4, end, maxName);
      if (name) {
        rows.push({
          off,
          len,
          name,
          p2: u32(buf, off + 6),
          p6: u32(buf, off + 10),
          pA: u32(buf, off + 14),
          pE: u32(buf, off + 18),
          p12: u32(buf, off + 22),
          tail4: buf.slice(off + 26, off + 30).toString('hex'),
        });
      }
    }
    off = end;
  }
  if (all) {
    console.log('all records with a trailing UTF-16 name: ' + rows.length);
  }
  for (const r of rows) {
    console.log(
      '@0x' + r.off.toString(16).padStart(6, '0') + ' len=' + String(r.len).padStart(4) +
      ' p2=' + r.p2.toString(16).padStart(4) + ' p6=' + r.p6 + ' pA=0x' + r.pA.toString(16) +
      ' pE=' + r.pE.toString(16) + ' p12=' + r.p12.toString(16) + ' t4=' + r.tail4 + ' name=' + JSON.stringify(r.name)
    );
  }
  console.log('named=' + rows.length);
}

main();
