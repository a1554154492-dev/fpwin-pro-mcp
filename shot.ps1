param(
  [Parameter(Mandatory = $true)][int]$TargetPid,
  [Parameter(Mandatory = $true)][string]$Out,
  [switch]$Foreground,
  [int]$ClickX = -1,
  [int]$ClickY = -1,
  [int]$ClickDelayMs = 450,
  [string]$Clicks = '',
  [int]$CropX = 0,
  [int]$CropY = 0,
  [int]$CropW = 0,
  [int]$CropH = 0
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Drawing

$src = @'
using System;using System.Text;using System.Collections.Generic;using System.Runtime.InteropServices;
public class FpShot {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, IntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  static string Cls(IntPtr h){ var sb=new StringBuilder(256); GetClassNameW(h,sb,256); return sb.ToString(); }
  static string Txt(IntPtr h){ var sb=new StringBuilder(512); GetWindowTextW(h,sb,512); return sb.ToString(); }
  public static IntPtr Pick(uint target){
    IntPtr best=IntPtr.Zero; int bestArea=0; IntPtr byClass=IntPtr.Zero;
    EnumWindows((h,l)=>{
      uint pid; GetWindowThreadProcessId(h, out pid);
      if(pid!=target || !IsWindowVisible(h)) return true;
      RECT r; if(!GetWindowRect(h, out r)) return true;
      int a=(r.Right-r.Left)*(r.Bottom-r.Top);
      if(Cls(h)=="Control FPWIN Pro 7") byClass=h;
      if(a>bestArea){ bestArea=a; best=h; }
      return true;
    }, IntPtr.Zero);
    return byClass!=IntPtr.Zero ? byClass : best;
  }
  public static int[] Rect(IntPtr h){ RECT r; GetWindowRect(h, out r); return new int[]{r.Left,r.Top,r.Right,r.Bottom}; }
  public static string Title(IntPtr h){ return Txt(h); }
  public static string ClassOf(IntPtr h){ return Cls(h); }
  public static void Click(int sx, int sy){
    SetCursorPos(sx, sy);
    System.Threading.Thread.Sleep(50);
    mouse_event(0x0002,0,0,0,IntPtr.Zero);
    System.Threading.Thread.Sleep(60);
    mouse_event(0x0004,0,0,0,IntPtr.Zero);
  }
}
'@
if (-not ('FpShot' -as [type])) { Add-Type -TypeDefinition $src -Language CSharp }
try { [void][FpShot]::SetProcessDPIAware() } catch {}

$h = [FpShot]::Pick([uint32]$TargetPid)
if ($h -eq [IntPtr]::Zero) { Write-Output 'NOWINDOW'; exit 1 }
if ($Foreground.IsPresent) {
  [void][FpShot]::ShowWindow($h, 9)
  [void][FpShot]::SetForegroundWindow($h)
  Start-Sleep -Milliseconds 350
}
$r = [FpShot]::Rect($h)
if ($Clicks -ne '') {
  foreach ($pair in ($Clicks -split ';')) {
    if ($pair.Trim() -eq '') { continue }
    $xy = $pair -split ','
    if ($xy.Count -lt 2) { continue }
    [FpShot]::Click(($r[0] + [int]$xy[0]), ($r[1] + [int]$xy[1]))
    Start-Sleep -Milliseconds $ClickDelayMs
  }
} elseif ($ClickX -ge 0 -and $ClickY -ge 0) {
  [FpShot]::Click(($r[0] + $ClickX), ($r[1] + $ClickY))
  Start-Sleep -Milliseconds $ClickDelayMs
}
$w = $r[2] - $r[0]
$hh = $r[3] - $r[1]
if ($CropW -gt 0 -and $CropH -gt 0) { $w = $CropW; $hh = $CropH }
if ($w -le 0 -or $hh -le 0) { Write-Output 'BADRECT'; exit 1 }
$bmp = New-Object System.Drawing.Bitmap($w, $hh)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen(($r[0] + $CropX), ($r[1] + $CropY), 0, 0, (New-Object System.Drawing.Size($w, $hh)))
$g.Dispose()
$dir = Split-Path -Parent $Out
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output ("SHOT|" + $Out + "|" + $w + "x" + $hh + "|win=" + ($r -join ',') + "|" + [FpShot]::ClassOf($h) + "|" + [FpShot]::Title($h))
