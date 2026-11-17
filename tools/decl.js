#!/usr/bin/env node
'use strict';
/**
 * decl.js - prototype decoder for POU variable declarations (Kopf/Header chunks).
 *
 * A declaration chunk is a TLV-ish sequence: u32 length + UTF-16LE string tokens,
 * interleaved with u32/u16 binary fields. Observed token order per variable:
 *   name, <u32 -1>, <u32 0>, <u16 0>, u32+typeName, u32+initialValue, u32+scope
 *
 * usage: node tools/decl.js <file.pro> <pouName> [--raw]
 */
const fs = require('fs');
const path = require('path');
const { parseProject, extractContents, pous, contentsOf } = require('../lib/proparse');

const file = process.argv[2];
const pouName = process.argv[3];
if (!file || !pouName) { console.error('usage: decl.js <file.pro> <pouName> [--raw]'); process.exit(2); }
const buf = fs.readFileSync(file);
const project = parseProject(buf, { file });
const contents = extractContents(buf, project);
const pou = pous(project).find((p) => p.name === pouName);
if (!pou) { console.error('POU not found: ' + pouName); process.exit(1); }

const SCOPES = new Set(['VAR', 'VAR_INPUT', 'VAR_OUTPUT', 'VAR_IN_OUT', 'VAR_TEMP', 'VAR_EXTERNAL', 'VAR_GLOBAL', 'VAR_STAT']);

function printableUtf16(data, off, chars) {
  if (chars <= 0 || chars > 512) return null;
  const end = off + chars * 2;
  if (end > data.length) return null;
  let s = '';
  for (let i = off; i < end; i += 2) {
    const c = data[i] | (data[i + 1] << 8);
    if (c < 0x20 || (c > 0x7e && c < 0xa0)) return null;
    s += String.fromCharCode(c);
  }
  return s;
}

function tokenize(data) {
  const tokens = [];
  let i = 0;
  while (i + 4 <= data.length) {
    const v = data.readUInt32LE(i);
    const str = printableUtf16(data, i + 4, v);
    if (str !== null) {
      tokens.push({ kind: 'str', value: str, at: i });
      i += 4 + str.length * 2;
    } else {
      tokens.push({ kind: 'bin', value: v, at: i });
      i += 4;
    }
  }
  return tokens;
}

const section = (pou.children || []).find((c) => /Kopf|Header/i.test(c.name)) || (pou.children || []).find((c) => c.type === 0x0b);
if (!section) { console.error('no declaration section for ' + pouName); process.exit(1); }
const chunks = contentsOf(contents, section.id).filter((c) => !c.text);
console.log('POU ' + pou.name + ' declaration section ' + section.name + ' chunks=' + chunks.length);

const rows = [];
for (const ch of chunks) {
  const tokens = tokenize(ch.data);
  const strings = tokens.filter((t) => t.kind === 'str').map((t) => t.value);
  const scope = strings.find((s) => SCOPES.has(s));
  const name = strings[0];
  const rest = strings.slice(1).filter((s) => !SCOPES.has(s));
  rows.push({ offset: ch.frameOffset, name, scope, rest, tokens });
}

for (const r of rows) {
  console.log('@0x' + r.offset.toString(16).padStart(6, '0') + '  ' + String(r.scope || '?').padEnd(12) + String(r.name).padEnd(24) + ' tokens=' + JSON.stringify(r.rest));
}
