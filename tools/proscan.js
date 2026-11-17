#!/usr/bin/env node
'use strict';
/**
 * proscan.js - exploratory scanner for FPWIN Pro 7 binary .pro containers.
 * Prints section table names, ASCII/UTF-16 strings with offsets and a coarse
 * map of 0xFF padding runs so the on-disk layout can be reasoned about.
 *
 * usage: node proscan.js <file.pro> [--max <n>]
 */
const fs = require('fs');

function asciiStrings(buf, minLen) {
  const out = [];
  let start = -1;
  for (let i = 0; i <= buf.length; i++) {
    const c = i < buf.length ? buf[i] : 0;
    const ok = c >= 0x20 && c < 0x7f;
    if (ok) { if (start < 0) start = i; }
    else if (start >= 0) {
      if (i - start >= minLen) out.push({ off: start, len: i - start, s: buf.toString('latin1', start, i) });
      start = -1;
    }
  }
  return out;
}

function utf16Strings(buf, minLen) {
  const out = [];
  let start = -1;
  for (let i = 0; i + 1 < buf.length; i += 2) {
    const lo = buf[i], hi = buf[i + 1];
    const c = lo | (hi << 8);
    const ok = hi === 0 && c >= 0x20 && c < 0x7f;
    if (ok) { if (start < 0) start = i; }
    else if (start >= 0) {
      const len = i - start;
      if (len / 2 >= minLen) out.push({ off: start, len: len / 2, s: buf.toString('latin1', start, i) });
      start = -1;
    }
  }
  return out;
}

function tail(buf) {
  // trim trailing 0xFF page padding
  let end = buf.length;
  while (end > 0 && buf[end - 1] === 0xff) end--;
  let lastZero = end;
  return { lastNonFF: end, size: buf.length };
}

function main() {
  const file = process.argv[2];
  const max = Number((process.argv.find((a) => a.startsWith('--max=')) || '--max=80').split('=')[1]);
  if (!file) { console.error('usage: proscan.js <file.pro> [--max=80]'); process.exit(2); }
  const buf = fs.readFileSync(file);
  const t = tail(buf);
  console.log(JSON.stringify({ file, size: buf.length, lastNonFF: t.lastNonFF, header: buf.slice(0, 16).toString('hex') }, null, 0));
  console.log('headerWords: ' + Array.from({ length: 16 }, (_, i) => buf.readUInt32LE(i * 4).toString(16)).join(' '));

  const ascii = asciiStrings(buf, 4);
  const u16 = utf16Strings(buf, 3);
  const named = ascii.filter((x) => /^(SC|OBJ|DECL|CONT|CRL|COM|NT|RL|ROM|EV_|!_)/.test(x.s) || /_TAB$/.test(x.s));
  console.log('--- ascii section-ish names (' + named.length + ') ---');
  for (const x of named.slice(0, 60)) console.log('  @' + x.off.toString(16).padStart(6, '0') + ' ' + JSON.stringify(x.s));

  console.log('--- ascii strings first ' + max + ' ---');
  for (const x of ascii.slice(0, max)) console.log('  @' + x.off.toString(16).padStart(6, '0') + ' ' + JSON.stringify(x.s));

  console.log('--- utf16 strings count=' + u16.length + ', first ' + max + ' ---');
  for (const x of u16.slice(0, max)) console.log('  @' + x.off.toString(16).padStart(6, '0') + ' ' + JSON.stringify(x.s));
}

main();
