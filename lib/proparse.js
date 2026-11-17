'use strict';
/**
 * proparse.js - offline parser for Panasonic Control FPWIN Pro 7 / CoDeSys 2.3
 * binary `.pro` project containers.
 *
 * Format as established empirically (see HANDOFF-2026-11-16.md and tools/prorec.js):
 *
 *   file header : "FF FF 01 00" then u32 usedLength at +0x08; the rest of the first
 *                 0x800 bytes is the container header, the body is a chain of
 *                 frames padding (0xFF) up to the next 0x800 boundary.
 *   frame       : tag(u16) len(u16) payload(len-4 bytes)
 *                 tag 0xFAFA = SC block   (object / data / cross-reference records)
 *                 tag 0xFEFE = page/dir header
 *
 * SC block payload for *named objects*, offsets relative to the frame start:
 *
 *   +0x00 u16  tag        0xFAFA
 *   +0x02 u16  len        whole frame length, tag+len included
 *   +0x04 u16  0
 *   +0x06 u32  size hint  (unused)
 *   +0x0A u32  2          (constant in every observed record)
 *   +0x0E u32  prev       file offset of the previous block
 *   +0x12 u32  id         object id (0xD7, …)
 *   +0x16 u32  parent     parent object id (0 = root "Projekt")
 *   +0x1A u32  type       CoDeSys object type code (0 root, 3 DUTs, 4 POEs, 0x0D globals, 0x12 tasks, …)
 *   +0x1E u32  mtime      last modification, Unix seconds (also exported as `checksum`)
 *   +0x22 u32  0
 *   +0x26 3B   attrs      flag bytes; +0x29 is the name length
 *   +0x2C u16le name[]    UTF-16LE name, `+0x29` characters
 *
 * Blocks with an empty name are data / cross-reference records; they carry the
 * same header so they can be reported as "anonymous" records.
 *
 * No third-party dependencies, CommonJS.
 */

// Object type codes. 0x0F/0x10/0x11 are confirmed against the shipped .asc
// exports (tools/typecensus.js over D:\FP7752\Samples\English: 71 PROGRAMS,
// 22 FUNCTION_BLOCKs, 22 FUNCTIONs, 0 mismatches); the other entries are
// derived from the object tree of the sample projects.
const TYPE_NAMES = {
  0x00: 'project',
  0x02: 'plc-config',
  0x03: 'folder:duts',
  0x04: 'folder:pous',
  0x06: 'section',
  0x0b: 'section:header',
  0x0d: 'globals',
  0x0e: 'folder:programs',
  0x0f: 'program',
  0x10: 'function_block',
  0x11: 'function',
  0x12: 'tasks',
  0x13: 'section:body',
  0x14: 'compile_result',
  0x15: 'symbol_table',
  0x16: 'libraries',
};

const HEADER_LEN = 0x2d; // 4-byte frame + 0x29 payload header
const MIN_FRAME = 8;
const CONTENT_HEADER_LEN = 0x22; // data frame: zlib stream starts at +0x22 (kind 6) / +0x24 (kind 4)

function u16(buf, o) { return buf.readUInt16LE(o); }
function u32(buf, o) { return buf.readUInt32LE(o); }

/** Read a printable UTF-16LE string from `from` up to `to`; '' when absent. */
function readName(buf, from, to) {
  let s = '';
  for (let i = from; i + 1 < to; i += 2) {
    const c = (buf[i] | (buf[i + 1] << 8)) & 0xffff;
    if (c === 0) break;
    if (c < 0x20 || (c > 0x7e && c < 0xa0)) break;
    s += String.fromCharCode(c);
  }
  return s;
}

/**
 * FPWIN Pro 7.7 writes section/record payloads as `FC FC` frames instead of
 * `FA FA` data frames. The payload layout is the same as a kind-4 data frame
 * (kind at +0x0a, record id at +0x12, owner at +0x16, zlib at +0x24) plus a
 * fixed 0x40 flag at +0x1e and the uncompressed size at +0x20.
 *
 * Without this tag the linear walk stalls on the first 7.7 record, scans byte
 * by byte, and a random `FA FA` byte pair inside a compressed stream is then
 * taken for a 42 KB frame that swallows a whole run of real records (the task
 * binding records among them). Validation is deliberately strict: kind must be
 * a known content kind and the 0x40 flag must be present.
 */
function looksLikeContentRecord(buf, off, len) {
  if (len < 0x24) return false;
  const kind = u32(buf, off + 0x0a);
  if (kind !== 4 && kind !== 6 && kind !== 10) return false;
  if (u16(buf, off + 0x1e) !== 0x40) return false;
  const id = u32(buf, off + 0x12);
  const owner = u32(buf, off + 0x16);
  return id <= 0x100000 && owner <= 0x100000;
}

function looksLikeObjectRecord(buf, off, len) {
  if (len < HEADER_LEN) return false;
  if (u16(buf, off + 4) !== 0) return false;
  if (u32(buf, off + 10) !== 2) return false;
  const prev = u32(buf, off + 14);
  if (prev !== 0 && (prev < 0x800 || prev >= buf.length)) return false;
  for (let i = off + 0x2a; i < off + HEADER_LEN - 1; i++) if (buf[i] !== 0) return false;
  const id = u32(buf, off + 18);
  const parent = u32(buf, off + 22);
  if (id > 0x100000 || parent > 0x100000) return false;
  const nameLen = buf[off + 0x29];
  if (nameLen === 0) return true; // anonymous data record
  if (HEADER_LEN + nameLen * 2 > len) return false; // name would overrun the frame
  for (let k = 0; k < nameLen; k++) {
    const c = buf[off + HEADER_LEN + k * 2] | (buf[off + HEADER_LEN + k * 2 + 1] << 8);
    if (c < 0x20 || (c > 0x7e && c < 0xa0)) return false;
  }
  return true;
}

/** Read exactly `chars` UTF-16LE characters at `from`. */
function readNameFixed(buf, from, chars) {
  let s = '';
  for (let k = 0; k < chars; k++) {
    const i = from + k * 2;
    if (i + 1 >= buf.length) break;
    s += String.fromCharCode(buf[i] | (buf[i + 1] << 8));
  }
  return s;
}

/**
 * Parse one .pro buffer.
 * @returns {{file:string,size:number,usedLength:number,header:object,records:Array,objects:Array,tree:object|null,warnings:string[]}}
 */
