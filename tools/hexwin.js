#!/usr/bin/env node
'use strict';
/**
 * hexwin.js - dump a byte window of a file as hex / ASCII / UTF-16LE.
 * usage: node hexwin.js <file> <offsetHex> [lenBytes]
 */
const fs = require('fs');
const file = process.argv[2];
const off = parseInt(process.argv[3], 16);
const len = Number(process.argv[4] || 128);
const b = fs.readFileSync(file);
const end = Math.min(off + len, b.length);
const slice = b.slice(off, end);
console.log('file=' + file + ' off=0x' + off.toString(16) + ' len=' + slice.length);
for (let i = 0; i < slice.length; i += 16) {
  const row = slice.slice(i, i + 16);
  const hex = [...row].map((x) => x.toString(16).padStart(2, '0')).join(' ');
  const asc = [...row].map((x) => (x >= 32 && x < 127 ? String.fromCharCode(x) : '.')).join('');
  console.log((off + i).toString(16).padStart(6, '0') + '  ' + hex.padEnd(48) + '  ' + asc);
}
console.log('utf16le: ' + JSON.stringify(slice.slice(0, (slice.length & ~1)).toString('utf16le').replace(/[\x00-\x1f]/g, '.')));
