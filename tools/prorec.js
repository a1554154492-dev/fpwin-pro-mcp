#!/usr/bin/env node
'use strict';
/**
 * prorec.js - walk the FA FA / FE FE record chain of an FPWIN Pro .pro file.
 *
 * Observed on-disk framing (empirical):
 *   FE FE <u16 len>   page/table header record
 *   FA FA <u16 len>   SC block record; len counts the whole record incl. tag+len
 * Payload starts right after the 4-byte frame.
 *
 * usage: node prorec.js <file.pro> [--from=0x800] [--limit=200] [--raw]
 */
const fs = require('fs');

function u16(b, o) { return b.readUInt16LE(o); }
function u32(b, o) { return b.readUInt32LE(o); }

function utf16At(buf, off, max) {
  let s = '';
  for (let i = off; i + 1 < buf.length && s.length < (max || 60); i += 2) {
    const c = buf[i] | (buf[i + 1] << 8);
    if (c >= 0x20 && c < 0x7f) s += String.fromCharCode(c);
    else if (c === 0) break;
    else break;
  }
  return s;
}

function hexs(buf, off, n) {
  return buf.slice(off, off + n).toString('hex');
}

/** First printable UTF-16LE run (>= min printable chars) inside [from,to). */
function namesIn(buf, from, to, min) {
  const need = min || 3;
  let start = -1;
  for (let i = from; i + 1 < to; i += 2) {
    const c = buf[i] | (buf[i + 1] << 8);
    const ok = c >= 0x20 && c < 0x7f;
    if (ok) { if (start < 0) start = i; }
    else if (start >= 0) {
      const s = buf.slice(start, i).toString('utf16le');
      if (s.length >= need) return s;
      start = -1;
    }
  }
  return null;
}

function main() {
  const file = process.argv[2];
  if (!file) { console.error('usage: prorec.js <file.pro> [--from=0x800] [--limit=200] [--raw]'); process.exit(2); }
  const args = process.argv.slice(3);
  const fromArg = args.find((a) => a.startsWith('--from='));
  const limArg = args.find((a) => a.startsWith('--limit='));
  const raw = args.includes('--raw');
  const buf = fs.readFileSync(file);
  const used = u32(buf, 8);
  console.log('file=' + file + ' size=' + buf.length + ' used=' + used);
  let off = fromArg ? parseInt(fromArg.split('=')[1], 16) : 0x800;
  let limit = limArg ? Number(limArg.split('=')[1]) : 200;
  let n = 0;
  const stats = new Map();
  while (off + 4 <= Math.min(used, buf.length) && n < limit) {
    const t0 = buf[off], t1 = buf[off + 1];
    if (!((t0 === 0xfa && t1 === 0xfa) || (t0 === 0xfe && t1 === 0xfe))) {
      // resync: find next FAFA/FEFE
      let j = off + 1;
      while (j + 4 <= Math.min(used, buf.length)) {
        if ((buf[j] === 0xfa && buf[j + 1] === 0xfa) || (buf[j] === 0xfe && buf[j + 1] === 0xfe)) break;
        j++;
      }
      if (j + 4 > Math.min(used, buf.length)) { console.log('no further records at 0x' + off.toString(16)); break; }
      console.log('SKIP 0x' + off.toString(16) + '..0x' + j.toString(16) + ' (' + (j - off) + ' bytes)');
      off = j;
      continue;
    }
    const tag = t0 === 0xfa ? 'FA' : 'FE';
    const len = u16(buf, off + 2);
    const key = tag + ':' + (tag === 'FA' ? u16(buf, off + 4).toString(16) : u32(buf, off + 8).toString(16));
    stats.set(key, (stats.get(key) || 0) + 1);
    const name = namesIn(buf, off + 4, Math.min(off + len, buf.length));
    if (raw) console.log(tag + ' @0x' + off.toString(16).padStart(6, '0') + ' len=' + len + ' hdr=' + hexs(buf, off + 4, 20) + (name ? ' name=' + JSON.stringify(name) : ''));
    else if (tag === 'FA') console.log(tag + ' @0x' + off.toString(16).padStart(6, '0') + ' len=' + len + ' p2=' + u32(buf, off + 6).toString(16) + ' p6=' + u32(buf, off + 10).toString(16) + ' pA=' + u32(buf, off + 14).toString(16) + ' pE=' + u32(buf, off + 18).toString(16) + ' p12=' + u32(buf, off + 22).toString(16) + (name ? ' name=' + JSON.stringify(name) : ''));
    else console.log(tag + ' @0x' + off.toString(16).padStart(6, '0') + ' len=' + len + ' words=' + hexs(buf, off + 4, 20));
    if (len <= 4) { console.log('  !! bad len at 0x' + off.toString(16)); break; }
    off += len;
    n++;
  }
  console.log('records=' + n + ' end=0x' + off.toString(16));
  console.log('--- tag stats ---');
  [...stats.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log('  ' + k + ' x' + v));
}

main();
