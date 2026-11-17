param(
  [Parameter(Mandatory = $true)][int]$TargetPid,
  [Parameter(Mandatory = $true)][string]$Seq,
  [int]$KeyDelayMs = 120,
  [int]$AfterMs = 400,
  [switch]$NoActivate
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

$src = @'
using System;using System.Text;using System.Runtime.InteropServices;
public class FpKeys {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  static string Cls(IntPtr h){ var sb=new StringBuilder(256); GetClassNameW(h,sb,256); return sb.ToString(); }
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
  public static void Tap(byte vk){
    keybd_event(vk, 0, 0, UIntPtr.Zero);
    System.Threading.Thread.Sleep(30);
    keybd_event(vk, 0, 2, UIntPtr.Zero);
  }
  public static void Down(byte vk){ keybd_event(vk, 0, 0, UIntPtr.Zero); }
  public static void Up(byte vk){ keybd_event(vk, 0, 2, UIntPtr.Zero); }
}
'@
if (-not ('FpKeys' -as [type])) { Add-Type -TypeDefinition $src -Language CSharp }
try { [void][FpKeys]::SetProcessDPIAware() } catch {}

if (-not $NoActivate.IsPresent) {
  $h = [FpKeys]::Pick([uint32]$TargetPid)
  if ($h -ne [IntPtr]::Zero) {
    [void][FpKeys]::ShowWindow($h, 9)
    [void][FpKeys]::SetForegroundWindow($h)
    Start-Sleep -Milliseconds 300
  }
}

$map = @{
  'DOWN' = 0x28; 'UP' = 0x26; 'LEFT' = 0x25; 'RIGHT' = 0x27;
  'ENTER' = 0x0D; 'ESC' = 0x1B; 'TAB' = 0x09; 'ALT' = 0x12; 'F10' = 0x79;
  'DELETE' = 0x2E; 'BACKSPACE' = 0x08; 'HOME' = 0x24; 'END' = 0x23; 'SPACE' = 0x20
}
$sent = @()
foreach ($tokRaw in ($Seq -split ',')) {
  $tok = $tokRaw.Trim()
  if ($tok -eq '') { continue }
  if ($tok -match '^([A-Z0-9]+)\+([A-Z0-9]+)$') {
    $mod = $map[$Matches[1]]; $keyName = $Matches[2]
    $key = if ($map.ContainsKey($keyName)) { $map[$keyName] } else { [byte][char]$keyName }
    [FpKeys]::Down([byte]$mod)
    Start-Sleep -Milliseconds 60
    [FpKeys]::Tap([byte]$key)
    Start-Sleep -Milliseconds 60
    [FpKeys]::Up([byte]$mod)
    $sent += ($Matches[1] + '+' + $keyName)
    Start-Sleep -Milliseconds $KeyDelayMs
  } elseif ($tok -match '^([A-Z0-9]+)x(\d+)$') {
    $k = $Matches[1]; $n = [int]$Matches[2]
    for ($i = 0; $i -lt $n; $i++) { $sent += $k; [FpKeys]::Tap([byte]$map[$k]); Start-Sleep -Milliseconds $KeyDelayMs }
  } elseif ($map.ContainsKey($tok.ToUpper())) {
    $sent += $tok.ToUpper(); [FpKeys]::Tap([byte]$map[$tok.ToUpper()]); Start-Sleep -Milliseconds $KeyDelayMs
  } elseif ($tok -match '^[A-Za-z0-9]$') {
    $vk = [byte][char]$tok.ToUpper()
    $sent += $tok.ToUpper(); [FpKeys]::Tap($vk); Start-Sleep -Milliseconds $KeyDelayMs
  } else {
    Write-Output ("SKIP|" + $tok)
  }
}
Start-Sleep -Milliseconds $AfterMs
Write-Output ("KEYS|" + ($sent -join ',') + "|pid=" + $TargetPid)
