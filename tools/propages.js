#!/usr/bin/env node
'use strict';
/**
 * propages.js - dump every 0x800 page of a .pro container where the page is not
 * pure 0xFF padding: first 0x20 bytes, u32 words, and the ASCII name at +0x12,
 * +0x31 and +0x1c2 (the three offsets observed for .dat/.idx table names).
 *
 * usage: node propages.js <file.pro>
 */
const fs = require('fs');

function str(buf, off) {
  let s = '';
  for (let i = off; i < buf.length && s.length < 96; i++) {
    const c = buf[i];
    if (c >= 0x20 && c < 0x7f) s += String.fromCharCode(c);
    else break;
  }
  return s.trim();
}

function main() {
  const file = process.argv[2];
  if (!file) { console.error('usage: propages.js <file.pro>'); process.exit(2); }
  const buf = fs.readFileSync(file);
  const pages = Math.ceil(buf.length / 0x800);
  const hdr = [];
  for (let i = 0; i < 8; i++) hdr.push(buf.readUInt32LE(i * 4).toString(16));
  console.log(file + '\nsize=' + buf.length + ' pages=' + pages + ' header=' + hdr.join(' '));
  let used = buf.readUInt32LE(8);
  console.log('usedLen@8=0x' + used.toString(16) + ' (' + used + ')');
  for (let p = 0; p < pages; p++) {
    const off = p * 0x800;
    if (off >= buf.length) break;
    const chunk = buf.slice(off, Math.min(off + 0x800, buf.length));
    const allFF = chunk.every((b) => b === 0xff);
    if (allFF) continue;
    const words = [];
    for (let k = 0; k < 0x20 && k + 4 <= chunk.length; k += 4) words.push(chunk.readUInt32LE(k).toString(16));
    const n1 = str(buf, off + 0x12), n2 = str(buf, off + 0x31), n3 = str(buf, off + 0x1c2);
    console.log(
      'p' + String(p).padStart(2) + ' @0x' + off.toString(16).padStart(5, '0') +
      ' ' + words.join(' ') +
      ' | +12=' + JSON.stringify(n1) + ' +31=' + JSON.stringify(n2) + ' +1c2=' + JSON.stringify(n3)
    );
  }
}

main();
