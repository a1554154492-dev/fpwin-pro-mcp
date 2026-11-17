# FPWIN Pro MCP server

A Model Context Protocol server for **Panasonic Control FPWIN Pro 7** (v7.5.2.0, the
CoDeSys‑2.3‑derived Panasonic IDE), built from REA‑assisted reverse engineering of the
local installation instead of an official API — because none is registered.

- Transport: MCP **stdio**, newline‑delimited JSON‑RPC 2.0
- Runtime: Node.js ≥ 18, **zero npm dependencies**
- Platform: Windows (uses Win32 windows + the shipped 32‑bit IDE)

```
fpwin-mcp/
├─ server.js        MCP server + offline parsers (single file, no deps)
├─ winui.ps1        Win32 window/dialog enumeration + button click (helper)
├─ probe32.ps1      32-bit LoadLibrary probe (MEWNET runtime diagnosis)
├─ test/smoke.js    JSON-RPC smoke client
└─ fixtures/        sample .asc / .pro inputs
```

## What the reverse engineering established

Evidence gathered with REA (PE import/export readers, string corpus over all 92 binaries,
minidump parsing) plus black‑box execution of the IDE.

| Finding | Evidence |
|---|---|
| `fpwinpro.exe` is a 51 KB 32‑bit MFC bootstrap that imports only `CSCApp` ctor/dtor from `sc_app.dll` + `RegisterWindowMessageW` (single‑instance IPC). | `inspect_pe_imports` on `Mak\fpwinpro.exe` |
| No COM automation server is registered; no IDispatch automation surface. | `HKLM/HKCU\Classes` scan, ProgID/TypeLib scan, string corpus |
| The IDE is a CoDeSys 2.3 derivative: modules `sc_*` (project/object), `us_*` (codegen/upload), `on_*` (online), `ed_*` (editors), plus `mew_lib.dll` (MEWNET), `fp2asc.dll`, `TbCon.mak`‑style target tables. | `Mak\` inventory, exports |
| `on_serv.dll` exports the online engine: `Download/Upload/Load/Store/Login/Logout/Set/Force/UnForce/Reset/OnlineChange/TestRun*` on `COnlineServerBase`/`COnMastOnlineServer`/`CMewnetOnlineServer`. | `inspect_native_exports` on `on_serv.dll` (108 exports) |
| Command‑line layer lives in `sc_app.dll`: `CCommandLine` (`ParseParam`, `Process`, `GetBatchFile`, `IsBatchMode`, `IsCommandLineFile`, `ShallBeInvisibleAndTerminateAfterSnapshotCreation`), `CBatchMode` (`ParseBatchCmdLine`, `ParseSCBatchFile`, `ExecuteBatchStatementList`), `CVersionControl`. | string corpus + exported C++ symbols |
| Switch literals in the image: `checkonly`, `nologo`, `autorecover`, `create_snapshot_from_plc_project`, `create_snapshot_from_file_project`. Dialogs: `Syntax error in batch command line:`, `Do you really want to execute batch file '%s' ?`, `No syntax errors in batch file '%s'.`, `You are using the basic version in batch mode!!!` | string corpus |
| Project formats: `.pro` = frame stream container (`u32@0 = size-1`, `0x800`-aligned, `u32@8` = usedLength) with a fixed 18-frame `FE FE` catalogue and ten 401-byte `SCOBJ_TAB`/`SCCONT_TAB`/`SCDECL_TAB`/`SCCOM_TAB`/`SCCRL_TAB` `.dat`/`.idx` records (`.idx` pages are always empty), writer paths embedded (`C:\_FPWinPro_Trunk_1\bin\Makdeb\*.pro!<TABLE>`); `.asc` = CoDeSys ASCII export, two dialects: project export (`BEGIN_OBJECT … END_OBJECT`, settings only) and IEC text (library/POUs, UTF‑16LE). | container scans, `Library\*.ASC`, `Samples\*.asc` |
| Verified CLI behaviour of this build: `<exe> <project>` opens the GUI; `<exe> create_snapshot_from_file_project <project>` converts/writes `<project>.pro/.log/.ini`; `<exe> /batch "<text>"` feeds the inline batch parser (dialogs are the reporting channel). | black‑box runs, dialog capture |

### The crash that was *not* a bug

Early runs crashed with an unhandled `0xC06D007E` (delay‑load failure). Parsing the 60 MB
minidump (`DelayLoadInfo` → `pidd` → delay‑import descriptor) identified **`PxMewUserIF.dll`**,
delay‑loaded by `mew_lib.dll`. In a 32‑bit host that DLL returned Win32 **1114**
(`DLL_INIT_FAILED`) — its `DllMain` could not initialise. Root cause in this session was the
DSH file sandbox: the IDE and the MEWNET DLL need to write their own configuration next to the
installation, and denial turned into the delay‑load abort. With normal write access the same
binary opens projects correctly (and the first prompt is just the v6→v7 conversion dialog).
`fpwin_doctor` reproduces this exact diagnosis at runtime.

## Tools

| Tool | Needs IDE? | What it does |
|---|---|---|
| `fpwin_info` | no | Installation root, EXE/PE facts, helper DLLs, registry lines, verified CLI forms, formats |
| `fpwin_doctor` | no | Layout checks, 32‑bit EXE check, MEWNET `PxMewUserIF.dll` 32‑bit load probe (the 1114/0xC06D007E trap) |
| `fpwin_asc_parse` | no | Parse `.asc` (both dialects): project metadata, PLC types, POUs, DUTs, tasks, IEC variable declarations |
| `fpwin_pro_inspect` | no | `.pro` container scan: block table offsets, header, embedded metadata, printable strings |
| `fpwin_pro_parse` | no | **Parse the `.pro` SC container** into an object model: object tree (project / PLC config / tasks / POUs / DUTs / globals), object ids + parents, confirmed type codes (PROGRAM `0x0F`, FUNCTION_BLOCK `0x10`, FUNCTION `0x11`, DUT `0x0C`, global list `0x0D`), the POU list, each POU's reconstructed **source text** (`includeSource`), decoded **variable declarations** (`includeDeclarations`), **DUT field lists** (`includeDuts`), **global variables** (`includeGlobalVariables`: scope / name / type / address / initial value / comment), **tasks** (`includeTasks`: SINGLE / INTERVAL / PRIORITY plus the **PROGRAMs assigned to each task**, i.e. `PROGRAM X WITH <task>`) and decoded **SFC charts** (`includeSfc`: elements in chart order — step / initial-step / final-step / transition / divergence / branch-start / branch-end / convergence — with raw link ids, resolved **wiring (in/out)**, **transition FROM/TO steps**, step action lists and transition body language/body length). Validated on all 27 shipped `.pro`/`.asc` pairs, plus a 42-container coverage audit
(`work/coverage-audit.js`: 0 parse errors, 0 warnings, 36/42 containers at full decode
coverage) — see [PRO-FORMAT.md](PRO-FORMAT.md) §7 and §10 |
| `fpwin_open_project` | yes | Open a project in the GUI, auto‑answer the v6→v7 conversion prompt, report windows/dialogs/file deltas |
| `fpwin_snapshot` | yes | Headless‑ish convert/snapshot on a **copy** (`create_snapshot_from_file_project`), returns produced `.pro/.log/.ini` |
| `fpwin_batch` | yes | Run `<exe> [project] /batch "<commands>"`, capture the dialogs that the batch parser uses to report syntax errors and confirmations |
| `fpwin_windows` | yes | List windows/dialogs of a running FPWIN process or click a named dialog button (e.g. `确定`, `是(&Y)`) |

### Honest limitations

- The accepted **batch command grammar is not documented** in the shipped help and this OEM
  build rejects the classic CoDeSys 2.3 command file text; `fpwin_batch` therefore returns the
  dialog text as the oracle instead of guessing. `create_snapshot_from_file_project` is the one
  batch‑adjacent path that is fully verified.
- `.pro` **object layer, POU source, declarations, DUTs, globals, task bindings and SFC charts are decoded**
  (`fpwin_pro_parse`, details in [PRO-FORMAT.md](PRO-FORMAT.md)): project tree, object ids/parents,
  POU type codes, zlib/UTF-16 body text (79/79 bodies match the 27 `.asc` exports), declaration
  records (300/300 explicit variables = 100%; `EN`/`ENO` are implicit and not stored), DUT field
  lists (12/12 DUTs, 84/84 fields), global variables (99/99, including FP addresses such as
  `%IX0.0` and the empty-AT-slot record variant), task settings (653/653 tasks,
  1959/1959 SINGLE/INTERVAL/PRIORITY values), program-to-task assignments (32/32
  `PROGRAM X WITH <task>` bindings: one kind 4 name frame per assignment under the task object;
  the setting frame's numeric ids are those binding records' own ids, listed in assignment order;
  7.7 writes the same records as `FC FC` frames with UTF-16 names, and zeroed ones surface as
  `emptyIds`)
  and SFC charts (4/4 charts, 28/28 steps, 41/41 actions,
  29/29 transitions, 22/22 transition bodies, 58/58 FROM/TO links: binary element records with
  action lists, transition body language/bodies and a per-chart link table that encodes the SFC
  flow — the four branch pseudo-elements 11–14 are decoded as divergence / branch-start /
  branch-end / convergence, so parallel divergences and merges reconstruct exactly). Still
  undecoded: custom type names behind
  `typeRef != -1` (none occur in the 27 shipped samples; every record stores the type name
  inline). `fpwin_pro_inspect` remains the low-level heuristic scan (table offsets + strings).
- **Content coverage is not uniform across project versions.** The structure decodes on every
  container tested (42/42: container header, frame chain, object tree, `0` parse errors, `0`
  warnings), and the 6.00 samples are fully decoded. But the 7.5/7.7 content dialects are still
  open (see [PRO-FORMAT.md](PRO-FORMAT.md) §9 item 10, §10):
  - **POU bodies**: 7.5/7.7 store the body section (`0x1A`) as `u32 char count + UTF-16LE text`
    with no `BODY…END_BODY` wrapper. `pouSource()` only recognises the `BODY` prefix, so across
    the 7 audited 7.5/7.7 containers only **2 of 70** POUs yield source text
    (6.00 dialect: **101/106**, the remaining 5 are SFC charts with no text body by design).
  - **SFC charts**: 7.5/7.7 charts do contain the `0x467312AA` marker but use a different element
    record stride/field set; the 10 audited charts decode to **2856 `kind=0` records, 0 valid
    elements**, versus 5 fully-decoded 6.00 charts (106 elements, 34/34 transitions wired).

  `proparse-cli.js <file.pro> --coverage` prints the per-project numbers (also `--json` →
  top-level `coverage`); full audit output is in `work/coverage-audit.txt`.
- `.asc` project exports carry **settings only** — POUs live in the `.pro` container. Use the
  `Library\*.ASC` files or an object export to get IEC source.
- GUI tools drive the real IDE window; they need an interactive desktop session.

## Install into DeepSeek Harness

Register the server in your MCP configuration (`mcp.json` / `mcpServers` block):

```json
{
  "mcpServers": {
    "fpwin-pro": {
      "command": "C:\\path\\to\\node.exe",
      "args": ["C:\\work\\fpwin-mcp\\server.js"],
      "env": { "FPWIN_ROOT": "D:\\FP7752" }
    }
  }
}
```

`FPWIN_ROOT` is optional — the server probes `D:\FP7752`, the standard Program Files
locations, and the installer's registry key. A ready-made template lives in
[mcp.example.json](mcp.example.json).

Panasonic's own sample projects are **not redistributed** here (they ship with the IDE and are
Panasonic copyright). Copy your local `Samples\English\*` / `Library\*.ASC` into `fixtures/`
before running the sample-based checks — see [fixtures/README.md](fixtures/README.md).

## Run / test

```powershell
# protocol + offline tools (fast, no IDE)
node test\smoke.js --offline
# IDE-backed tools (opens the IDE, ~1-2 min)
node test\smoke.js --ide --batch
# one-shot parser check
node server.js --self-test fixtures\MLIB.asc --vars

