#!/usr/bin/env node
/**
 * FPWIN Pro MCP server (Panasonic Control FPWIN Pro 7 / CoDeSys 2.3 lineage).
 *
 * Derived by REA-assisted reverse engineering of the local installation:
 *  - D:\FP7752\Mak\fpwinpro.exe is a 32-bit MFC bootstrap that hands control to sc_app.dll
 *    (CSCApp). There is no registered COM automation server.
 *  - sc_app.dll exposes CCommandLine / CBatchMode / CVersionControl; switch literals found in
 *    the image: checkonly, nologo, autorecover, create_snapshot_from_file_project,
 *    create_snapshot_from_plc_project, and the CCommandLine flags IsBatchMode /
 *    IsCommandLineFile / ShallBeInvisibleAndTerminateAfterSnapshotCreation.
 *  - Verified behaviour of this build:
 *      fpwinpro.exe <project.pro>                          -> GUI opens project
 *      fpwinpro.exe create_snapshot_from_file_project <p>   -> converts/writes <p>.pro, <p>.log, <p>.ini
 *      fpwinpro.exe /batch "<commands>"                     -> batch command parser (errors surface as dialogs)
 *  - Project interchange formats: .asc (CoDeSys ASCII export, BEGIN_OBJECT ... END_OBJECT),
 *    .pro (block container with SCOBJ_TAB / SCCONT_TAB / SCDECL_TAB / SCCOM_TAB / SCCRL_TAB tables).
 *
 * Transport: MCP stdio (newline-delimited JSON-RPC 2.0). No third-party dependencies.
 */
'use strict';

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  parseProject, walk, pous, extractContents, pouSource, pouDeclarations, pouLanguage,
  duts, dutDeclarations, globalVariables, tasks, sfcCharts,
} = require('./lib/proparse');

const SERVER_NAME = 'fpwin-pro-mcp';
const SERVER_VERSION = '0.1.0';

// ---------------------------------------------------------------------------
// Installation discovery
// ---------------------------------------------------------------------------

const INSTALL_CANDIDATES = [
  'D:\\FP7752',
  'C:\\Program Files (x86)\\Panasonic-ID SUNX Control\\FPWIN Pro 7',
  'C:\\Program Files\\Panasonic-ID SUNX Control\\FPWIN Pro 7',
];

function readRegistry(value) {
  const r = spawnSync('reg', ['query', value, '/s'], { encoding: 'latin1', windowsHide: true });
  return r.status === 0 ? r.stdout : '';
}

function findInstall() {
  const explicit = process.env.FPWIN_ROOT;
  const roots = explicit ? [explicit, ...INSTALL_CANDIDATES] : INSTALL_CANDIDATES;
  for (const root of roots) {
    const exe = path.join(root, 'Mak', 'fpwinpro.exe');
    if (fs.existsSync(exe)) return { root, exe, makDir: path.join(root, 'Mak') };
  }
  // Registry fallback: install dir recorded by the installer.
  const reg = readRegistry('HKLM\\SOFTWARE\\WOW6432Node\\Panasonic-ID SUNX Control\\Control FPWIN Pro 7');
  const m = reg.match(/InstallLocation\s+REG_SZ\s+(.+)/i);
  if (m) {
    const root = m[1].trim().replace(/\\+$/, '');
    const exe = path.join(root, 'Mak', 'fpwinpro.exe');
    if (fs.existsSync(exe)) return { root, exe, makDir: path.join(root, 'Mak') };
  }
  return null;
}

function peSummary(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(0x400);
    fs.readSync(fd, head, 0, head.length, 0);
    fs.closeSync(fd);
    if (head.readUInt16LE(0) !== 0x5a4d) return null;
    const peOff = head.readUInt32LE(0x3c);
    if (head.readUInt32LE(peOff) !== 0x4550) return null;
    const machine = head.readUInt16LE(peOff + 4);
    const optMagic = head.readUInt16LE(peOff + 24);
    return {
      machine: '0x' + machine.toString(16).padStart(4, '0'),
      bits: optMagic === 0x20b ? 64 : 32,
      format: optMagic === 0x20b ? 'pe32+' : 'pe32',
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// PowerShell helpers (Win32 window / 32-bit loader probes)
// ---------------------------------------------------------------------------

const HERE = __dirname;
const SYSWOW64_PS = 'C:\\Windows\\SysWOW64\\WindowsPowerShell\\v1.0\\powershell.exe';
const NATIVE_PS = process.env.SystemRoot
  ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : 'powershell.exe';

function runPowerShell(script, args, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const exe = script === 'syswow64' ? SYSWOW64_PS : NATIVE_PS;
    const child = spawn(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ...args],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    child.on('error', (e) => { err += 'SPAWN ' + e.message; });
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (process.env.FPWIN_MCP_DEBUG) {
        console.error(`[ps] ${path.basename(args[0] || '')} ${args.slice(1).join(' ')} -> code=${code} out=${out.length}B err=${err.slice(0, 300)}`);
      }
      resolve({ code, stdout: out.trim(), stderr: err.trim() });
    });
  });
}

function listWindows(pid) {
  return runPowerShell('native', [path.join(HERE, 'winui.ps1'), '-Mode', 'list', '-TargetPid', String(pid)]);
}

function clickDialogButton(pid, buttonText) {
  return runPowerShell('native', [path.join(HERE, 'winui.ps1'), '-Mode', 'click', '-TargetPid', String(pid), '-Button', buttonText]);
}

function probe32Dll(dllPath) {
  return runPowerShell('syswow64', [path.join(HERE, 'probe32.ps1'), '-DllPath', dllPath], 20000);
}

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function launch(exe, args, cwd) {
  return spawn(exe, args, { cwd, windowsHide: false, detached: false, stdio: 'ignore' });
}

function killTree(child) {
  try {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  } catch {}
}

