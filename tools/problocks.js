#!/usr/bin/env node
'use strict';
/**
 * problocks.js - map the 0x800 blocks of an FPWIN Pro .pro container.
 * Prints, per block: offset, the frame bytes at +0..+0x30, and every printable
 * ASCII run inside the block header area (first 0x300 bytes of the block).
 *
 * usage: node problocks.js <file.pro> [--full]
 */
const fs = require('fs');

function printable(s) {
  return /^[\x20-\x7e]{3,}$/.test(s);
}

function runs(buf, from, to, min) {
  const out = [];
  let start = -1;
  for (let i = from; i <= to; i++) {
    const c = i < to ? buf[i] : 0;
    const ok = c >= 0x20 && c < 0x7f;
    if (ok) { if (start < 0) start = i; }
    else if (start >= 0) {
      if (i - start >= min) out.push({ off: start, s: buf.toString('latin1', start, Math.min(i, to)) });
      start = -1;
    }
  }
  return out;
}

function main() {
  const file = process.argv[2];
  const full = process.argv.includes('--full');
  if (!file) { console.error('usage: problocks.js <file.pro> [--full]'); process.exit(2); }
  const buf = fs.readFileSync(file);

  const marks = [];
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] === 0xfe && buf[i + 1] === 0xfe && buf[i + 2] === 0x1f && buf[i + 3] === 0x00) marks.push(i);
  }
  console.log('file=' + file + ' size=' + buf.length + ' blocks=' + marks.length);
  for (const off of marks) {
    const end = Math.min(off + 0x800, buf.length);
    const head = buf.slice(off, off + 0x30);
    const words = [];
    for (let k = 0; k < 0x30; k += 4) words.push(head.readUInt32LE(k).toString(16));
    console.log('\nBLOCK @0x' + off.toString(16) + ' (page ' + (off / 0x800) + ') words: ' + words.join(' '));
    const rs = runs(buf, off, Math.min(off + (full ? 0x800 : 0x300), buf.length), 3);
    for (const r of rs) console.log('   +0x' + (r.off - off).toString(16).padStart(2, '0') + ' ' + JSON.stringify(r.s.slice(0, 100)));
  }
}

main();