# .pro parser: fixture assertions + the 27 sample pairs + type-code census + source text + declarations
node test\proparse.test.js
node test\parse-pro.js "D:\FP7752\Samples\English"
node test\parse-source.js "D:\FP7752\Samples\English"   # POU bodies vs .asc BODY…END_BODY
node test\parse-decl.js "D:\FP7752\Samples\English"     # variable declarations vs .asc VAR blocks
node test\parse-dut.js  "D:\FP7752\Samples\English"     # DUT fields vs .asc TYPE blocks
node test\parse-glob.js "D:\FP7752\Samples\English"     # global variables vs .asc CONFIGURATION VAR_GLOBAL
node test\parse-task.js "D:\FP7752\Samples\English"     # task settings vs .asc TASK blocks
node test\parse-bind.js "D:\FP7752\Samples\English"     # PROGRAM X WITH <task> bindings vs .asc
node test\parse-sfc.js  "D:\FP7752\Samples\English"     # SFC charts vs .asc SFC * blocks
node tools\typecensus.js "D:\FP7752\Samples\English"
node work\coverage-audit.js                              # 42-container decode-coverage audit → work\coverage-audit.txt

# standalone CLI (no MCP server involved)
node proparse-cli.js "fixtures\samples\Flasher (Timer, LD).pro" --pous
node proparse-cli.js "fixtures\samples\Flasher (Timer, LD).pro" --bodies
node proparse-cli.js "fixtures\samples\Flasher (Timer, LD).pro" --body FlasherSolution1
node proparse-cli.js "fixtures\samples\Flasher (Timer, LD).pro" --decls
node proparse-cli.js "fixtures\samples\Flasher (Timer, LD).pro" --decl FlasherSolution1
node proparse-cli.js "fixtures\samples\Set and read the real time clock.pro" --duts
node proparse-cli.js "fixtures\samples\Set and read the real time clock.pro" --dut BCD_DATE_TIME
node proparse-cli.js "fixtures\samples\Coffee machine (SFC).pro" --globals
node proparse-cli.js "fixtures\samples\Coffee machine (SFC).pro" --tasks
node proparse-cli.js "fixtures\samples\Coffee machine (SFC).pro" --sfc
node proparse-cli.js "fixtures\samples\Coffee machine (SFC).pro" --json   # counts.sfcCharts + sfc elements + coverage
node proparse-cli.js "fixtures\samples\Coffee machine (SFC).pro" --coverage # decoded/total counts for this project
node proparse-cli.js "工程.pro" --out-dir out\bodies      # write every POU body to a file
node proparse-cli.js "fixtures\samples\Coffee machine (SFC).pro" --asc "fixtures\samples\Coffee machine (SFC).asc"