function dirSnapshot(dir) {
  const map = new Map();
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return map; }
  for (const e of entries) {
    if (!e.isFile()) continue;
    const p = path.join(dir, e.name);
    try {
      const st = fs.statSync(p);
      map.set(e.name, { size: st.size, mtimeMs: st.mtimeMs });
    } catch {}
  }
  return map;
}

function dirDelta(before, after) {
  const added = [];
  const changed = [];
  for (const [name, cur] of after) {
    const prev = before.get(name);
    if (!prev) added.push({ name, size: cur.size });
    else if (prev.size !== cur.size || prev.mtimeMs !== cur.mtimeMs) changed.push({ name, size: cur.size });
  }
  return { added, changed };
}

function parseDialogText(stdout) {
  // winui.ps1 prints lines: WIN|<class>|<visible>|<text> — three delimiters; <text> may contain '|'.
  const windows = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith('WIN|')) continue;
    const p1 = line.indexOf('|', 4);
    if (p1 < 0) continue;
    const p2 = line.indexOf('|', p1 + 1);
    if (p2 < 0) continue;
    windows.push({
      cls: line.slice(4, p1),
      visible: line.slice(p1 + 1, p2) === '1',
      text: line.slice(p2 + 1),
    });
  }
  const dialogs = windows.filter((w) => w.cls === '#32770' || /错误|警告|Error|Warning/i.test(w.text));
  return { windows, dialogs };
}

// ---------------------------------------------------------------------------
// .asc (CoDeSys ASCII export) parser
// ---------------------------------------------------------------------------

const ASC_OBJECT_RE = /^BEGIN_OBJECT\s+(\S+)\s*$/;
const ASC_END_RE = /^END_OBJECT\s+(\S*)\s*$/;
const POU_LANGS = ['LD', 'FBD', 'IL', 'ST', 'SFC', 'CFC'];

function parseAsc(text) {
  const lines = text.split(/\r?\n/);
  const root = { type: 'ROOT', attrs: {}, children: [], startLine: 0 };
  const stack = [root];
  const objects = [];
  let current = root;
  let bodyLines = null; // array collecting raw body while inside a POU/DUT

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    const begin = line.match(ASC_OBJECT_RE);
    if (begin) {
      const node = { type: begin[1], attrs: {}, children: [], startLine: i + 1, body: [] };
      current.children.push(node);
      objects.push(node);
      stack.push(node);
      current = node;
      if (POU_LANGS.includes(begin[1]) || begin[1] === 'TYPE' || begin[1] === 'GLOBVAR') bodyLines = node.body;
      continue;
    }
    const end = line.match(ASC_END_RE);
    if (end) {
      if (stack.length > 1) {
        stack.pop();
        current = stack[stack.length - 1];
      }
      bodyLines = null;
      continue;
    }
    // key=value attributes directly under an object
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_ ]*)=(.*)$/);
    if (kv && !bodyLines) {
      const key = kv[1].trim();
      const val = kv[2];
      if (!(key in current.attrs)) current.attrs[key] = val;
      else if (Array.isArray(current.attrs[key])) current.attrs[key].push(val);
      else current.attrs[key] = [current.attrs[key], val];
      continue;
    }
    if (bodyLines && line.length) bodyLines.push(raw);
  }
  return { root, objects };
}

function classifyAsc(objects) {
  const out = { project: {}, plcs: [], programs: [], functionBlocks: [], functions: [], types: [], globals: [], tasks: [], other: {} };
  for (const o of objects) {
    if (o.type === 'PROJECT' && !out.project.name) {
      out.project.name = o.attrs.Name || '';
      out.project.release = o.attrs.Release || '';
      out.project.version = o.attrs.Version || '';
      out.project.date = o.attrs.Date || '';
    }
    if (o.type === 'EM_PLCTYPE') out.plcs.push({ name: o.attrs.Name || '(plc type)', plcType: o.attrs.PlcType || '' });
    if (o.type === 'PROGRAM') out.programs.push(describePou(o, 'PROGRAM'));
    if (o.type === 'FUNCTION_BLOCK') out.functionBlocks.push(describePou(o, 'FUNCTION_BLOCK'));
    if (o.type === 'FUNCTION') out.functions.push(describePou(o, 'FUNCTION'));
    if (o.type === 'TYPE') out.types.push(describeType(o));
    if (o.type === 'GLOBVAR' || o.type === 'GLOBAL_VAR') out.globals.push({ name: o.attrs.Name || '', lines: o.body.length });
    if (o.type === 'TASK' || /TASK/.test(o.type)) out.tasks.push({ type: o.type, name: o.attrs.Name || '' });
    if (!['PROJECT', 'EM_PLCTYPE', 'PROGRAM', 'FUNCTION_BLOCK', 'FUNCTION', 'TYPE', 'GLOBVAR', 'GLOBAL_VAR'].includes(o.type) && !/TASK/.test(o.type)) {
      out.other[o.type] = (out.other[o.type] || 0) + 1;
    }
  }
  return out;
}

function describePou(o, kind) {
  const body = o.body.join('\n');
  const vars = { input: 0, output: 0, inout: 0, local: 0, temp: 0, global: 0 };
  const varRe = /^\s*VAR_(INPUT|OUTPUT|IN_OUT|TEMP|GLOBAL)\b/gim;
  let m;
  while ((m = varRe.exec(body))) {
    const key = m[1].toLowerCase().replace('in_out', 'inout').replace('global', 'global');
    if (key in vars) vars[key]++;
  }
  return {
    kind,
    name: o.attrs.Name || '',
    language: o.attrs.Language || o.attrs.Type || '',
    bodyLines: o.body.length,
    declarationBlocks: vars,
  };
}