function parseProject(buf, opts) {
  const options = opts || {};
  const warnings = [];
  const size = buf.length;
  if (size < 0x800) throw new Error('not a .pro container: file shorter than 0x800 bytes');
  // u32@0 is not a magic word: it is `size - 1`, the container length written in the
  // classic (block:offset) 16+16 layout. Verified on 43 containers from 64 KiB to
  // 3.1 MiB. The 131072-byte samples read 0x0001FFFF, which is why early notes
  // mistook the low word for a "FFFF" magic and rejected every project whose size is
  // not a multiple of 64 KiB (e.g. the 1212416-byte customer projects, 0x127FFF).
  const sizeField = buf.readUInt32LE(0);
  if (sizeField !== ((size - 1) >>> 0)) {
    throw new Error('not a .pro container: size field 0x' + sizeField.toString(16) +
      ' != file size - 1 (0x' + ((size - 1) >>> 0).toString(16) + ')');
  }
  const usedLength = u32(buf, 8);

  const records = [];
  const objects = [];
  let off = 0x800;
  const limit = Math.min(usedLength || size, size);
  const seen = new Set();
  while (off + MIN_FRAME <= limit) {
    const t = buf[off] | (buf[off + 1] << 8);
    if (t !== 0xfafa && t !== 0xfefe && t !== 0xfcfc) { off++; continue; }
    const len = u16(buf, off + 2);
    if (len < MIN_FRAME) { off++; continue; }
    const end = off + len;
    if (end > limit) {
      // A bogus frame: try to resynchronise on the next frame tag instead of
      // aborting the whole walk.
      off++;
      continue;
    }
    const rec = { offset: off, length: len, tag: t === 0xfefe ? 'page' : 'block' };
    if (t === 0xfcfc && !looksLikeContentRecord(buf, off, len)) { off++; continue; }
    if (t === 0xfefe) {
      // A page frame stores its used-byte count at +0x06: 9 for an empty (0xFF-filled)
      // page and `len - 22` otherwise (31 → 9, 50 → 28, 2048 → 2026). Random 0xFE 0xFE
      // byte pairs inside compressed content do not satisfy this, and accepting them
      // desynchronises the linear walk (very visible in multi-megabyte projects).
      const used = u16(buf, off + 6);
      if (used !== 9 && used !== len - 22) { off++; continue; }
    }
    if (t === 0xfafa && looksLikeObjectRecord(buf, off, len)) {
      rec.kind = 'object';
      rec.sizeHint = u32(buf, off + 6);
      rec.prev = u32(buf, off + 14);
      rec.id = u32(buf, off + 18);
      rec.parent = u32(buf, off + 22);
      rec.type = u32(buf, off + 26);
      rec.checksum = u32(buf, off + 30);
      // +0x1E is not a checksum: it is the object's last modification time in
      // Unix seconds (root object = last save; 0 = never stamped). Kept under
      // the old name `checksum` and exposed as `mtime` / `mtimeIso`.
      rec.mtime = rec.checksum;
      rec.mtimeIso = rec.mtime ? new Date(rec.mtime * 1000).toISOString() : null;
      rec.attrs = buf.slice(off + 0x26, off + 0x2a).toString('hex');
      rec.nameLength = buf[off + 0x29];
      rec.name = rec.nameLength ? readNameFixed(buf, off + HEADER_LEN, rec.nameLength) : '';
      rec.extraBytes = Math.max(0, end - (off + HEADER_LEN + rec.nameLength * 2));
      records.push(rec);
      seen.add(off);
      if (rec.name) objects.push(rec);
    } else {
      rec.kind = 'data';
      records.push(rec);
    }
    off = end;
  }

  // Safety net: some projects contain frames nested inside data blobs, which
  // desynchronise the linear walk. Recover every object record that the walk
  // did not reach by validating each FA FA candidate independently.
  let scanRecovered = 0;
  for (let p = 0x800; p + MIN_FRAME <= limit; p++) {
    if (seen.has(p)) continue;
    if (buf[p] !== 0xfa || buf[p + 1] !== 0xfa) continue;
    const len = u16(buf, p + 2);
    if (len < HEADER_LEN || p + len > limit) continue;
    if (!looksLikeObjectRecord(buf, p, len)) continue;
    const nameLength = buf[p + 0x29];
    const name = nameLength ? readNameFixed(buf, p + HEADER_LEN, nameLength) : '';
    const rec = {
      offset: p,
      length: len,
      tag: 'block',
      kind: 'object',
      recoveredByScan: true,
      sizeHint: u32(buf, p + 6),
      prev: u32(buf, p + 14),
      id: u32(buf, p + 18),
      parent: u32(buf, p + 22),
      type: u32(buf, p + 26),
      checksum: u32(buf, p + 30),
      mtime: u32(buf, p + 30),
      mtimeIso: u32(buf, p + 30) ? new Date(u32(buf, p + 30) * 1000).toISOString() : null,
      attrs: buf.slice(p + 0x26, p + 0x2a).toString('hex'),
      nameLength,
      name,
      extraBytes: Math.max(0, p + len - (p + HEADER_LEN + nameLength * 2)),
    };
    records.push(rec);
    if (name) { objects.push(rec); scanRecovered++; }
  }
  records.sort((a, b) => a.offset - b.offset);
  objects.sort((a, b) => a.offset - b.offset);

  // Build id -> object map and tree.
  const byId = new Map();
  for (const o of objects) {
    if (byId.has(o.id)) warnings.push('duplicate object id 0x' + o.id.toString(16));
    byId.set(o.id, o);
  }
  for (const o of objects) {
    o.typeName = TYPE_NAMES[o.type] || ('type:0x' + o.type.toString(16));
    o.children = [];
  }
  for (const o of objects) {
    if (o.parent === 0) continue;
    const p = byId.get(o.parent);
    if (p) p.children.push(o);
    else warnings.push('object "' + o.name + '" (0x' + o.id.toString(16) + ') has unresolved parent 0x' + o.parent.toString(16));
  }
  const roots = objects.filter((o) => o.parent === 0);

  return {
    file: options.file || null,
    size,
    usedLength,
    header: {
      // legacy key name: u32@0 is the container length - 1, not a magic word
      magic: '0x' + u32(buf, 0).toString(16),
      sizeField: u32(buf, 0),
      usedLength,
      pageSize: u32(buf, 12),
      words: Array.from({ length: 8 }, (_, i) => '0x' + u32(buf, i * 4).toString(16)),
    },
    records,
    objects,
    roots,
    warnings,
  };
}

/** Flatten the object tree depth-first. */
function walk(project) {
  const out = [];
  const visit = (o, depth) => {
    out.push({ depth, id: o.id, parent: o.parent, type: o.type, typeName: o.typeName, name: o.name, offset: o.offset });
    for (const c of o.children) visit(c, depth + 1);
  };
  for (const r of project.roots) visit(r, 0);
  return out;
}

/** All named objects whose typeName starts with `prefix`. */
function byType(project, prefix) {
  return project.objects.filter((o) => o.typeName.startsWith(prefix));
}

/** Program organisation units: PROGRAM / FUNCTION_BLOCK / FUNCTION. */
function pous(project) {
  return project.objects.filter((o) => o.type === 0x0f || o.type === 0x10 || o.type === 0x11);
}

/** Object lookup by exact name (first match). */
function findByName(project, name) {
  return project.objects.find((o) => o.name === name) || null;
}

// ---------------------------------------------------------------------------
// Content frames: FPWIN stores section payloads as zlib streams inside the
// unnamed data frames. Text payloads (LD/SFC/IL bodies, config export) are
// UTF-16LE; declarations and address tables are binary.
// ---------------------------------------------------------------------------

