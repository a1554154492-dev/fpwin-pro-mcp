param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('open', 'compile', 'import', 'export', 'save', 'state', 'dialogs', 'uia', 'keys', 'close')]
  [string]$Mode,
  [string]$Project = '',
  [string]$Asc = '',
  [string]$Out = '',
  [string]$Seq = '',
  [int]$TargetPid = 0,
  [int]$TimeoutSec = 60,
  [int]$WaitMs = 900
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$src = @'
using System;using System.Text;using System.Collections.Generic;using System.Runtime.InteropServices;
public class FpIde {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p, EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr SendMessageW(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern bool SetWindowTextW(IntPtr h, string s);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetActiveWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public static string Cls(IntPtr h){ var sb=new StringBuilder(256); GetClassNameW(h,sb,256); return sb.ToString(); }
  public static string Txt(IntPtr h){ var sb=new StringBuilder(1024); GetWindowTextW(h,sb,1024); return sb.ToString(); }
  public static List<IntPtr> Tops(uint target){
    var r=new List<IntPtr>();
    EnumWindows((h,l)=>{ uint pid; GetWindowThreadProcessId(h, out pid); if(pid==target) r.Add(h); return true; }, IntPtr.Zero);
    return r;
  }
  public static List<IntPtr> Kids(IntPtr p){
    var r=new List<IntPtr>();
    EnumChildWindows(p,(h,l)=>{ r.Add(h); return true; }, IntPtr.Zero);
    return r;
  }
  public static IntPtr MainFrame(uint target){
    IntPtr byClass=IntPtr.Zero, biggest=IntPtr.Zero; int bestArea=0;
    EnumWindows((h,l)=>{
      uint pid; GetWindowThreadProcessId(h, out pid);
      if(pid!=target || !IsWindowVisible(h)) return true;
      RECT r; if(!GetWindowRect(h, out r)) return true;
      int a=(r.Right-r.Left)*(r.Bottom-r.Top);
      if(Cls(h)=="Control FPWIN Pro 7") byClass=h;
      if(a>bestArea){ bestArea=a; biggest=h; }
      return true;
    }, IntPtr.Zero);
    return byClass!=IntPtr.Zero ? byClass : biggest;
  }
  public static void Activate(IntPtr h){
    ShowWindow(h, 9); SetForegroundWindow(h); SetActiveWindow(h);
    System.Threading.Thread.Sleep(350);
  }
  public static void Tap(byte vk, int delay){
    keybd_event(vk, 0, 0, UIntPtr.Zero);
    System.Threading.Thread.Sleep(35);
    keybd_event(vk, 0, 2, UIntPtr.Zero);
    System.Threading.Thread.Sleep(delay);
  }
  public static void Chord(byte[] mods, byte key, int delay){
    foreach(var m in mods){ keybd_event(m, 0, 0, UIntPtr.Zero); System.Threading.Thread.Sleep(25); }
    keybd_event(key, 0, 0, UIntPtr.Zero); System.Threading.Thread.Sleep(35);
    keybd_event(key, 0, 2, UIntPtr.Zero);
    for(int i=mods.Length-1;i>=0;i--){ keybd_event(mods[i], 0, 2, UIntPtr.Zero); System.Threading.Thread.Sleep(25); }
    System.Threading.Thread.Sleep(delay);
  }
  public static void ClickButton(IntPtr btn){ SendMessageW(btn, 0x00F5, IntPtr.Zero, IntPtr.Zero); }
  public static bool Visible(IntPtr h){ return IsWindowVisible(h); }
}
'@
if (-not ('FpIde' -as [type])) { Add-Type -TypeDefinition $src -Language CSharp }
try { [void][FpIde]::SetProcessDPIAware() } catch {}

$VK = @{
  'DOWN'=0x28;'UP'=0x26;'LEFT'=0x25;'RIGHT'=0x27;'ENTER'=0x0D;'ESC'=0x1B;'TAB'=0x09;
  'ALT'=0x12;'CTRL'=0x11;'SHIFT'=0x10;'DEL'=0x2E;'F10'=0x79;'SPACE'=0x20
}

function Resolve-Pid([switch]$AllowNoProject) {
  if ($TargetPid -gt 0) { return $TargetPid }
  $procs = @(Get-Process fpwinpro -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 })
  if ($procs.Count -eq 0) { throw 'no FPWIN Pro process with a window' }
  $withProj = @($procs | Where-Object { $_.MainWindowTitle -match '\.pro' })
  if ($withProj.Count -gt 0) { return ($withProj | Select-Object -First 1).Id }
  if ($AllowNoProject.IsPresent) { return ($procs | Select-Object -First 1).Id }
  throw 'FPWIN Pro is running but no project is open'
}