function describeType(o) {
  const body = o.body.join('\n');
  const nameMatch = body.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/m);
  return {
    name: o.attrs.Name || (nameMatch ? nameMatch[1] : ''),
    isStruct: /STRUCT/.test(body),
    bodyLines: o.body.length,
  };
}

/** Extract IEC variable declarations (name : type [:= init];) from an .asc body. */
function extractVariables(text) {
  const lines = text.split(/\r?\n/);
  const decls = [];
  let section = null;
  for (const raw of lines) {
    const line = raw.trim();
    const sec = line.match(/^VAR_(INPUT|OUTPUT|IN_OUT|TEMP|GLOBAL)?\b/i);
    if (sec) { section = sec[1] ? sec[1].toUpperCase() : 'VAR'; continue; }
    if (/^END_VAR\b/i.test(line)) { section = null; continue; }
    if (!section) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*(?:AT\s+%[A-Za-z0-9.*]+)?\s*:\s*([^:=;]+?)\s*(?::=\s*([^;]+))?;/);
    if (m) decls.push({ section, name: m[1], type: m[2].trim(), init: m[3] ? m[3].trim() : undefined });
  }
  return decls;
}

/**
 * Second .asc dialect: plain IEC 61131-3 text as used by the shipped library files
 * (Library\MLIB.ASC, SLIB.ASC, ...): TYPE ... END_TYPE, FUNCTION_BLOCK ... END_FUNCTION_BLOCK.
 */
function parseIecText(text) {
  const lines = text.split(/\r?\n/);
  const objects = [];
  const openers = [
    { re: /^\s*FUNCTION_BLOCK\s+(?:EXTENDS\s+\S+\s+)?([A-Za-z_][A-Za-z0-9_]*)/i, kind: 'FUNCTION_BLOCK', close: /^\s*END_FUNCTION_BLOCK/i },
    { re: /^\s*FUNCTION\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*([A-Za-z_][A-Za-z0-9_.]*))?/i, kind: 'FUNCTION', close: /^\s*END_FUNCTION\b/i },
    { re: /^\s*PROGRAM\s+([A-Za-z_][A-Za-z0-9_]*)/i, kind: 'PROGRAM', close: /^\s*END_PROGRAM\b/i },
    { re: /^\s*TYPE\s*$/i, kind: 'TYPE', close: /^\s*END_TYPE\b/i },
    { re: /^\s*VAR_GLOBAL\b/i, kind: 'VAR_GLOBAL', close: /^\s*END_VAR\b/i },
  ];
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (current) {
      current.body.push(line);
      if (current.close.test(line)) {
        current.bodyLines = i + 1 - current.startLine;
        current.variables = extractVariables(current.body.join('\n'));
        delete current.body;
        delete current.close;
        objects.push(current);
        current = null;
      }
      continue;
    }
    for (const op of openers) {
      const m = line.match(op.re);
      if (!m) continue;
      let name = op.kind === 'TYPE' ? '' : m[1];
      current = { kind: op.kind, name, returnType: op.kind === 'FUNCTION' ? m[2] : undefined, startLine: i + 1, body: [], close: op.close };
      break;
    }
  }
  // TYPE blocks: the declared name is the first `identifier :` inside the block.
  for (const o of objects) {
    if (o.kind === 'TYPE' && !o.name) {
      const first = lines.slice(o.startLine, o.startLine + 6).join('\n').match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/m);
      o.name = first ? first[1] : '';
    }
  }
  return objects.map((o) => ({
    kind: o.kind,
    name: o.name,
    returnType: o.returnType,
    line: o.startLine,
    bodyLines: o.bodyLines,
    varCount: (o.variables || []).length,
    variables: (o.variables || []).slice(0, 200),
  }));
}

// ---------------------------------------------------------------------------
// .pro container inspector (heuristic, evidence-based)
// ---------------------------------------------------------------------------

const PRO_TABLES = ['SCOBJ_TAB', 'SCCONT_TAB', 'SCDECL_TAB', 'SCCOM_TAB', 'SCCRL_TAB', 'OBJ_TAB', 'DECL_TAB', 'NT_TAB', 'RL_TAB'];

function inspectPro(file) {
  const buf = fs.readFileSync(file);
  const tableOffsets = {};
  for (const t of PRO_TABLES) {
    const needle = Buffer.from(t, 'latin1');
    let i = buf.indexOf(needle);
    const hits = [];
    while (i >= 0 && hits.length < 32) { hits.push(i); i = buf.indexOf(needle, i + 1); }
    if (hits.length) tableOffsets[t] = hits;
  }
  const ascii = [];
  const seen = new Set();
  const re = /[\x20-\x7E]{6,}/g;
  const text = buf.toString('latin1');
  let m;
  while ((m = re.exec(text)) && ascii.length < 400) {
    const s = m[0];
    if (!seen.has(s)) { seen.add(s); ascii.push(s); }
  }
  const unicode = [];
  const wide = buf.toString('utf16le');
  const wre = /[\x20-\x7E]{6,}/g;
  const seenW = new Set();
  while ((m = wre.exec(wide)) && unicode.length < 200) {
    const s = m[0];
    if (!seenW.has(s)) { seenW.add(s); unicode.push(s); }
  }
  // Build path / version metadata is embedded verbatim by the container writer.
  const meta = ascii.filter((s) => /\.pro!|_Trunk_|Makdeb|Version|\\bin\\/i.test(s)).slice(0, 40);
  return {
    file,
    size: buf.length,
    sizeBlocks64k: +(buf.length / 65536).toFixed(3),
    headerHex: buf.subarray(0, 16).toString('hex'),
    isZip: buf.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04])) === 0,
    tables: tableOffsets,
    metadataStrings: meta,
    asciiStrings: ascii,
    unicodeStrings: unicode,
    note: 'Heuristic container scan: table name offsets and embedded strings only; record-level schema not decoded.',
  };
}

