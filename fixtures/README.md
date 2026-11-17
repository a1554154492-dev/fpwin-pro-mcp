# Fixtures

Panasonic's own sample projects and library exports are **not redistributed** with this
repository (they ship with the FPWIN Pro installation and are Panasonic copyright).

Tests and the CLI accept any `.pro` / `.asc` file, so point them at your local installation
instead, for example:

```
D:\FP7752\Samples\English\*.pro     # 27 .pro/.asc pairs shipped with FPWIN Pro 7
D:\FP7752\Library\*.ASC             # IEC library sources
D:\FP7752\Mak\EmptyPrj.pro          # empty project template
```

To run the bundled checks against those samples, copy them into this directory (the paths are
git-ignored) or pass the installation directory as the argument:

```powershell
node test\proparse.test.js                       # synthetic in-memory fixtures only
node test\parse-pro.js "D:\FP7752\Samples\English"
node proparse-cli.js "D:\FP7752\Samples\English\Flasher (Timer, LD).pro" --pous
```

`test/proparse.test.js` builds its inputs in memory and does not need this directory.