function findZlibStart(buf, frameOffset) {
  // Content frames keep the zlib stream at a fixed offset per record kind
  // (kind 10 at +0x1A, kind 6 at +0x22, kind 4 at +0x24). Trying that offset first
  // matters when a header field itself looks like a zlib stream: a record id of
  // 0x0178 starts with `78 01`, and the old blind scan then inflated from the id.
  const kind = u32(buf, frameOffset + 0x0a);
  const exact = kind === 4 ? 0x24 : kind === 6 ? 0x22 : kind === 10 ? 0x1a : -1;
  if (exact > 0) {
    const i = frameOffset + exact;
    if (i + 1 < buf.length && buf[i] === 0x78 &&
      (buf[i + 1] === 0x01 || buf[i + 1] === 0x5e || buf[i + 1] === 0x9c || buf[i + 1] === 0xda)) return i;
  }
  const from = frameOffset + 0x12;
  const to = Math.min(frameOffset + 0x40, buf.length - 1);
  for (let i = from; i < to; i++) {
    if (buf[i] === 0x78 && (buf[i + 1] === 0x01 || buf[i + 1] === 0x5e || buf[i + 1] === 0x9c || buf[i + 1] === 0xda)) return i;
  }
  return -1;
}

function decodeUtf16Text(data) {
  const n = data.length & ~1;
  if (n < 8) return null;
  let printable = 0;
  for (let i = 0; i < n; i += 2) {
    const c = data[i] | (data[i + 1] << 8);
    if (c === 0) return null;
    if (c === 9 || c === 10 || c === 13 || (c >= 32 && c < 0x7f)) printable++;
  }
  return printable / (n / 2) >= 0.9 ? data.slice(0, n).toString('utf16le') : null;
}

/**
 * Decompress every content frame of the project.
 * @returns {Array<{frameOffset:number,kind:number,ownerId:number,owner:object|null,size:number,text:string|null,data:Buffer}>}
 */
function extractContents(buf, project) {
  const zlib = require('zlib');
  const byId = new Map(project.objects.map((o) => [o.id, o]));
  const out = [];
  for (const f of project.records) {
    if (f.tag !== 'block' || f.kind === 'object') continue;
    const z = findZlibStart(buf, f.offset);
    if (z < 0) continue;
    let data;
    try {
      data = zlib.inflateSync(buf.slice(z), { finishFlush: zlib.constants.Z_SYNC_FLUSH });
    } catch (e) { continue; }
    if (data.length < 4) continue;
    const kind = buf.readUInt32LE(f.offset + 0x0a);
    const ownerId = kind === 6 ? buf.readUInt32LE(f.offset + 0x12) : buf.readUInt32LE(f.offset + 0x16);
    out.push({
      frameOffset: f.offset,
      kind,
      ownerId,
      // kind-4 frames carry their own content-record id at +0x12; task setting
      // frames reference bindings by this id (see tasks()).
      recordId: kind === 4 ? buf.readUInt32LE(f.offset + 0x12) : null,
      owner: byId.get(ownerId) || null,
      size: data.length,
      text: decodeUtf16Text(data),
      data,
    });
  }
  return out;
}

/** All content chunks owned by one object id, in file order. */
function contentsOf(contents, ownerId) {
  return contents.filter((c) => c.ownerId === ownerId).sort((a, b) => a.frameOffset - b.frameOffset);
}

// ---------------------------------------------------------------------------
// Variable declarations: the Kopf/Header section stores one binary record per
// variable:
//   u32 nameLen + UTF-16 name
//   u32 typeRef          (-1 when the type is named inline, otherwise a UDT id)
//   u16 flags
//   then a sequence of u32 len + UTF-16 strings. Read from the end:
//     last  = scope (VAR / VAR_INPUT / VAR_OUTPUT / VAR_EXTERNAL / …)
//     -2    = initial value ("" when none)
//     -3    = type name ("BOOL", "REAL", … or a UDT name)
//     rest  = comment
// Records are variable length: an empty comment simply omits its string.
// ---------------------------------------------------------------------------

const SCOPES = new Set([
  'VAR', 'VAR_INPUT', 'VAR_OUTPUT', 'VAR_IN_OUT', 'VAR_TEMP', 'VAR_EXTERNAL', 'VAR_GLOBAL',
  'VAR_STAT', 'VAR_RETAIN', 'VAR_CONSTANT', 'VAR_CONFIG',
]);

