#!/usr/bin/env node
'use strict';
/**
 * objhdr.js - show how the per-object header length varies with the object type.
 * For every FAFA record carrying a trailing UTF-16LE name, print:
 *   type (u32 at +0x1A) | headerLen (nameStart - recordStart) | header tail bytes
 * usage: node objhdr.js <file.pro> [--type=0x10] [--limit=80]
 */
const fs = require('fs');

function u16(b, o) { return b.readUInt16LE(o); }
function u32(b, o) { return b.readUInt32LE(o); }

function namedRecord(buf, off, end, maxNameBytes) {
  // earliest start s such that [s,end) decodes to printable UTF-16LE (longest name)
  const limit = Math.max(off + 4, end - (maxNameBytes || 512));
  for (let s = limit; s < end; s++) {
    if ((end - s) % 2 !== 0) continue;
    let okStr = '';
    let ok = true;
    for (let i = s; i < end; i += 2) {
      const c = buf[i] | (buf[i + 1] << 8);
      if (c < 0x20 || (c > 0x7e && c < 0xa0)) { ok = false; break; }
      okStr += String.fromCharCode(c);
    }
    if (ok && okStr.length >= 2) return { start: s, name: buf.slice(s, end).toString('utf16le') };
  }
  return null;
}

function main() {
  const file = process.argv[2];
  if (!file) { console.error('usage: objhdr.js <file.pro> [--type=0x10] [--limit=80]'); process.exit(2); }
  const typeArg = process.argv.find((a) => a.startsWith('--type='));
  const limArg = process.argv.find((a) => a.startsWith('--limit='));
  const onlyType = typeArg ? parseInt(typeArg.split('=')[1], 16) : null;
  const limit = limArg ? Number(limArg.split('=')[1]) : 80;
  const buf = fs.readFileSync(file);
  const used = u32(buf, 8);
  const rows = [];
  let off = 0x800;
  while (off + 4 <= Math.min(used, buf.length)) {
    const t = buf[off] | (buf[off + 1] << 8);
    if (t !== 0xfafa && t !== 0xfefe) { off++; continue; }
    const len = u16(buf, off + 2);
    if (len < 8) { off++; continue; }
    const end = off + len;
    if (end > buf.length) break;
    if (t === 0xfafa) {
      const nr = namedRecord(buf, off, end);
      if (nr) {
        const type = u32(buf, off + 0x1a);
        const headerLen = nr.start - off;
        if (onlyType === null || type === onlyType) {
          rows.push({ off, len, type, headerLen, name: nr.name, tail: buf.slice(off + 0x1e, nr.start).toString('hex') });
        }
      }
    }
    off = end;
  }
  for (const r of rows.slice(0, limit)) {
    console.log('@0x' + r.off.toString(16).padStart(6, '0') + ' len=' + String(r.len).padStart(4) +
      ' type=0x' + r.type.toString(16).padStart(2, '0') + ' hdrLen=' + String(r.headerLen).padStart(2) +
      ' name=' + JSON.stringify(r.name) + ' tail=' + r.tail);
  }
  console.log('named total=' + rows.length);
}

main();