// ---------------------------------------------------------------------------
// Environment doctor
// ---------------------------------------------------------------------------

async function doctorInstall(install) {
  const checks = [];
  const add = (id, ok, detail, remediation) => checks.push({ id, ok, detail, remediation });

  add('install', !!install, install ? install.root : 'FPWIN Pro installation not found', 'Set FPWIN_ROOT to the installation directory (the one containing Mak\\fpwinpro.exe).');
  if (!install) return { checks };

  for (const sub of ['Mak', 'Library', 'DbCon.mak']) {
    const p = path.join(install.root, sub);
    add('layout:' + sub, fs.existsSync(p), p, 'Reinstall Control FPWIN Pro 7; the IDE resolves Library/ and DbCon.mak/ relative to the parent of Mak\\.');
  }

  const exe = peSummary(install.exe);
  add('exe:pe32', exe ? exe.bits === 32 : false, exe ? `${exe.format} ${exe.machine}` : 'unreadable', 'FPWIN Pro 7 is a 32-bit application; a 64-bit loader cannot host its DLLs.');

  // MEWNET online stack: delay-loaded by mew_lib.dll. A failed DllMain silently aborts the IDE
  // (observed as an unhandled 0xC06D007E delay-load exception plus a memory dump).
  const mewDirs = [
    install.makDir,
    'C:\\Program Files (x86)\\PxMEWNET',
    'C:\\Program Files\\PxMEWNET',
  ];
  const mewDll = mewDirs.map((d) => path.join(d, 'PxMewUserIF.dll')).find((p) => fs.existsSync(p));
  add('mewnet:PxMewUserIF.dll', !!mewDll, mewDll || 'PxMewUserIF.dll not found', 'Install the Panasonic PxMEWNET runtime or add its directory to PATH.');

  let probe = null;
  if (mewDll) {
    const r = await probe32Dll(mewDll);
    const code = r.stdout.match(/RESULT\|(\d+)/);
    const err = code ? Number(code[1]) : null;
    probe = { dll: mewDll, win32Error: err, raw: r.stdout || r.stderr };
    add('mewnet:init', err === 0,
      err === 0 ? 'LoadLibrary succeeded in a 32-bit host' : `LoadLibrary failed (Win32 error ${err}) — DllMain could not initialise`,
      err === 0
        ? null
        : 'The IDE raises 0xC06D007E (delay-load failure) and closes when this DLL cannot initialise. Start/reinstall the PxMEWNET runtime (or run as a user that can write its install folder).');
  }

  add('project:write', true, 'writability is checked per-project by the calling tool', null);
  return { checks, probe, allOk: checks.every((c) => c.ok) };
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

async function toolInfo() {
  const install = findInstall();
  if (!install) return { found: false, hint: 'Set FPWIN_ROOT to the Control FPWIN Pro 7 installation directory.' };
  const version = readRegistry('HKLM\\SOFTWARE\\WOW6432Node\\Panasonic-ID SUNX Control\\Control FPWIN Pro 7')
    .split(/\r?\n/).filter(Boolean).slice(0, 12);
  return {
    found: true,
    root: install.root,
    exe: install.exe,
    exePe: peSummary(install.exe),
    helperDlls: {
      sc_app: fs.existsSync(path.join(install.makDir, 'sc_app.dll')),
      on_serv: fs.existsSync(path.join(install.makDir, 'on_serv.dll')),
      fp2asc: fs.existsSync(path.join(install.makDir, 'fp2asc.dll')),
    },
    libraries: fs.existsSync(path.join(install.root, 'Library')),
    samples: fs.existsSync(path.join(install.root, 'Samples')),
    helpChm: fs.existsSync(path.join(install.makDir, 'Res_CN', 'FPWINPro.chm')),
    registryLines: version,
    cli: {
      verified: [
        '<exe> <project.pro>  (GUI open)',
        '<exe> create_snapshot_from_file_project <project.pro>  (convert / write .pro, .log, .ini)',
        '<exe> /batch "<commands>"  (batch command parser; syntax errors reported as dialogs)',
      ],
      switchLiteralsFoundInBinary: ['checkonly', 'nologo', 'autorecover', 'create_snapshot_from_file_project', 'create_snapshot_from_plc_project'],
    },
    formats: {
      '.pro': 'FPWIN Pro project container (SCOBJ_TAB/SCCONT_TAB/SCDECL_TAB/SCCOM_TAB/SCCRL_TAB block tables)',
      '.asc': 'CoDeSys ASCII export: BEGIN_OBJECT <TYPE> ... END_OBJECT, Name=/Release=/Version= attributes',
      '.pce/.pcd/.fpx': 'registered FPWIN Pro file types (packed export / PLC transfer)',
    },
  };
}

async function toolDoctor() {
  const install = findInstall();
  if (!install) return { found: false, hint: 'Set FPWIN_ROOT to the Control FPWIN Pro 7 installation directory.' };
  return { found: true, root: install.root, ...(await doctorInstall(install)) };
}

/** Decode a text file honouring a UTF-16LE / UTF-8 BOM; FPWIN Pro exports are mixed ANSI and UTF-16. */
function readTextAbsolut(abs) {
  const buf = fs.readFileSync(abs);
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return { encoding: 'utf16le', text: buf.toString('utf16le', 2) };
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return { encoding: 'utf8-bom', text: buf.toString('utf8', 3) };
  return { encoding: 'latin1', text: buf.toString('latin1') };
}

async function toolAscParse({ file, includeVariables = false, maxObjects = 2000 }) {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) throw new Error(`file not found: ${abs}`);
  const { encoding, text } = readTextAbsolut(abs);
  const hasObjectBlocks = /^BEGIN_OBJECT\s/m.test(text);
  const { objects } = hasObjectBlocks ? parseAsc(text) : { objects: [] };
  const summary = classifyAsc(objects);
  const iecObjects = parseIecText(text);
  const result = {
    file: abs,
    bytes: fs.statSync(abs).size,
    encoding,
    dialect: hasObjectBlocks ? (iecObjects.length ? 'mixed (project export + IEC text)' : 'project export (BEGIN_OBJECT)') : 'IEC text (library / POU source)',
    objectTypes: objects.reduce((acc, o) => { acc[o.type] = (acc[o.type] || 0) + 1; return acc; }, {}),
    project: summary.project,
    plcTypes: summary.plcs.slice(0, 32),
    programs: summary.programs,
    functionBlocks: summary.functionBlocks,
    functions: summary.functions,
    types: summary.types,
    globals: summary.globals,
    tasks: summary.tasks,
    iecObjectCounts: iecObjects.reduce((acc, o) => { acc[o.kind] = (acc[o.kind] || 0) + 1; return acc; }, {}),
    iecObjects: iecObjects.slice(0, maxObjects),
    countedTotals: {
      objects: objects.length,
      iecObjects: iecObjects.length,
      programs: summary.programs.length,
      functionBlocks: summary.functionBlocks.length,
      functions: summary.functions.length,
      types: summary.types.length,
    },
    otherObjectTypes: summary.other,
  };
  if (includeVariables) result.variables = extractVariables(text).slice(0, 5000);
  return truncateJson(result, maxObjects);
}

