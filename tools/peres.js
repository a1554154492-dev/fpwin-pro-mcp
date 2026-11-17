// Minimal PE resource walker: list resource types, decode RT_MENU (classic) and RT_MENUEX.
// Usage: node peres.js <pe> [--types] [--menus] [--filter <substr>]
const fs = require('fs');

function parsePE(buf) {
  if (buf.readUInt16LE(0) !== 0x5a4d) throw new Error('not MZ');
  const e_lfanew = buf.readUInt32LE(0x3c);
  if (buf.readUInt32LE(e_lfanew) !== 0x4550) throw new Error('not PE');
  const coff = e_lfanew + 4;
  const numSections = buf.readUInt16LE(coff + 2);
  const optSize = buf.readUInt16LE(coff + 16);
  const opt = coff + 20;
  const magic = buf.readUInt16LE(opt);
  const ddOff = opt + (magic === 0x20b ? 112 : 96);
  const resRva = buf.readUInt32LE(ddOff + 2 * 8);
  const resSize = buf.readUInt32LE(ddOff + 2 * 8 + 4);
  const sections = [];
  const secOff = opt + optSize;
  for (let i = 0; i < numSections; i++) {
    const s = secOff + i * 40;
    sections.push({
      va: buf.readUInt32LE(s + 12),
      vsize: buf.readUInt32LE(s + 8),
      raw: buf.readUInt32LE(s + 20),
      rawSize: buf.readUInt32LE(s + 16),
    });
  }
  return { buf, sections, resRva, resSize };
}

function rvaToOff(pe, rva) {
  for (const s of pe.sections) {
    if (rva >= s.va && rva < s.va + Math.max(s.vsize, s.rawSize)) return rva - s.va + s.raw;
  }
  return -1;
}

function readName(pe, pos) {
  const buf = pe.buf;
  const len = buf.readUInt16LE(pos);
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(buf.readUInt16LE(pos + 2 + i * 2));
  return s;
}

// walk resource tree -> [{type, name, lang, dataOff, size}]
function walk(pe) {
  const buf = pe.buf;
  const base = rvaToOff(pe, pe.resRva);
  if (base < 0 || !pe.resSize) return [];
  const out = [];
  function dir(off, level, type, name) {
    const nNamed = buf.readUInt16LE(off + 12);
    const nId = buf.readUInt16LE(off + 14);
    const total = nNamed + nId;
    for (let i = 0; i < total; i++) {
      const e = off + 16 + i * 8;
      let idOrName = buf.readUInt32LE(e);
      const offField = buf.readUInt32LE(e + 4);
      let key;
      if (idOrName & 0x80000000) {
        key = readName(pe, base + (idOrName & 0x7fffffff));
      } else {
        key = idOrName;
      }
      const isSub = (offField & 0x80000000) !== 0;
      const childOff = base + (offField & 0x7fffffff);
      if (level === 0) {
        if (isSub) dir(childOff, 1, key, null);
      } else if (level === 1) {
        if (isSub) dir(childOff, 2, type, key);
      } else if (isSub) {
        dir(childOff, 3, type, name);
      } else {
        const de = childOff;
        out.push({
          type,
          name,
          lang: key,
          dataRva: buf.readUInt32LE(de),
          size: buf.readUInt32LE(de + 4),
        });
      }
    }
  }
  dir(base, 0, null, null);
  return out;
}

const RT = { 1: 'CURSOR', 2: 'BITMAP', 3: 'ICON', 4: 'MENU', 5: 'DIALOG', 6: 'STRING', 7: 'FONTDIR', 8: 'FONT', 9: 'ACCELERATOR', 10: 'RCDATA', 11: 'MESSAGETABLE', 12: 'GROUP_CURSOR', 14: 'GROUP_ICON', 16: 'VERSION', 17: 'DLGINCLUDE', 19: 'PLUGPLAY', 20: 'VXD', 21: 'ANICURSOR', 22: 'ANIICON', 23: 'HTML', 24: 'MANIFEST' };

