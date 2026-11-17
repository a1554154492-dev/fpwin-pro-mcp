param(
  [Parameter(Mandatory = $true)][int]$TargetPid,
  [Parameter(Mandatory = $true)][int]$X,
  [Parameter(Mandatory = $true)][int]$Y,
  [ValidateSet('left', 'right', 'double')][string]$Button = 'left',
  [int]$DelayMs = 120,
  [switch]$NoActivate
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

$src = @'
using System;using System.Text;using System.Runtime.InteropServices;
public class FpClick {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, IntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  static string Cls(IntPtr h){ var sb=new System.Text.StringBuilder(256); GetClassNameW(h,sb,256); return sb.ToString(); }
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, System.Text.StringBuilder s, int n);
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
  public static void Click(int sx, int sy, uint flags, int holdMs){
    SetCursorPos(sx, sy);
    System.Threading.Thread.Sleep(60);
    if((flags & 2)!=0) mouse_event(0x0002,0,0,0,IntPtr.Zero);
    else mouse_event(0x0008,0,0,0,IntPtr.Zero);
    System.Threading.Thread.Sleep(holdMs);
    if((flags & 2)!=0) mouse_event(0x0004,0,0,0,IntPtr.Zero);
    else mouse_event(0x0010,0,0,0,IntPtr.Zero);
  }
}
'@
if (-not ('FpClick' -as [type])) { Add-Type -TypeDefinition $src -Language CSharp }

try { [void][FpClick]::SetProcessDPIAware() } catch {}
$h = [FpClick]::Pick([uint32]$TargetPid)
if ($h -eq [IntPtr]::Zero) { Write-Output 'NOWINDOW'; exit 1 }
if (-not $NoActivate.IsPresent) {
  [void][FpClick]::ShowWindow($h, 9)
  [void][FpClick]::SetForegroundWindow($h)
  Start-Sleep -Milliseconds 350
}
$r = [FpClick]::Rect($h)
$sx = $r[0] + $X
$sy = $r[1] + $Y
if ($Button -eq 'double') {
  [FpClick]::Click($sx, $sy, 2, 80)
  Start-Sleep -Milliseconds 80
  [FpClick]::Click($sx, $sy, 2, 80)
} elseif ($Button -eq 'right') {
  [FpClick]::Click($sx, $sy, 8, 80)
} else {
  [FpClick]::Click($sx, $sy, 2, 80)
}
Start-Sleep -Milliseconds $DelayMs
Write-Output ("CLICK|" + $Button + "|win=" + ($r -join ',') + "|rel=" + $X + "," + $Y + "|screen=" + $sx + "," + $sy)