async function toolProInspect({ file, maxStrings = 150 }) {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) throw new Error(`file not found: ${abs}`);
  const info = inspectPro(abs);
  info.asciiStrings = info.asciiStrings.slice(0, maxStrings);
  info.unicodeStrings = info.unicodeStrings.slice(0, Math.min(maxStrings, 100));
  return info;
}

async function toolProParse({ file, tree = true, includeFolders = false, includeLanguage = true, includeSource = false, includeDeclarations = false, includeDuts = true, includeGlobalVariables = true, includeTasks = true, includeSfc = true, maxSourceChars = 4000, maxObjects = 2000 }) {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) throw new Error(`file not found: ${abs}`);
  const buf = fs.readFileSync(abs);
  const project = parseProject(buf, { file: abs });
  const contents = (includeLanguage || includeSource || includeDeclarations || includeDuts || includeGlobalVariables || includeTasks || includeSfc)
    ? extractContents(buf, project)
    : null;
  const sfc = contents ? sfcCharts(project, contents) : [];
  const rows = tree
    ? walk(project)
    : project.objects.map((o) => ({
      depth: 0, id: o.id, parent: o.parent, type: o.type, typeName: o.typeName, name: o.name, offset: o.offset,
    }));
  const filtered = includeFolders ? rows : rows.filter((r) => !r.typeName.startsWith('folder:'));
  const pouRows = pous(project).map((o) => ({
    name: o.name,
    type: o.type,
    typeName: o.typeName,
    language: contents ? (pouLanguage(project, contents, o).language || null) : null,
    id: o.id,
    parent: o.parent,
    offset: o.offset,
  }));
  const result = {
    file: abs,
    size: project.size,
    usedLength: project.usedLength,
    header: project.header,
    counts: {
      records: project.records.length,
      objects: project.objects.length,
      roots: project.roots.length,
      pous: pouRows.length,
      duts: duts(project).length,
      globalVariables: contents ? globalVariables(project, contents).variables.length : 0,
      tasks: contents ? tasks(project, contents).length : 0,
      sfcCharts: sfc.length,
      sfcElements: sfc.reduce((n, c) => n + c.elements.length, 0),
      recoveredByScan: project.records.filter((r) => r.recoveredByScan).length,
    },
    pous: pouRows.slice(0, maxObjects),
    tree: filtered.slice(0, maxObjects).map((r) => '  '.repeat(r.depth) + r.name + ' [' + r.typeName + ']'),
    warnings: project.warnings,
  };
  if (includeDuts && contents) {
    result.duts = duts(project).slice(0, maxObjects).map((d) => ({
      name: d.name,
      id: d.id,
      typeName: d.typeName,
      fields: dutDeclarations(project, contents, d).fields.map((f) => ({
        name: f.name,
        type: f.typeName,
        initialValue: f.initialValue || null,
        comment: f.comment || null,
        typeRef: f.typeRef,
      })),
    }));
  }
  if (includeTasks && contents) {
    result.tasks = tasks(project, contents).slice(0, maxObjects).map((t) => ({
      name: t.name,
      single: t.single,
      interval: t.interval,
      priority: t.priority,
      programs: t.programs,
      programIds: t.programIds,
      id: t.id,
    }));
  }
  if (includeSfc) {
    result.sfc = sfc.slice(0, maxObjects).map((c) => ({
      pou: c.pou,
      section: c.section,
      counts: c.counts,
      elements: c.elements.map((e) => {
        const row = {
          sequence: e.sequence, kind: e.kind, kindName: e.kindName, name: e.name,
          prevId: e.prevId === undefined ? null : e.prevId,
          nextId: e.nextId === undefined ? null : e.nextId,
          wiring: e.wiring || { in: [], out: [] },
        };
        if (e.kind === 2 || e.kind === 6) {
          row.actionCount = e.actionCount;
          row.actionText = e.actionText || '';
          row.actions = (e.actions || []).map((a) => ({
            name: a.name,
            qualifier: a.qualifier || null,
            sectionName: a.sectionName || null,
            hasBody: !!a.body,
            bodyLength: a.body ? a.body.length : 0,
          }));
        } else if (e.kind === 8) {
          row.from = e.from || [];
          row.to = e.to || [];
          row.hasBody = !!e.hasBody;
          row.language = e.language || null;
          row.sectionName = e.sectionName || null;
          row.bodyLength = e.body ? e.body.length : 0;
        } else if (e.kind === 11) {
          row.entries = e.entries || [];
        } else if (e.kind === 12) {
          row.ends = e.ends || [];
        }
        return row;
      }),
    }));
  }
  if (includeGlobalVariables && contents) {
    const glob = globalVariables(project, contents);
    result.globalVariables = glob.variables.map((v) => ({
      list: v.list,
      scope: v.scope,
      name: v.name,
      type: v.typeName,
      initialValue: v.initialValue || null,
      address: v.address || null,
      comment: v.comment || null,
    }));
  }
  if (includeSource || includeDeclarations) {
    if (includeSource) {
      result.sources = pous(project).slice(0, maxObjects).map((p) => {
        const src = pouSource(project, contents, p);
        if (!src.text) return { name: p.name, typeName: p.typeName, length: 0, text: null, note: 'no text body (SFC chart / binary body)' };
        return {
          name: p.name,
          typeName: p.typeName,
          length: src.text.length,
          truncated: src.text.length > maxSourceChars,
          text: src.text.length > maxSourceChars ? src.text.slice(0, maxSourceChars) : src.text,
        };
      });
    }
    if (includeDeclarations) {
      result.declarations = pous(project).slice(0, maxObjects).map((p) => ({
        pou: p.name,
        typeName: p.typeName,
        variables: pouDeclarations(project, contents, p).variables.map((v) => ({
          scope: v.scope,
          name: v.name,
          type: v.typeName,
          initialValue: v.initialValue || null,
          comment: v.comment || null,
        })),
      }));
    }
  }
  return result;
}