function decodeClassicMenu(pe, dataOff, size) {
  const buf = pe.buf;
  const end = dataOff + size;
  const items = [];
  let p = dataOff;
  const ver = buf.readUInt16LE(p);
  const hdr = buf.readUInt16LE(p + 2);
  p += 4 + hdr;
  let depth = 0;
  const stack = [];
  while (p + 4 <= end) {
    const flags = buf.readUInt16LE(p);
    const id = buf.readUInt16LE(p + 2);
    p += 4;
    // read WCHAR string
    let s = '';
    while (p + 2 <= end) {
      const ch = buf.readUInt16LE(p);
      p += 2;
      if (ch === 0) break;
      s += String.fromCharCode(ch);
    }
    if (flags === 0 && s === '' && id === 0) {
      if (depth > 0) {
        depth--;
        continue;
      }
      break;
    }
    if (id === 0xffff) continue;
    items.push({ depth, flags, id, text: s.replace(/&/g, '') });
    if (flags & 0x10) depth++; // MF_POPUP
  }
  return items;
}

function decodeMenuEx(pe, dataOff, size) {
  const buf = pe.buf;
  const end = dataOff + size;
  const items = [];
  let p = dataOff;
  const ver = buf.readUInt16LE(p);
  const hdr = buf.readUInt16LE(p + 2);
  p += 4 + hdr + 4; // + dwHelpId
  let depth = 0;
  while (p + 14 <= end) {
    const dwType = buf.readUInt32LE(p);
    const dwState = buf.readUInt32LE(p + 4);
    const menuId = buf.readUInt32LE(p + 8);
    const wResInfo = buf.readUInt16LE(p + 12);
    p += 14;
    let s = '';
    while (p + 2 <= end) {
      const ch = buf.readUInt16LE(p);
      p += 2;
      if (ch === 0) break;
      s += String.fromCharCode(ch);
    }
    p = (p + 3) & ~3;
    if (wResInfo !== 0) continue;
    items.push({ depth, flags: dwType, id: menuId, text: s.replace(/&/g, '') });
    if (dwType & 0x10) depth++;
  }
  return items;
}

const file = process.argv[2];
const doTypes = process.argv.includes('--types');
const doMenus = process.argv.includes('--menus');
const filterIdx = process.argv.indexOf('--filter');
const filter = filterIdx > 0 ? process.argv[filterIdx + 1] : null;

const buf = fs.readFileSync(file);
const pe = parsePE(buf);
const res = walk(pe);
if (doTypes) {
  const counts = {};
  for (const r of res) {
    const t = typeof r.type === 'number' ? (RT[r.type] || `#${r.type}`) : r.type;
    counts[t] = (counts[t] || 0) + 1;
  }
  console.log(JSON.stringify({ file, resourceEntries: res.length, types: counts }, null, 1));
  process.exit(0);
}
if (doMenus) {
  const menus = res.filter((r) => r.type === 4 || r.type === 'MENU');
  console.log(`MENU resources: ${menus.length}`);
  for (const m of menus) {
    const off = rvaToOff(pe, m.dataRva);
    if (off < 0) continue;
    const ver = buf.readUInt16LE(off);
    let items;
    try {
      items = ver === 1 ? decodeMenuEx(pe, off, m.size) : decodeClassicMenu(pe, off, m.size);
    } catch (e) {
      console.log(`  name=${m.name} DECODE-ERROR ${e.message}`);
      continue;
    }
    const interesting = filter ? items.filter((i) => i.text.includes(filter)) : items;
    if (filter && !interesting.length) continue;
    console.log(`  --- menu ${m.name} (${items.length} items, ver=${ver}) ---`);
    for (const i of interesting) console.log(`    ${'  '.repeat(i.depth)}${i.id}\t${i.text}`);
  }
  process.exit(0);
}