# call one MCP tool directly (also works where piped stdio is blocked)
node server.js --call fpwin_pro_parse '{"file":"fixtures\\samples\\Flasher (Timer, LD).pro"}'
```

## Next steps that would add real value

The single biggest remaining coverage gap is the **7.5/7.7 content dialect** (body text and SFC
element stream; see [PRO-FORMAT.md](PRO-FORMAT.md) §9 item 10 and the matrix in §10): it is the
only reason 6 of the 42 audited containers are not at full decode coverage. After that:

1. Finish the remaining `.pro` byte-level details (see [PRO-FORMAT.md](PRO-FORMAT.md) §9):
   the SFC trailer field width (u32 vs u16+u16), the 3 un-diagnosed same-set/different-order
   `programIds` tasks, the table-descriptor fields `+0x18`/`+0x1C`, and the `token` word in
   SFC link-table rows.
   Already resolved: the container length field is `u32@0 == size-1`
   (43 containers, 64 KiB … 3.1 MiB), the `FE FE` catalogue is a fixed 18-frame table directory,
   the `.dat`/`.idx` table records are decoded (`tables()`), 7.7.x declaration records carry a
   per-record GUID, and `typeRef` is always the inline-type sentinel (9592 records, no UDT id).
   `programIds` are binding-record ids (34 order-identical / 4 same-set / 2 projects with
   deleted ids), the 22-byte SFC stream terminator is the chart trailer whose last u32 is the
   Steps folder id (5/5 chart sections), and **7.7 program names now resolve**: 7.7 writes the
   binding records as `FC FC` frames (a tag the parser used to miss, which also hid 42 KB of
   records behind a false `FA FA` frame), names are plain UTF-16 so CJK PROGRAM names work
   (`工位甲手动上料_CON`), and zeroed binding records are reported as `emptyIds` — the 7.7
   sample resolves 9/11 names. Object tree, POU bodies, declarations, DUTs, global variables,
   task settings, program-to-task bindings and SFC charts — including **SFC FROM/TO connections**
   and the branch pseudo-elements 11–14 — are already decoded.
2. Decode the compiled symbol `.log` written by the snapshot path (contains
   `The_Symbol_Table`, `ROM_Config`, `ROM_Upload`, `ROM_Pool`) → variable table with addresses.
3. Wrap `on_serv.dll`'s online server (Login/Set/Refresh/Force) or MEWTOCOL‑COM directly for
   PLC I/O; that is the only path to live values, since no scripting/COM API exists.