async function toolOpenProject({ file, autoConfirm = true, waitMs = 8000 }) {
  const install = findInstall();
  if (!install) throw new Error('FPWIN Pro installation not found (set FPWIN_ROOT).');
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) throw new Error(`file not found: ${abs}`);
  const before = dirSnapshot(path.dirname(abs));
  const child = launch(install.exe, [abs], install.makDir);
  await sleep(waitMs);
  const wins = parseDialogText((await listWindows(child.pid)).stdout);
  const actions = [];
  if (autoConfirm) {
    for (const d of wins.dialogs) {
      if (/转换|Convert|确实要|Do you really/i.test(d.text)) {
        const r = await clickDialogButton(child.pid, '是(&Y)');
        actions.push({ dialog: d.text.slice(0, 200), clicked: '是(&Y)', result: r.stdout, error: r.stderr });
        await sleep(4000);
      }
    }
  }
  const after = dirSnapshot(path.dirname(abs));
  const wins2 = parseDialogText((await listWindows(child.pid)).stdout);
  return {
    pid: child.pid,
    exe: install.exe,
    opened: abs,
    autoConfirm,
    actions,
    windows: wins2.windows.slice(0, 40),
    dialogs: wins2.dialogs.slice(0, 10),
    fileDelta: dirDelta(before, after),
    note: 'The IDE stays running; close it with the returned pid when finished.',
  };
}

async function toolSnapshot({ file, outputDir, timeoutMs = 90000, autoConfirm = true }) {
  const install = findInstall();
  if (!install) throw new Error('FPWIN Pro installation not found (set FPWIN_ROOT).');
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) throw new Error(`file not found: ${abs}`);
  const workDir = path.resolve(outputDir || path.join(path.dirname(abs), 'fpwin-snapshot-' + Date.now()));
  fs.mkdirSync(workDir, { recursive: true });
  const target = path.join(workDir, path.basename(abs));
  fs.copyFileSync(abs, target); // never mutate the caller's project

  const before = dirSnapshot(workDir);
  const started = Date.now();
  const child = launch(install.exe, ['create_snapshot_from_file_project', target], install.makDir);
  let exited = false;
  let exitCode = null;
  let completedByOutputs = false;
  let firstOutputAt = null;
  const dialogsSeen = [];
  while (Date.now() - started < timeoutMs) {
    await sleep(1500);
    const wins = parseDialogText((await listWindows(child.pid)).stdout);
    for (const d of wins.dialogs) {
      const key = d.text.slice(0, 120);
      if (!dialogsSeen.some((x) => x.text === key)) dialogsSeen.push(d);
    }
    if (autoConfirm && wins.dialogs.length) {
      // Conversion prompt uses 是(&Y)/否(&N); generic warnings use 确定.
      let r = await clickDialogButton(child.pid, '是');
      if (/NOBUTTON/.test(r.stdout)) r = await clickDialogButton(child.pid, '确定');
    }
    const deltaNow = dirDelta(before, dirSnapshot(workDir));
    if (deltaNow.added.length && firstOutputAt === null) firstOutputAt = Date.now();
    if (firstOutputAt !== null && Date.now() - firstOutputAt > 3000) { completedByOutputs = true; break; }
    if (child.exitCode !== null || child.signalCode !== null) { exited = true; exitCode = child.exitCode; break; }
  }
  if (!exited) { killTree(child); }
  const after = dirSnapshot(workDir);
  const delta = dirDelta(before, after);
  return {
    mode: 'create_snapshot_from_file_project',
    input: abs,
    workCopy: target,
    workDir,
    exited,
    completedByOutputs,
    exitCode,
    elapsedMs: Date.now() - started,
    dialogs: dialogsSeen.slice(0, 10),
    outputs: delta,
    note: 'Verified headless path: the IDE converts the project copy and writes <name>.pro / <name>.log / <name>.ini next to it.',
  };
}