function readUtf16String(data, off, chars) {
  if (chars <= 0 || chars > 4096) return null;
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

const ADDRESS_RE = /^%[IQM]([XBWD]|X|Y)?[\d.]*$/i;
// Initial-value literals: digits, TRUE/FALSE, quoted strings, typed literals and
// array aggregates. Used only to disambiguate an explicit empty AT slot.
const VALUE_LITERAL_RE = /^([-+]?\d|TRUE\b|FALSE\b|'|\[|T#|TIME#|D#|DATE#|TOD#|DT#|16#|2#|8#)/i;
const TYPE_NAME_RE = /^(ARRAY\b|POINTER\b|REFERENCE\b|STRING\s*\[.*\]|[A-Za-z_][\w]*(\s*\[.*\]\s*OF\s*.+)?)$/;

/**
 * Decode one variable record; returns null when the layout does not fit.
 * `allowNoScope` is used for DUT fields (records without a scope string).
 *
 * Token order, all optional except type/initial value:
 *   [comment] type initialValue [address] [scope]
 *
 * The empty-string ambiguity: a token list ending in
 *   ["", "INT", "", "VAR"]     is comment/type/empty-init/scope, and
 *   ["", "INT", "0", "", "VAR"] is comment/type/init/empty-AT/scope
 * (an AT slot that is present but empty is written out, e.g. Coffee machine's
 * global "credit"). The empty token is treated as an AT slot only when the two
 * tokens before it are a plausible initial-value literal and a plausible type
 * name, so an empty initial value is not mistaken for an address.
 */
function parseVariableRecord(data, allowNoScope) {
  if (data.length < 12) return null;
  const nameLen = data.readUInt32LE(0);
  const name = readUtf16String(data, 4, nameLen);
  if (!name) return null;
  let off = 4 + nameLen * 2;
  if (off + 6 > data.length) return null;
  const typeRef = data.readUInt32LE(off);
  off += 4;
  // Two record dialects, distinguished by the u32 that follows the name:
  //   0xFFFFFFFF (classic, projects written by 6.00.00 / 7.5.0.0):
  //       u32 typeRef, u16 flags, strings
  //   0xFFFFFFFE (7.7.x, e.g. a 7.7.4.0 project):
  //       u32 0xFFFFFFFE, u32 guidLen, UTF-16 GUID, u16 0 terminator, strings
  //   i.e. the flags word is replaced by a per-record GUID. Verified by consuming
  //   every kind-4 chunk of a 7.7.4.0 project exactly (1589/1589, 0 bytes left over).
  // Both sentinels mean "the type is named inline"; no UDT id has ever been observed.
  let flags = 0;
  let guid = null;
  if (typeRef === 0xfffffffe) {
    if (off + 4 > data.length) return null;
    const guidLen = data.readUInt32LE(off);
    if (guidLen > 0 && guidLen <= 256 && off + 4 + guidLen * 2 + 2 <= data.length) {
      guid = data.slice(off + 4, off + 4 + guidLen * 2).toString('utf16le');
      off += 4 + guidLen * 2 + 2;
    } else {
      return null;
    }
  } else {
    if (off + 2 > data.length) return null;
    flags = data.readUInt16LE(off);
    off += 2;
  }
  const strings = [];
  while (off + 4 <= data.length) {
    const len = data.readUInt32LE(off);
    if (len === 0) { strings.push(''); off += 4; continue; } // empty comment / empty optional field
    const s = readUtf16String(data, off + 4, len);
    if (s === null) break;
    strings.push(s);
    off += 4 + s.length * 2;
  }
  if (!strings.length) return null;
  let idx = strings.length - 1;
  let scope = null;
  if (SCOPES.has(strings[idx])) { scope = strings[idx]; idx--; }
  if (!scope && !allowNoScope) return null; // not a declaration record
  let address = null;
  if (idx >= 0 && ADDRESS_RE.test(strings[idx])) {
    address = strings[idx];
    idx--;
  } else if (idx >= 2 && strings[idx] === '' && VALUE_LITERAL_RE.test(strings[idx - 1]) && TYPE_NAME_RE.test(strings[idx - 2])) {
    idx--; // explicit but empty AT slot: keep address === null
  }
  let initialValue = idx >= 0 ? strings[idx] : '';
  idx--;
  let typeName = idx >= 0 ? strings[idx] : '';
  idx--;
  let comment = idx >= 0 ? strings.slice(0, idx + 1).join('') : '';
  // DUT field without initial value: the strings run out one earlier.
  if (!typeName && initialValue) { typeName = initialValue; initialValue = ''; }
  // A lone empty token is a section marker, not a declaration.
  if (!typeName && !initialValue && !scope) return null;
  return {
    name,
    // -1 = the type is named inline. Both sentinels (0xFFFFFFFF classic,
    // 0xFFFFFFFE 7.7.x + GUID) mean this; a real UDT id has never been observed.
    typeRef: (typeRef === 0xffffffff || typeRef === 0xfffffffe) ? -1 : typeRef,
    guid,
    flags,
    typeName,
    initialValue,
    // null for DUT fields, which carry no scope token
    scope: scope || null,
    address,
    comment,
  };
}

/** Backwards-compatible alias used for POU declarations. */
function parseDeclarationRecord(data) {
  return parseVariableRecord(data, false);
}

/**
 * Variable declarations of a POU, decoded from its declaration section
 * (Kopf/Header) binary chunks.
 * @returns {Array<{name,scope,typeName,initialValue,comment,typeRef,frameOffset}>}
 */
function pouDeclarations(project, contents, pou) {
  const section = (pou.children || []).find((c) => /^(Kopf|Header|Declarations?)$/i.test(c.name)) ||
    (pou.children || []).find((c) => c.type === 0x0b);
  if (!section) return { section: null, variables: [] };
  const vars = [];
  for (const chunk of contentsOf(contents, section.id)) {
    if (chunk.text) continue;
    const rec = parseDeclarationRecord(chunk.data);
    if (rec) vars.push({ ...rec, frameOffset: chunk.frameOffset });
  }
  return { section, variables: vars };
}

// ---------------------------------------------------------------------------
// DUTs (TYPE … END_TYPE) and global variable lists.
//
// A DUT is an object of type 0x0c; it has no child objects. Its fields live in
// binary (kind 4) content chunks owned by the DUT itself, one record per field,
// with the same record layout as POU declarations except that the scope token is
// absent (it is a STRUCT/UNION field list, not a VAR block):
//
//   u32 nameLen + UTF-16 name + u32 typeRef + u16 flags
//   + (u32 len + UTF-16 string)* = ["", typeName, initialValue]
//
// The empty leading string is the (absent) comment slot. A DUT object also owns
// one kind 6 chunk that lists the field chunk ids; the field order in the file
// matches the declaration order in the .asc export.
//
// A global variable list is an object of type 0x0d. Every project has one
// (template placeholder, name "Glob. Variablen" / "Global Variables"), and its
// content is the same unnamed data-frame chain as a POU; a populated list stores
// one declaration record per variable, scope VAR_GLOBAL.
// ---------------------------------------------------------------------------

/** DUT objects (TYPE … END_TYPE). */
function duts(project) {
  return project.objects.filter((o) => o.type === 0x0c);
}

/** Global variable list objects. */
function globalVarObjects(project) {
  return project.objects.filter((o) => o.type === 0x0d);
}

/**
 * Fields of one DUT, decoded from the binary chunks owned by the DUT object.
 * @returns {{dut:object, fields:Array}}
 */
function dutDeclarations(project, contents, dut) {
  const fields = [];
  for (const chunk of contentsOf(contents, dut.id)) {
    if (chunk.text) continue;
    const rec = parseVariableRecord(chunk.data, true);
    if (rec) fields.push({ ...rec, scope: null, frameOffset: chunk.frameOffset });
  }
  return { dut, fields };
}

/**
 * Global variables of the project (all type 0x0d lists).
 *
 * Empty lists (the template placeholder every project carries) produce no
 * records, so an unscoped fallback is attempted for lists whose records omit the
 * scope token.
 * @returns {{lists:Array<{object:object,variables:Array}>, variables:Array}}
 */
function globalVariables(project, contents) {
  const lists = [];
  const variables = [];
  for (const obj of globalVarObjects(project)) {
    const own = [];
    for (const chunk of contentsOf(contents, obj.id)) {
      if (chunk.text) continue;
      const rec = parseVariableRecord(chunk.data, false) || parseVariableRecord(chunk.data, true);
      if (!rec) continue;
      const variable = { ...rec, scope: rec.scope || 'VAR_GLOBAL', list: obj.name, listId: obj.id, frameOffset: chunk.frameOffset };
      own.push(variable);
      variables.push(variable);
    }
    lists.push({ object: obj, variables: own });
  }
  return { lists, variables };
}

// ---------------------------------------------------------------------------
// Tasks: object type 0x12 ("Tasks"/"Aufgaben") holds one child object (type 0x0E)
// per configured task.
//
// 1) Settings: kind 6 content frame, payload
//      u32 0xFFFFFFFF (sentinel), then the string sequence
//      [SINGLE, INTERVAL, PRIORITY]
//    e.g. ["FALSE", "T#10ms", "31"] or ["I0", "0", "31"] for interrupt I0,
//    followed by u32 0xFFFFFFFF, u32 count and count u32 ids.
//    The ids are the *binding records' own ids* (the +0x12 header field of the
//    kind-4 frames below, listed in assignment order) — not object ids and not
//    a separate "assignment number" series.
//
// 2) Program assignment ("PROGRAM X WITH <task>"): one kind 4 content frame per
//    assigned PROGRAM, owned by the task object, in assignment order:
//      u32 nameLen + UTF-16LE program name + u32 0xFFFFFFFF + 6 zero bytes
//    The name keeps the exact case of the PROGRAM object, so it can be matched
//    against pous() directly. Kind 10 frames owned by the task repeat the same
//    names upper-cased (secondary evidence, not used for the output).
//    Validated against all 27 shipped samples: 32/32 .asc-with-task bindings.
//
//    7.7.x differences (sample: 客户甲一体机临时.pro):
//      - the records are written as `FC FC` frames instead of `FA FA` data
//        frames (same payload layout, see looksLikeContentRecord);
//      - names are ordinary UTF-16 text, so CJK PROGRAM names such as
//        `工位甲手动上料_CON` are valid — readAssignmentName only rejects
//        control characters and lone surrogates;
//      - a cleared assignment keeps its record but zeroes the payload
//        (`00000000 FFFFFFFF 0…`), so the id resolves to no name: tasks()
//        reports those ids in `emptyIds`, separate from `danglingIds`
//        (record deleted outright). 9/11 names resolve in the 7.7 sample.
// ---------------------------------------------------------------------------

/** Tasks object groups (type 0x12). */
function taskGroups(project) {
  return project.objects.filter((o) => o.type === 0x12);
}

/** Read a u32-length-prefixed UTF-16LE string sequence; stops at the first field that does not fit. */
function readStringSequence(data) {
  return readStringSequenceState(data).strings;
}

/** Like readStringSequence, but also returns the offset where the sequence stopped. */
function readStringSequenceState(data) {
  const strings = [];
  let off = 0;
  while (off + 4 <= data.length) {
    const len = data.readUInt32LE(off);
    if (len > 4096) break;
    if (len === 0) { strings.push(''); off += 4; continue; }
    const s = readUtf16String(data, off + 4, len);
    if (s === null) break;
    strings.push(s);
    off += 4 + s.length * 2;
  }
  return { strings, offset: off };
}

/**
 * Decode one task settings payload: string sequence + trailing program id list.
 * @returns {{strings:string[], programIds:number[]}}
 */
function parseTaskRecord(data) {
  const start = data.length >= 4 && data.readUInt32LE(0) === 0xffffffff ? 4 : 0;
  const state = readStringSequenceState(data.slice(start));
  const programIds = [];
  const off = start + state.offset;
  if (off + 8 <= data.length && data.readUInt32LE(off) === 0xffffffff) {
    const count = data.readUInt32LE(off + 4);
    if (count <= 256 && off + 8 + count * 4 <= data.length) {
      for (let i = 0; i < count; i++) programIds.push(data.readUInt32LE(off + 8 + i * 4));
    }
  }
  return { strings: state.strings, programIds };
}

/**
 * Read a task-assignment name record (see the block comment above).
 * The name is UTF-16LE, so it is not ASCII-only: 7.7 projects bind POU names
 * such as `工位甲手动上料_CON` or `扫码程序`. Only control characters, DEL and
 * lone surrogates are rejected.
 * @returns {string|null} PROGRAM name, or null when the record does not fit.
 */
function readAssignmentName(data) {
  if (data.length < 16) return null;
  const len = data.readUInt32LE(0);
  if (len < 1 || len > 256) return null;
  const end = 4 + len * 2;
  if (end + 4 > data.length || data.readUInt32LE(end) !== 0xffffffff) return null;
  let name = '';
  for (let i = 0; i < len; i++) {
    const c = data.readUInt16LE(4 + i * 2);
    if (c < 0x20 || c === 0x7f || (c >= 0xd800 && c <= 0xdfff)) return null;
    name += String.fromCharCode(c);
  }
  return name;
}

/**
 * PROGRAMS assigned to one task, in file order.
 * `recordId` is the binding record's own id (the kind-4 frame header field +0x12);
 * the task setting frame lists exactly these ids in assignment order.
 * @returns {Array<{name:string, recordId:number|null, frameOffset:number}>}
 */
function taskAssignments(project, contents, task) {
  const out = [];
  for (const chunk of contentsOf(contents, task.id)) {
    if (chunk.kind !== 4) continue;
    const name = readAssignmentName(chunk.data);
    if (name) out.push({ name, recordId: chunk.recordId === undefined ? null : chunk.recordId, frameOffset: chunk.frameOffset });
  }
  return out;
}

// ---------------------------------------------------------------------------
// SFC charts: an SFC POU owns a chart section (type 0x08) whose kind 6 content
// frame is a binary element stream (no BODY text). The stream is a sequence of
// element records, each introduced by the marker u32 0x467312AA:
//
//   +0x00 u32 marker 0x467312AA
//   +0x04 u32 1          (format/version)
//   +0x08 u32 1
//   +0x0E u16 element sequence number (6, 7, 8 ...)
//   +0x12 u16 element kind
//   +0x16 u16 name length INCLUDING the trailing NUL (1 = no name)
//   +0x1A     UTF-16LE name
//
// Kind codes observed on the 4 shipped SFC samples: 2 = INITIAL_STEP,
// 6 = STEP, 8 = TRANSITION, 3 = FINAL_STEP (nameless), 1 = chart start pseudo
// element, 11/12/13/14 = unnamed branch/jump pseudo elements whose exact
// semantics (divergence/convergence connectors) are still being decoded.
//
// After the name:
//   - STEP / INITIAL_STEP: u32 0, u32 actionCount, u32 textChars, then
//     textChars UTF-16 chars of action list (one action per CRLF line, an
//     optional tab-separated qualifier such as N, padded with NULs).
//   - TRANSITION: u32 hasBody; when 1: u32 sectionId (the transition object),
//     u32 langChars, then the language tag (LD/IL/FBD) + NUL.
//   - other kinds: two zero u32 fields.
//
// Transition and ACTION bodies are ordinary text content frames owned by the
// transition/action objects (same zlib + UTF-16LE BODY...END_BODY dialect as
// POU bodies), so they are exposed through sectionSource().
// ---------------------------------------------------------------------------

const SFC_MARKER = 0x467312aa;
const SFC_KINDS = {
  1: 'start', 2: 'initial-step', 3: 'final-step', 6: 'step', 8: 'transition',
  11: 'divergence', 12: 'convergence', 13: 'branch-start', 14: 'branch-end',
};
// The chart prefix is a link table with one 20-byte row per element id; row k
// belongs to id k + 2 because ids 1..2 are the chart/start pseudo roots.
const SFC_TABLE_PREFIX = 60; // 15 header words
const SFC_TABLE_BASE = 2;

/** Split an SFC action list text into [{name, qualifier}]. */
function parseSfcActionText(text) {
  const out = [];
  for (const line of String(text).replace(/\u0000/g, '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split('\t').map((s) => s.trim()).filter(Boolean);
    out.push({ name: parts[0], qualifier: parts[1] || null });
  }
  return out;
}

/** Decode the binary element stream of one SFC chart section. */
function parseSfcChart(data) {
  const marks = [];
  for (let i = 0; i + 4 <= data.length; i++) if (data.readUInt32LE(i) === SFC_MARKER) marks.push(i);
  const elements = [];
  for (const m of marks) {
    if (m + 0x1a > data.length) continue;
    const seq = data.readUInt16LE(m + 0x0e);
    const kind = data.readUInt16LE(m + 0x12);
    const nameChars = data.readUInt16LE(m + 0x16);
    let name = '';
    if (nameChars >= 1 && nameChars <= 1000 && m + 0x1a + nameChars * 2 <= data.length) {
      for (let i = 0; i < nameChars - 1; i++) {
        const ch = data.readUInt16LE(m + 0x1a + i * 2);
        if (ch === 0) break;
        name += String.fromCharCode(ch);
      }
    }
    const element = {
      sequence: seq,
      kind,
      kindName: SFC_KINDS[kind] || ('kind-' + kind),
      name,
      frameOffset: m,
    };
    const p = m + 0x1a + nameChars * 2;
    if (kind === 2 || kind === 6) {
      if (p + 12 <= data.length) {
        const actionCount = data.readUInt32LE(p + 4);
        const textChars = data.readUInt32LE(p + 8);
        if (textChars <= 100000 && p + 12 + textChars * 2 <= data.length) {
          let text = '';
          for (let i = 0; i < textChars; i++) text += String.fromCharCode(data.readUInt16LE(p + 12 + i * 2));
          element.actionCount = actionCount;
          element.actionText = text.replace(/\u0000/g, '').trim();
          element.actions = parseSfcActionText(element.actionText);
        }
      }
    } else if (kind === 8) {
      element.hasBody = false;
      element.sectionId = null;
      element.language = null;
      if (p + 12 <= data.length) {
        const hasBody = data.readUInt32LE(p);
        if (hasBody === 1) {
          element.hasBody = true;
          element.sectionId = data.readUInt32LE(p + 4);
          const langChars = data.readUInt32LE(p + 8);
          if (langChars <= 64 && p + 12 + langChars * 2 <= data.length) {
            let lang = '';
            for (let i = 0; i < langChars; i++) {
              const ch = data.readUInt16LE(p + 12 + i * 2);
              if (!ch) break;
              lang += String.fromCharCode(ch);
            }
            element.language = lang || null;
          }
        }
      }
    }
    elements.push(element);
  }
  return elements;
}

/**
 * The 22-byte trailer that closes every SFC element stream (verified on all four
 * shipped charts). It is not an element record — it is too short for one — but:
 *
 *   +0x00 u32 0x467312AA                same marker as an element record
 *   +0x04 u32 1                         format/version (as in elements)
 *   +0x08 u32 1
 *   +0x0C 6 bytes zero                   (3 × u16 0, where an element would hold
 *                                        seq/kind/name length)
 *   +0x12 u32 object id of the chart's **Steps folder** (type 0x21, child of the
 *            chart section: "Steps" / "Schritte")
 *
 * All four charts resolve that id to the Steps folder object, and the six zero
 * bytes hold in every chart; the trailing field is 4 bytes wide but its value is
 * below 65536 in every sample, so a wider id could not be ruled out.
 * @returns {{marker:number,versionA:number,versionB:number,stepsFolderId:number,bytes:number}|null}
 */
function parseSfcTrailer(data) {
  let last = -1;
  for (let i = 0; i + 4 <= data.length; i++) if (data.readUInt32LE(i) === SFC_MARKER) last = i;
  if (last < 0 || data.length - last !== 22) return null;
  return {
    marker: data.readUInt32LE(last),
    versionA: data.readUInt32LE(last + 4),
    versionB: data.readUInt32LE(last + 8),
    stepsFolderId: data.readUInt32LE(last + 18),
    bytes: 22,
  };
}

/**
 * Parse the chart's prefix link table. The chart stream starts with a 60-byte
 * header (15 u32 words; word 1 = transition/stream object id, word 4 = row
 * count) followed by `rowCount` 20-byte rows (4 u32 link fields + one 4-byte
 * per-row token that is not topology). Row k belongs to element id k + 2.
 * Deleted slots are four 0xFFFFFFFF fields and are skipped.
 * @returns {Map<number,{prev:number,next:number,c:number,d:number}>}
 */
function parseSfcTable(data) {
  let prefix = 0;
  for (let i = 0; i + 4 <= data.length; i++) if (data.readUInt32LE(i) === SFC_MARKER) { prefix = i; break; }
  const rows = new Map();
  if (!prefix) return rows;
  const rowCount = data.readUInt32LE(16);
  for (let k = 0; k < rowCount && rowCount <= 100000; k++) {
    const base = SFC_TABLE_PREFIX + k * 20;
    if (base + 16 > prefix) break;
    const f = [0, 1, 2, 3].map((j) => data.readUInt32LE(base + j * 4));
    if (f.every((v) => v === 0xffffffff)) continue;
    rows.set(k + SFC_TABLE_BASE, {
      prev: f[0] > 0 && f[0] < 0x7fffffff ? f[0] : 0,
      next: f[1] > 0 && f[1] < 0x7fffffff ? f[1] : 0,
      c: f[2] > 0 && f[2] < 0x7fffffff ? f[2] : 0,
      d: f[3] > 0 && f[3] < 0x7fffffff ? f[3] : 0,
    });
  }
  return rows;
}

/**
 * Resolve the SFC flow (FROM/TO) from the link table. The table stores raw
 * links between chart elements, including the four branch pseudo-elements:
 *   11 divergence  row = (prev, -, first entry, -)
 *   13 branch-start row = (-, next, next sibling, previous sibling or bar)
 *   14 branch-end   row = (prev, -, previous in end list, next in end list)
 *   12 convergence row = (-, next, -, first end)
 * `back()` walks a raw `prev` link backwards through pseudo-elements until it
 * reaches real steps; `fwd()` walks `next` forwards the same way. Each returns
 * the list of element ids the SFC flow reaches (a branch yields several).
 * @returns {(id:number)=>number[]} pair of resolvers
 */
function sfcWiringResolvers(elements, rows) {
  const kindOf = new Map(elements.map((e) => [e.sequence, e.kind]));
  const kind = (id) => kindOf.get(id);
  const row = (id) => rows.get(id);
  const chain = (start, key) => {
    const out = [];
    const seen = new Set();
    for (let id = start; id && row(id) && !seen.has(id); id = row(id)[key]) {
      seen.add(id);
      out.push(id);
    }
    return out;
  };
  const entries = (bar) => chain(row(bar).c, 'c');
  const ends = (bar) => chain(row(bar).d, 'd');
  const walk = (start, key, targetKind) => {
    const seen = new Set();
    for (let id = start; id && row(id) && !seen.has(id); id = row(id)[key]) {
      seen.add(id);
      if (kind(id) === targetKind) return id;
    }
    return 0;
  };
  const back = (id, depth = 0) => {
    if (!id || depth > 32 || !row(id)) return [];
    const k = kind(id);
    if (k === 3) return []; // chart start marker / final step: no predecessor
    if (k === 13) return back(row(walk(id, 'd', 11)).prev, depth + 1); // branch entry -> divergence bar
    if (k === 12) return ends(id).flatMap((end) => back(row(end).prev, depth + 1));
    if (k === 11) return back(row(id).prev, depth + 1);
    if (k === 14) return back(row(walk(id, 'c', 12)).next, depth + 1); // branch end -> convergence bar
    return [id];
  };
  const fwd = (id, depth = 0) => {
    if (!id || depth > 32 || !row(id)) return [];
    const k = kind(id);
    if (k === 11) return entries(id).flatMap((entry) => fwd(row(entry).next, depth + 1));
    if (k === 13) return fwd(row(id).next, depth + 1);
    if (k === 14) return fwd(row(walk(id, 'c', 12)).next, depth + 1);
    if (k === 12) return fwd(row(id).next, depth + 1);
    return [id];
  };
  return { back, fwd, entries, ends };
}

/**
 * Reconstructed text of a section (action / transition / POU body): all text
 * content frames owned by the section object or its children, in file order.
 * @returns {string|null}
 */
function sectionSource(project, contents, section) {
  const chunks = [];
  const gather = (object) => {
    for (const c of contentsOf(contents, object.id)) if (c.text) chunks.push(c);
  };
  gather(section);
  for (const child of section.children || []) gather(child);
  chunks.sort((a, b) => a.frameOffset - b.frameOffset);
  return chunks.length ? chunks.map((c) => c.text).join('') : null;
}

/** Language of one section, derived from the body text marker. */
function sectionLanguage(text) {
  if (!text) return null;
  const m = /NETWORK_LIST_TYPE\s*:=\s*NWTYPE([A-Z]+)/.exec(text);
  return m ? m[1] : null;
}

/**
 * Decoded SFC charts: every POU that owns an SFC chart section (type 0x08).
 * Element bodies (transition LD/IL/FBD text, action text) are attached when the
 * referenced transition/action object exists; an action name that resolves to a
 * global variable (e.g. green_light) has no object body.
 * @returns {Array<{pou, section, elements, counts}>}
 */
function sfcCharts(project, contents) {
  const byId = new Map(project.objects.map((o) => [o.id, o]));
  const charts = [];
  for (const pou of pous(project)) {
    const chartSection = (pou.children || []).find((c) => c.type === 0x08);
    if (!chartSection) continue;
    const chartChunk = contentsOf(contents, chartSection.id)
      .filter((c) => c.kind === 6 && c.data.length >= 16)
      .find((c) => c.data.includes(Buffer.from([0xaa, 0x12, 0x73, 0x46])));
    const elements = chartChunk ? parseSfcChart(chartChunk.data) : [];
    const table = chartChunk ? parseSfcTable(chartChunk.data) : new Map();
    const trailer = chartChunk ? parseSfcTrailer(chartChunk.data) : null;
    const stepsFolder = (chartSection.children || []).find((c) => c.type === 0x21) || null;
    const { back, fwd, entries, ends } = sfcWiringResolvers(elements, table);
    const nameOf = new Map(elements.map((e) => [e.sequence, e.name]));
    const actionsFolder = (chartSection.children || []).find((c) => c.type === 0x09);
    const actionByName = new Map(((actionsFolder && actionsFolder.children) || []).map((o) => [o.name, o]));
    for (const element of elements) {
      const link = table.get(element.sequence);
      element.prevId = link ? link.prev || null : null;
      element.nextId = link ? link.next || null : null;
      element.wiring = {
        in: link ? back(link.prev) : [],
        out: link ? fwd(link.next) : [],
      };
      if (element.kind === 8) {
        element.fromIds = element.wiring.in;
        element.toIds = element.wiring.out;
        element.from = element.wiring.in.map((id) => nameOf.get(id) || '');
        element.to = element.wiring.out.map((id) => nameOf.get(id) || '');
      }
      if (element.kind === 11) element.entries = entries(element.sequence);
      if (element.kind === 12) element.ends = ends(element.sequence);
      if (element.kind === 8 && element.sectionId !== null) {
        const section = byId.get(element.sectionId) || null;
        element.sectionName = section ? section.name : null;
        element.body = section ? sectionSource(project, contents, section) : null;
        if (!element.language) element.language = sectionLanguage(element.body);
      }
      for (const action of element.actions || []) {
        const section = actionByName.get(action.name) || null;
        action.sectionName = section ? section.name : null;
        action.body = section ? sectionSource(project, contents, section) : null;
      }
    }
    const transitions = elements.filter((e) => e.kind === 8);
    charts.push({
      pou: pou.name,
      section: chartSection.name,
      frameOffset: chartChunk ? chartChunk.frameOffset : null,
      elements,
      trailer,
      stepsFolder: stepsFolder ? stepsFolder.name : null,
      stepsFolderId: stepsFolder ? stepsFolder.id : null,
      trailerVerified: trailer && stepsFolder ? trailer.stepsFolderId === stepsFolder.id : null,
      counts: {
        steps: elements.filter((e) => e.kind === 6 || e.kind === 2).length,
        initialSteps: elements.filter((e) => e.kind === 2).length,
        transitions: elements.filter((e) => e.kind === 8).length,
        finalSteps: elements.filter((e) => e.kind === 3).length,
        branchElements: elements.filter((e) => [1, 11, 12, 13, 14].includes(e.kind)).length,
        wiredTransitions: transitions.filter((t) => t.from.length && t.to.length).length,
        wiringLinks: elements.reduce((n, e) => n + e.wiring.out.length, 0),
      },
    });
  }
  return charts;
}

/**
 * Configured tasks with their SINGLE / INTERVAL / PRIORITY settings and the
 * PROGRAMS assigned to them.
 *
 * `programIds` are binding-record ids. An id whose binding record is gone from the
 * container is reported in `danglingIds`; an id whose record still exists but carries
 * an empty name (FPWIN zeroes the payload when an assignment is cleared, e.g. 2303 /
 * 2304 in the 7.7 sample) is reported in `emptyIds` and its `assignments[]` name is null.
 * @returns {Array<{group,name,single,interval,priority,programs:string[],programIds:number[],
 *   assignments:Array<{recordId:number,name:string|null,frameOffset:number|null}>,
 *   danglingIds:number[],emptyIds:number[],id:number,frameOffset:number|null}>}
 */
function tasks(project, contents) {
  const rows = [];
  for (const group of taskGroups(project)) {
    for (const child of group.children || []) {
      const chunk = contentsOf(contents, child.id).find((c) => !c.text && c.kind === 6);
      const record = chunk ? parseTaskRecord(chunk.data) : { strings: [], programIds: [] };
      const strings = record.strings;
      const assignments = taskAssignments(project, contents, child);
      const assignedIds = new Set(assignments.map((a) => a.recordId));
      const bindingIds = new Set(
        contentsOf(contents, child.id)
          .filter((c) => c.kind === 4 && c.recordId !== null)
          .map((c) => c.recordId)
      );
      rows.push({
        group: group.name,
        name: child.name,
        single: strings[0] || null,
        interval: strings[1] || null,
        priority: strings[2] || null,
        programs: assignments.map((a) => a.name),
        programIds: record.programIds,
        // programIds are binding-record ids: join them to the names where the record
        // still exists, and report ids whose record is gone (deleted assignments).
        assignments: record.programIds.map((id) => {
          const hit = assignments.find((a) => a.recordId === id);
          return { recordId: id, name: hit ? hit.name : null, frameOffset: hit ? hit.frameOffset : null };
        }),
        danglingIds: record.programIds.filter((id) => !bindingIds.has(id)),
        emptyIds: record.programIds.filter((id) => bindingIds.has(id) && !assignedIds.has(id)),
        id: child.id,
        frameOffset: chunk ? chunk.frameOffset : null,
      });
    }
  }
  return rows;
}

/**
 * POU implementation language.
 *
 * Two independent signals, both validated against the .asc exports of the 27
 * shipped samples:
 *   - the body section type code: 0x05 = IL, 0x06 = LD, 0x07 = FBD;
 *   - the body text marker: NETWORK_LIST_TYPE := NWTYPELD / NWTYPEFBD / NWTYPEIL.
 * SFC programs have no text body (their chart is a binary graph) but carry
 * transition/action child objects that do have text bodies.
 */
const SECTION_LANGUAGE = { 0x05: 'IL', 0x06: 'LD', 0x07: 'FBD', 0x08: 'SFC' };

function pouLanguage(project, contents, pou) {
  const src = pouSource(project, contents, pou);
  const marker = src.text ? (/NETWORK_LIST_TYPE\s*:=\s*NWTYPE([A-Z]+)/.exec(src.text) || [])[1] : null;
  let language = null;
  let evidence = 'none';
  if (marker) { language = marker; evidence = 'body-marker'; }
  const sectionType = src.section ? src.section.type : null;
  if (!language && sectionType !== null && SECTION_LANGUAGE[sectionType]) {
    language = SECTION_LANGUAGE[sectionType];
    evidence = 'section-type';
  }
  return { language, evidence, sectionType, sectionName: src.section ? src.section.name : null };
}

/**
 * Body/source text of a POU.
 * "Rumpf"/0x06 for LD, "Rumpf"/0x07 for FBD, "Body"/0x06 for SFC actions …), so
 * the section is found by content: the chunk whose decompressed text starts with
 * "BODY". SFC chart bodies themselves are stored as binary graphs and have no
 * text chunk.
 */
function pouSource(project, contents, pou) {
  const childIds = new Set((pou.children || []).map((c) => c.id));
  childIds.add(pou.id);
  const chunkSets = (pou.children || []).map((c) => ({ section: c, chunks: contentsOf(contents, c.id) }));
  const textChunks = [];
  for (const set of chunkSets) {
    for (const c of set.chunks) {
      if (c.text && /^\s*BODY\b/.test(c.text)) textChunks.push({ section: set.section, chunk: c });
    }
  }
  if (!textChunks.length) {
    // fall back to any text chunk of a child section
    for (const set of chunkSets) {
      for (const c of set.chunks) if (c.text) textChunks.push({ section: set.section, chunk: c });
    }
  }
  if (!textChunks.length) {
    // SFC chart body: binary graph, no text. Expose the section so the language
    // can still be derived from its type code (0x08 = SFC).
    const binSection = (pou.children || []).find((c) => c.type === 0x08);
    return { section: binSection || null, text: null, language: binSection ? 'SFC' : null, chunks: [] };
  }
  textChunks.sort((a, b) => a.chunk.frameOffset - b.chunk.frameOffset);
  const text = textChunks.map((t) => t.chunk.text).join('');
  // section type code is the primary language signal (0x05 IL / 0x06 LD / 0x07 FBD)
  const sectionLang = SECTION_LANGUAGE[textChunks[0].section.type] || null;
  return {
    section: textChunks[0].section,
    text,
    language: sectionLang,
    chunks: textChunks.map((t) => t.chunk),
  };
}

// ---------------------------------------------------------------------------
// Table catalogue: every container carries exactly ten 401-byte FA FA records, one
// "<TABLE>.dat" and one "<TABLE>.idx" per SC table (SCOBJ/SCDECL/SCCONT/SCCOM/SCCRL),
// plus two len=50 "SC!VERS" records and six len=31 page entries. The layout is fixed
// regardless of project size (verified 64 KiB … 3.1 MiB):
//
//   +0x00  u16 0xFAFA
//   +0x02  u16 frame length (401)
//   +0x04  u16 0
//   +0x06  u32 frame length - 18
//   +0x0A  u32 0
//   +0x0E  u32 0
//   +0x12  ASCII name, space padded to 0xFF bytes ("SCOBJ_TAB.dat")
//   +0x111 128-byte table descriptor:
//          +0x00 u32 format marker (0xFFFFFFFF for 6.00 files, 0x07ED for 7.5+/7.7)
//          +0x04 u32 0
//          +0x08 u32 same as +0x00
//          +0x0C u32 offset of the table's page frame (a len=31 page entry for
//                   ".dat", the reserved len=2048 page for ".idx")
//          +0x10 u32 append offset: end of this table's last record in the stream
//          +0x14 u32 id counter: for ".dat" the highest allocated id (= max object id,
//                   +1 where an id was freed); 0 when the table was never written
//          +0x18 u32 last written record id (0 when empty)
//          +0x1C u32 table code (0x15812 / 0xC812 / …; layout depends on the version)
//          +0x70 u32 last-save time, equal to the root object's mtime
//
// The .idx page is *always* the reserved (0xFF) page: across 42 containers no index
// page carries data, i.e. FPWIN writes only the .dat side and rebuilds indexes on load.
// ---------------------------------------------------------------------------

const TABLE_DESC = 0x80;
const TABLE_DESC_AT = 0x111;

/**
 * SC table records of a container (name, page link, append offset, id counter, mtime).
 * @returns {Array<{name:string,table:string,kind:string,frameOffset:number,length:number,
 *   pageOffset:number,pageKind:string|null,appendOffset:number,lastId:number,
 *   mtime:number, mtimeIso:string|null}>}
 */
function tables(buf, project) {
  const pages = new Map();
  for (const r of project.records) if (r.tag === 'page') pages.set(r.offset, r);
  const out = [];
  for (const r of project.records) {
    if (r.tag !== 'block' || r.kind === 'object') continue;
    if (r.length < TABLE_DESC_AT + TABLE_DESC) continue;
    if (u32(buf, r.offset + 6) !== r.length - 18) continue;
    const d = r.offset + r.length - TABLE_DESC;
    const formatVersion = u32(buf, d);
    if (u32(buf, d + 4) !== 0) continue;
    if (formatVersion !== u32(buf, d + 8)) continue;
    if (formatVersion !== 0xffffffff && formatVersion !== 0x7ed) continue;
    let name = '';
    for (let i = 0; i < 0xff; i++) {
      const c = buf[r.offset + 0x12 + i];
      if (c === 0x20 || c === 0) break;
      if (c < 0x20 || c > 0x7e) { name = ''; break; }
      name += String.fromCharCode(c);
    }
    if (!/^[A-Z_]+\.(dat|idx)$/.test(name)) continue;
    const pageOffset = u32(buf, d + 0x0c);
    const pg = pages.get(pageOffset);
    let pageKind = null;
    if (pg) {
      if (pg.length === 31) pageKind = 'entry';
      else if (pg.length === 2048) pageKind = buf.slice(pg.offset + 0x1e, pg.offset + 0x24).toString('latin1') === 'FC!DEF' ? 'data' : 'reserved';
      else pageKind = 'len' + pg.length;
    }
    const mtime = u32(buf, d + 0x70);
    out.push({
      name,
      table: name.replace(/\.(dat|idx)$/, ''),
      kind: name.slice(-3),
      frameOffset: r.offset,
      length: r.length,
      formatVersion,
      pageOffset,
      pageKind,
      appendOffset: u32(buf, d + 0x10),
      counter: u32(buf, d + 0x14),
      seq: u32(buf, d + 0x18),
      tableCode: u32(buf, d + 0x1c),
      mtime,
      mtimeIso: mtime ? new Date(mtime * 1000).toISOString() : null,
    });
  }
  return out;
}

module.exports = {
  parseProject, walk, byType, pous, findByName,
  extractContents, contentsOf, pouSource, pouDeclarations, pouLanguage,
  duts, dutDeclarations, globalVarObjects, globalVariables, parseVariableRecord,
  taskGroups, tasks, taskAssignments, parseTaskRecord, readAssignmentName, readStringSequence,
  sfcCharts, parseSfcChart, parseSfcTable, parseSfcTrailer, sfcWiringResolvers, parseSfcActionText,
  sectionSource, sectionLanguage,
  tables,
  TYPE_NAMES, HEADER_LEN,
};