function MainFrame([int]$targetPid) {
  $h = [FpIde]::MainFrame([uint32]$targetPid)
  if ($h -eq [IntPtr]::Zero) { throw "main frame not found for pid $targetPid" }
  return $h
}

function SendKeys([int]$targetPid, [string]$Seq) {
  $frame = MainFrame $targetPid
  [FpIde]::Activate($frame)
  foreach ($tok in ($Seq -split ',')) {
    $t = $tok.Trim().ToUpper()
    if ($t -eq '') { continue }
    if ($t -match '\+') {
      $parts = $t -split '\+'
      $keyName = $parts[-1]
      $mods = @()
      for ($i = 0; $i -lt $parts.Count - 1; $i++) { $mods += [byte]$VK[$parts[$i]] }
      $key = if ($VK.ContainsKey($keyName)) { [byte]$VK[$keyName] } else { [byte][char]$keyName }
      [FpIde]::Chord([byte[]]$mods, [byte]$key, 200)
    } else {
      $k = if ($VK.ContainsKey($t)) { [byte]$VK[$t] } else { [byte][char]$t }
      [FpIde]::Tap([byte]$k, 160)
    }
  }
}

function Get-Dialogs([int]$targetPid) {
  $out = @()
  foreach ($h in [FpIde]::Tops([uint32]$targetPid)) {
    if (-not [FpIde]::Visible($h)) { continue }
    if ([FpIde]::Cls($h) -eq '#32770') {
      $out += [pscustomobject]@{ Hwnd = $h; Title = [FpIde]::Txt($h) }
    }
  }
  return $out
}

function Click-DialogButton([int]$targetPid, [string]$Text) {
  foreach ($d in (Get-Dialogs $targetPid)) {
    foreach ($c in [FpIde]::Kids($d.Hwnd)) {
      if ([FpIde]::Cls($c) -ne 'Button') { continue }
      $ct = [FpIde]::Txt($c)
      if ($ct -like "*$Text*") {
        [FpIde]::ClickButton($c)
        Start-Sleep -Milliseconds 500
        return $ct
      }
    }
  }
  return $null
}

function Dismiss-Dialogs([int]$targetPid, [int]$MaxRounds = 6) {
  $done = @()
  for ($i = 0; $i -lt $MaxRounds; $i++) {
    $d = @(Get-Dialogs $targetPid)
    if ($d.Count -eq 0) { break }
    $clicked = $null
    foreach ($btn in @('确定', '是', '否', '取消', '关闭')) {
      $r = Click-DialogButton $targetPid $btn
      if ($null -ne $r) { $clicked = $r; break }
    }
    if ($null -eq $clicked) { break }
    $done += $clicked
    Start-Sleep -Milliseconds 400
  }
  return $done
}

function Dismiss-UntilProject([int]$Seconds) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    $procs = @(Get-Process fpwinpro -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 })
    foreach ($proc in $procs) {
      foreach ($d in (Get-Dialogs $proc.Id)) {
        foreach ($btn in @('是', '确定', '否', '取消')) {
          $r = Click-DialogButton $proc.Id $btn
          if ($null -ne $r) { break }
        }
        Start-Sleep -Milliseconds 700
      }
      if ($proc.MainWindowTitle -match '\.pro') { return $proc.Id }
    }
    Start-Sleep -Milliseconds 500
  }
  return 0
}

# Wait until a file dialog whose title matches $Pattern appears; returns the dialog object or $null.
function Wait-FileDialog([int]$targetPid, [string]$Pattern, [int]$Seconds = 20) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    foreach ($d in (Get-Dialogs $targetPid)) {
      if ($d.Title -match $Pattern) { return $d }
    }
    Start-Sleep -Milliseconds 400
  }
  return $null
}