async function toolBatch({ commands, projectFile, timeoutMs = 90000, autoConfirm = false }) {
  const install = findInstall();
  if (!install) throw new Error('FPWIN Pro installation not found (set FPWIN_ROOT).');
  if (!commands || !commands.trim()) throw new Error('commands must be a non-empty batch command string');
  const args = [];
  if (projectFile) {
    const abs = path.resolve(projectFile);
    if (!fs.existsSync(abs)) throw new Error(`file not found: ${abs}`);
    args.push(abs);
  }
  args.push('/batch', commands);
  const started = Date.now();
  const child = launch(install.exe, args, install.makDir);
  const dialogs = [];
  let exited = false;
  let exitCode = null;
  while (Date.now() - started < timeoutMs) {
    await sleep(1200);
    const wins = parseDialogText((await listWindows(child.pid)).stdout);
    for (const d of wins.dialogs) {
      const key = d.text;
      if (!dialogs.some((x) => x.text === key)) dialogs.push(d);
    }
    if (autoConfirm && wins.dialogs.length) await clickDialogButton(child.pid, '确定');
    if (child.exitCode !== null || child.signalCode !== null) { exited = true; exitCode = child.exitCode; break; }
  }
  if (!exited) killTree(child);
  const syntaxErrors = dialogs.filter((d) => /Syntax error|语法/i.test(d.text)).map((d) => d.text);
  return {
    argv: [install.exe, ...args],
    exited,
    exitCode,
    elapsedMs: Date.now() - started,
    dialogs: dialogs.slice(0, 10),
    syntaxErrors,
    verdict: syntaxErrors.length
      ? 'rejected: the batch parser reports a syntax error (the OS-level dialog text above is authoritative)'
      : exited ? 'completed' : 'still running when the timeout expired (killed)',
    note: 'This build parses /batch <text> as inline batch commands; the accepted grammar is not documented in the shipped help. Use the dialog text as the oracle while iterating.',
  };
}

async function toolWindows({ pid, clickButton }) {
  if (!pid) throw new Error('pid is required');
  if (clickButton) {
    const r = await clickDialogButton(pid, clickButton);
    return { pid, clicked: clickButton, stdout: r.stdout, stderr: r.stderr };
  }
  const r = await listWindows(pid);
  return { pid, ...parseDialogText(r.stdout) };
}

function truncateJson(obj, maxArray) {
  const clone = Array.isArray(obj) ? obj.slice(0, maxArray) : obj;
  if (Array.isArray(clone)) return clone;
  for (const k of Object.keys(clone)) if (Array.isArray(clone[k]) && clone[k].length > maxArray) clone[k] = clone[k].slice(0, maxArray);
  return clone;
}

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'fpwin_info',
    description: 'Detect the local Control FPWIN Pro 7 installation: root, EXE, PE bitness, helper DLLs, registry lines, verified CLI forms and project formats.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: toolInfo,
  },
  {
    name: 'fpwin_doctor',
    description: 'Diagnose the environment for headless use: install layout, 32-bit EXE, and whether the delay-loaded PxMew (MEWNET) runtime can initialise — the known cause of an unhandled 0xC06D007E crash on project open.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: toolDoctor,
  },
  {
    name: 'fpwin_asc_parse',
    description: 'Parse a CoDeSys/FPWIN Pro .asc export offline (no IDE): project metadata, PLC types, POUs with languages, DUTs, globals, tasks, and optionally all IEC variable declarations.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Path to the .asc file' },
        includeVariables: { type: 'boolean', description: 'Also return IEC variable declarations (VAR/VAR_INPUT/...)' },
        maxObjects: { type: 'number', description: 'Max list lengths in the response (default 2000)' },
      },
      required: ['file'],
    },
    handler: toolAscParse,
  },
  {
    name: 'fpwin_pro_inspect',
    description: 'Inspect a binary .pro project container offline: size/block alignment, header bytes, block table name offsets (SCOBJ_TAB, SCCONT_TAB, …), embedded metadata and printable strings.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Path to the .pro file' },
        maxStrings: { type: 'number', description: 'Max strings to return (default 150)' },
      },
      required: ['file'],
    },
    handler: toolProInspect,
  },
  {
    name: 'fpwin_pro_parse',
    description: 'Parse a binary .pro project container offline (no IDE): walks the SC frames, rebuilds the object tree (project / PLC config / tasks / POUs / DUTs / globals) with object ids, parents and confirmed type codes (PROGRAM 0x0F, FUNCTION_BLOCK 0x10, FUNCTION 0x11, DUT 0x0C, global list 0x0D), and returns the POU list, DUT field lists, global variables, tasks and decoded SFC charts. Validated against all 27 shipped .pro/.asc sample pairs (POUs 27/27, sources 79/79, POU declarations 300/300, DUT fields 84/84, global variables 99/99, task settings 653/653, program-to-task bindings 32/32, SFC charts 4/4 with 28/28 steps, 41/41 actions, 29/29 transitions, 22/22 transition bodies, 58/58 FROM/TO links).',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Path to the .pro file' },
        tree: { type: 'boolean', description: 'Return the indented object tree (default true)' },
        includeFolders: { type: 'boolean', description: 'Keep folder pseudo-objects in the tree (default false)' },
        includeLanguage: { type: 'boolean', description: 'Detect each POU implementation language (LD / FBD / IL / SFC / ST) from the body section type code and body markers (default true)' },
        includeSource: { type: 'boolean', description: 'Also return the reconstructed source text of every POU (LD/FBD/IL/SFC text stored as zlib-compressed UTF-16LE)' },
        includeDeclarations: { type: 'boolean', description: 'Also return the decoded variable declarations of every POU (name / scope / type / initial value / comment)' },
        includeDuts: { type: 'boolean', description: 'Return the DUT (TYPE … END_TYPE) field lists (name / type / initial value / comment), default true' },
        includeGlobalVariables: { type: 'boolean', description: 'Return the global variable list(s) from the configuration VAR_GLOBAL block (name / type / address / initial value / comment), default true' },
        includeTasks: { type: 'boolean', description: 'Return the configured tasks with their SINGLE / INTERVAL / PRIORITY settings and the PROGRAMs assigned to each task (PROGRAM X WITH <task>), default true' },
        includeSfc: { type: 'boolean', description: 'Return decoded SFC charts (sequential function chart): per chart, element list (step / initial-step / final-step / transition / divergence / branch-start / branch-end / convergence) with sequence, kind, name, raw prev/next ids, resolved wiring (in/out), step action lists (name / qualifier / action body reference), transition FROM/TO steps and transition body language (LD / IL / FBD), default true' },
        maxSourceChars: { type: 'number', description: 'Truncate each source text to this many characters (default 4000)' },
        maxObjects: { type: 'number', description: 'Max rows to return (default 2000)' },
      },
      required: ['file'],
    },
    handler: toolProParse,
  },
  {
    name: 'fpwin_open_project',
    description: 'Open a project in the FPWIN Pro GUI. Optionally auto-answers the "project was created by FPWIN Pro 6, convert?" prompt and reports windows, dialogs and file changes.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string' },
        autoConfirm: { type: 'boolean', description: 'Click 是(Y) on the version-conversion prompt (default true)' },
        waitMs: { type: 'number', description: 'Wait before inspecting windows (default 8000)' },
      },
      required: ['file'],
    },
    handler: toolOpenProject,
  },
  {
    name: 'fpwin_snapshot',
    description: 'Verified headless path: copy a .pro into a work dir and run "create_snapshot_from_file_project", returning new/changed files (converted .pro, .log, .ini) plus any dialogs. Never mutates the input project.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string' },
        outputDir: { type: 'string', description: 'Work directory (default: sibling folder fpwin-snapshot-<ts>)' },
        timeoutMs: { type: 'number' },
        autoConfirm: { type: 'boolean' },
      },
      required: ['file'],
    },
    handler: toolSnapshot,
  },
  {
    name: 'fpwin_batch',
    description: 'Run the IDE batch parser: "<exe> [project] /batch \\"<commands>\\"". Captures OS dialogs (the build reports syntax errors and confirmations through dialogs) and reports syntax-error text, exit state and verdict.',
    inputSchema: {
      type: 'object',
      properties: {
        commands: { type: 'string', description: 'Inline batch command text' },
        projectFile: { type: 'string' },
        timeoutMs: { type: 'number' },
        autoConfirm: { type: 'boolean', description: 'Click 确定 on dialogs as they appear' },
      },
      required: ['commands'],
    },
    handler: toolBatch,
  },
  {
    name: 'fpwin_windows',
    description: 'List top-level windows/dialogs of a running FPWIN Pro process, or click a named dialog button (e.g. 确定 / 是(&Y)). Useful for scripted dialog handling.',
    inputSchema: {
      type: 'object',
      properties: {
        pid: { type: 'number' },
        clickButton: { type: 'string', description: 'Button caption to click in the #32770 dialog' },
      },
      required: ['pid'],
    },
    handler: toolWindows,
  },
];

