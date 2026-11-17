param([Parameter(Mandatory = $true)][string]$DllPath)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

$src = @'
using System;using System.Runtime.InteropServices;
public class FpProbe32 {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr LoadLibraryW(string path);
  [DllImport("kernel32.dll")] static extern uint GetLastError();
  public static int Try(string path){
    IntPtr h = LoadLibraryW(path);
    if (h != IntPtr.Zero) return 0;
    return (int)GetLastError();
  }
}
'@
if (-not ('FpProbe32' -as [type])) { Add-Type -TypeDefinition $src -Language CSharp }

Write-Output ("BITNESS|" + [Environment]::Is64BitProcess)
if (-not (Test-Path -LiteralPath $DllPath)) { Write-Output 'RESULT|2'; exit 0 }
$err = [FpProbe32]::Try($DllPath)
Write-Output ("RESULT|" + $err)