function Set-FileDialog($Dlg, [string]$Path, [string]$ConfirmText) {
  $ae = [Windows.Automation.AutomationElement]::FromHandle($Dlg.Hwnd)
  if ($null -eq $ae) { throw 'UIA cannot attach to file dialog' }
  $all = $ae.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition)
  $editHwnd = [IntPtr]::Zero
  $editAe = $null
  foreach ($e in $all) {
    try { if ($e.Current.ControlType -eq [Windows.Automation.ControlType]::Edit) { $editAe = $e; break } } catch {}
  }
  if ($null -ne $editAe) {
    try { $editHwnd = [IntPtr]$editAe.Current.NativeWindowHandle } catch {}
    $ok = $false
    try { $editAe.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).SetValue($Path); $ok = $true } catch { $ok = $false }
    if (-not $ok -and $editHwnd -ne [IntPtr]::Zero) { [void][FpIde]::SetWindowTextW($editHwnd, $Path) }
  }
  if ($editHwnd -eq [IntPtr]::Zero) {
    foreach ($e in $all) {
      try {
        $aid = $e.Current.AutomationId
        if ($aid -match '1148|1001') {
          $h = [IntPtr]$e.Current.NativeWindowHandle
          if ($h -eq [IntPtr]::Zero) { continue }
          foreach ($c in [FpIde]::Kids($h)) {
            if ([FpIde]::Cls($c) -eq 'Edit') { [void][FpIde]::SetWindowTextW($c, $Path); $editHwnd = $c; break }
          }
          if ($editHwnd -eq [IntPtr]::Zero) { [void][FpIde]::SetWindowTextW($h, $Path); $editHwnd = $h }
          if ($editHwnd -ne [IntPtr]::Zero) { break }
        }
      } catch {}
    }
  }
  if ($editHwnd -eq [IntPtr]::Zero) { throw 'filename edit not found in file dialog' }
  Start-Sleep -Milliseconds 300
  $confirm = $null
  foreach ($e in $all) {
    try {
      if ($e.Current.Name -like "$ConfirmText*" -and $e.Current.IsEnabled) { $confirm = $e; break }
    } catch {}
  }
  if ($null -eq $confirm) { throw "confirm button '$ConfirmText' not found" }
  $ch = [IntPtr]::Zero
  try { $ch = [IntPtr]$confirm.Current.NativeWindowHandle } catch {}
  if ($ch -ne [IntPtr]::Zero) {
    [FpIde]::ClickButton($ch)
  } else {
    $confirm.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
  }
  Start-Sleep -Milliseconds 1600
  return $editHwnd
}