// ---------------------------------------------------------------------------
// MCP stdio transport
// ---------------------------------------------------------------------------

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function replyError(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

async function handleToolCall(id, params) {
  const tool = TOOLS.find((t) => t.name === params.name);
  if (!tool) return replyError(id, -32602, `unknown tool: ${params.name}`);
  try {
    const args = params.arguments || {};
    const result = await tool.handler(args);
    reply(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
  } catch (err) {
    reply(id, {
      content: [{ type: 'text', text: JSON.stringify({ error: String(err && err.message || err) }, null, 2) }],
      isError: true,
    });
  }
}

let buffer = '';
function startServer() {
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const { id, method, params } = msg;
      if (method === 'initialize') {
        reply(id, {
          protocolVersion: (params && params.protocolVersion) || '2026-07-28',
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          instructions: 'FPWIN Pro 7 automation/RE bridge. Start with fpwin_info and fpwin_doctor; .asc/.pro tools are offline and IDE-free.',
        });
      } else if (method === 'tools/list') {
        reply(id, {
          tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
        });
      } else if (method === 'tools/call') {
        handleToolCall(id, params);
      } else if (method === 'ping') {
        reply(id, {});
      } else if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
        // notification: no response
      } else if (id !== undefined) {
        replyError(id, -32601, `method not found: ${method}`);
      }
    }
  });

  process.stdin.on('end', () => process.exit(0));
}

// Tool-call entry point for shells where piped stdio is blocked (DSH sandbox) or
// for quick manual checks:
//   node server.js --call fpwin_pro_parse '{"file":"x.pro"}'
//   node server.js --call fpwin_asc_parse args.json
if (process.argv[2] === '--call') {
  (async () => {
    const toolName = process.argv[3];
    const rawArgs = process.argv[4] || '{}';
    const tool = TOOLS.find((t) => t.name === toolName);
    if (!tool) { console.error('unknown tool: ' + toolName + ' (have: ' + TOOLS.map((t) => t.name).join(', ') + ')'); process.exit(2); }
    let args = {};
    try {
      const text = fs.existsSync(rawArgs) ? fs.readFileSync(rawArgs, 'utf8') : rawArgs;
      args = JSON.parse(text.replace(/^\uFEFF/, ''));
    } catch (e) {
      console.error('invalid JSON args: ' + e.message);
      process.exit(2);
    }
    try {
      const out = await tool.handler(args);
      process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    } catch (e) {
      console.error('tool error: ' + e.message);
      process.exit(1);
    }
  })();
} else if (process.argv[2] === '--self-test') {
  const target = process.argv[3];
  const withVars = process.argv.includes('--vars');
  (async () => {
    if (!target) { console.error('usage: node server.js --self-test <file>'); process.exit(2); }
    const abs = path.resolve(target);
    const isPro = /\.pro$/i.test(abs);
    const out = isPro ? await toolProInspect({ file: abs, maxStrings: 400 }) : await toolAscParse({ file: abs, includeVariables: withVars, maxObjects: 400 });
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  })();
} else {
  startServer();
}