switch ($Mode) {
  'uia' {
    $p = Resolve-Pid -AllowNoProject
    foreach ($d in (Get-Dialogs $p)) {
      Write-Output ("DLG|" + $d.Title)
      $ae = [Windows.Automation.AutomationElement]::FromHandle($d.Hwnd)
      if ($null -eq $ae) { continue }
      $all = $ae.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition)
      $n = 0
      foreach ($e in $all) {
        if ($n -ge 50) { break }
        try {
          $ct = $e.Current.ControlType.ProgrammaticName.Replace('ControlType.', '')
          $nm = $e.Current.Name
          if ($nm.Length -gt 60) { $nm = $nm.Substring(0, 60) }
          Write-Output ("  E|" + $ct + "|" + $e.Current.AutomationId + "|off=" + $e.Current.IsOffscreen + "|" + $nm)
        } catch {}
        $n++
      }
    }
    exit 0
  }
  'state' {
    $p = Resolve-Pid -AllowNoProject
    $h = MainFrame $p
    $r = New-Object FpIde+RECT
    [void][FpIde]::GetWindowRect($h, [ref]$r)
    Write-Output ("PID|" + $p + "|RECT|" + $r.Left + "," + $r.Top + "," + $r.Right + "," + $r.Bottom + "|TITLE|" + [FpIde]::Txt($h))
    foreach ($d in (Get-Dialogs $p)) { Write-Output ("DLG|" + $d.Title) }
    exit 0
  }
  'keys' {
    if ($Seq -eq '') { throw 'Seq is required for mode=keys' }
    $p = Resolve-Pid
    SendKeys $p $Seq
    Start-Sleep -Milliseconds $WaitMs
    $h = MainFrame $p
    Write-Output ("KEYS|pid=" + $p + "|seq=" + $Seq + "|title=" + [FpIde]::Txt($h))
    foreach ($d in (Get-Dialogs $p)) {
      Write-Output ("DLG|" + $d.Title)
      foreach ($c in [FpIde]::Kids($d.Hwnd)) {
        if ([FpIde]::Cls($c) -eq 'Button') { Write-Output ("  BTN|" + [FpIde]::Txt($c)) }
      }
    }
    exit 0
  }
  'dialogs' {
    $p = Resolve-Pid -AllowNoProject
    $clicked = Dismiss-Dialogs $p 8
    Write-Output ("DISMISSED|" + ($clicked -join ';'))
    foreach ($d in (Get-Dialogs $p)) { Write-Output ("LEFT|" + $d.Title) }
    exit 0
  }
  'open' {
    if ($Project -eq '') { throw 'Project is required for mode=open' }
    if (-not (Test-Path $Project)) { throw "project not found: $Project" }
    Get-Process fpwinpro -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 800
    Start-Process -FilePath 'D:\FP7752\Mak\fpwinpro.exe' -ArgumentList @($Project) | Out-Null
    Start-Sleep -Seconds 2
    $p2 = Dismiss-UntilProject $TimeoutSec
    if ($p2 -eq 0) {
      Write-Output ("FAILED|project did not open: " + $Project)
      exit 1
    }
    $h = MainFrame $p2
    Write-Output ("OPENED|pid=" + $p2 + "|title=" + [FpIde]::Txt($h))
    exit 0
  }
  'compile' {
    $p = Resolve-Pid
    SendKeys $p 'CTRL+SHIFT+A'
    Start-Sleep -Seconds 2
    $dismissed = Dismiss-Dialogs $p 4
    Start-Sleep -Seconds 2
    Write-Output ("COMPILED|pid=" + $p + "|dialogs=" + ($dismissed -join ';'))
    exit 0
  }
  'save' {
    $p = Resolve-Pid
    SendKeys $p 'CTRL+S'
    Start-Sleep -Seconds 2
    $dismissed = Dismiss-Dialogs $p 4
    Write-Output ("SAVED|pid=" + $p + "|dialogs=" + ($dismissed -join ';'))
    exit 0
  }
  'import' {
    if ($Asc -eq '') { throw 'Asc is required for mode=import' }
    if (-not (Test-Path $Asc)) { throw "asc file not found: $Asc" }
    $p = Resolve-Pid
    SendKeys $p 'ESC,ALT+P,I,O'
    $dlg = Wait-FileDialog $p '导入' 15
    if ($null -eq $dlg) {
      $dismissed = Dismiss-Dialogs $p 4
      Write-Output ("NODIALOG|import file dialog did not appear|dialogs=" + ($dismissed -join ';'))
      exit 1
    }
    [void](Set-FileDialog $dlg $Asc '打开')
    Start-Sleep -Seconds 1
    $dismissed = Dismiss-Dialogs $p 8
    Write-Output ("IMPORTED|pid=" + $p + "|file=" + $Asc + "|dialogs=" + ($dismissed -join ';'))
    exit 0
  }
  'export' {
    if ($Out -eq '') { throw 'Out is required for mode=export' }
    $p = Resolve-Pid
    $hadFile = Test-Path $Out
    SendKeys $p 'ESC,ALT+P,E,P'
    $dlg = $null
    $log = @()
    $deadline = (Get-Date).AddSeconds(45)
    while ((Get-Date) -lt $deadline) {
      $handled = $false
      foreach ($d in (Get-Dialogs $p)) {
        if ($d.Title -match '另存为|导出|保存为|源程序') { $dlg = $d; break }
        if ($d.Title -match '编译|过期|冲突|错误|提示|警告|确认') {
          $t = $d.Title
          $r = Click-DialogButton $p '是'
          if ($null -eq $r) { $r = Click-DialogButton $p '编译全部' }
          if ($null -eq $r) { $r = Click-DialogButton $p '确定' }
          if ($null -eq $r) { $r = Click-DialogButton $p '否' }
          $log += ($t + '=>' + $r)
          $handled = $true
          Start-Sleep -Seconds 4
          break
        }
      }
      if ($null -ne $dlg) { break }
      if (-not $handled) { Start-Sleep -Milliseconds 400 }
    }
    if ($null -eq $dlg) {
      $dismissed = Dismiss-Dialogs $p 4
      Write-Output ("NODIALOG|export save dialog did not appear|chain=" + ($log -join ';') + "|dialogs=" + ($dismissed -join ';'))
      exit 1
    }
    [void](Set-FileDialog $dlg $Out '保存')
    $overwrite = $null
    $waitUntil = (Get-Date).AddSeconds(20)
    while ((Get-Date) -lt $waitUntil) {
      Start-Sleep -Milliseconds 500
      $remaining = @(Get-Dialogs $p)
      if ($remaining.Count -eq 0) { if (Test-Path $Out) { break } else { continue } }
      foreach ($d in $remaining) {
        $t = $d.Title
        $r = Click-DialogButton $p '是'
        if ($null -eq $r) { $r = Click-DialogButton $p '确定' }
        if ($null -eq $r) { $r = Click-DialogButton $p '否' }
        if ($null -ne $r) { $overwrite = ($t + '=>' + $r) }
      }
      if (Test-Path $Out) { Start-Sleep -Milliseconds 800; break }
    }
    if (Test-Path $Out) {
      $len = (Get-Item $Out).Length
      $chain = @($log)
      if ($null -ne $overwrite) { $chain += $overwrite }
      Write-Output ("EXPORTED|pid=" + $p + "|file=" + $Out + "|bytes=" + $len + "|chain=" + ($chain -join ';'))
      exit 0
    }
    Write-Output ("FAILED|file not written|chain=" + ($log -join ';'))
    exit 1
  }
  'close' {
    $p = Resolve-Pid -AllowNoProject
    SendKeys $p 'ALT+F4'
    Start-Sleep -Seconds 1
    $clicked = Dismiss-Dialogs $p 4
    Start-Sleep -Seconds 2
    $alive = $null -ne (Get-Process -Id $p -ErrorAction SilentlyContinue)
    Write-Output ("CLOSED|pid=" + $p + "|stillRunning=" + $alive + "|dialogs=" + ($clicked -join ';'))
    exit 0
  }
}
