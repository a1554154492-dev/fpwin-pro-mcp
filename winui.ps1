param(
  [Parameter(Mandatory = $true)][ValidateSet('list', 'click', 'menus', 'cmd', 'tree')][string]$Mode,
  [Parameter(Mandatory = $true)][int]$TargetPid,
  [string]$Button = '',
  [int]$CommandId = 0,
  [string]$MenuPath = '',
  [string]$Text = '',
  [int]$MaxDepth = 6
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

$src = @'
using System;using System.Text;using System.Collections.Generic;using System.Runtime.InteropServices;
public class FpWinUi2 {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern bool EnumChildWindows(IntPtr p, EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessageW(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern bool PostMessageW(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern IntPtr GetMenu(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetSubMenu(IntPtr menu, int pos);
  [DllImport("user32.dll")] public static extern int GetMenuItemCount(IntPtr menu);
  [DllImport("user32.dll")] public static extern uint GetMenuItemID(IntPtr menu, int pos);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetMenuStringW(IntPtr menu, uint item, StringBuilder sb, int max, uint flags);
  [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetWindowTextW(IntPtr h, string s);

  public static string Txt(IntPtr h){ var sb=new StringBuilder(4096); GetWindowTextW(h,sb,4096); return sb.ToString(); }
  public static string Cls(IntPtr h){ var sb=new StringBuilder(256); GetClassNameW(h,sb,256); return sb.ToString(); }
  public static List<IntPtr> Tops(uint target){
    var r=new List<IntPtr>();
    EnumWindows((h,l)=>{ uint pid; GetWindowThreadProcessId(h, out pid); if(pid==target) r.Add(h); return true; }, IntPtr.Zero);
    return r;
  }
  public static List<IntPtr> Descendants(IntPtr top){
    var r=new List<IntPtr>();
    EnumChildWindows(top,(c,l)=>{ r.Add(c); return true; }, IntPtr.Zero);
    return r;
  }
  public static List<string> MenuDump(IntPtr menu, int depth, int maxDepth){
    var r=new List<string>();
    if(menu==IntPtr.Zero || depth>maxDepth) return r;
    int n=GetMenuItemCount(menu);
    for(int i=0;i<n;i++){
      uint id=GetMenuItemID(menu,i);
      var sb=new StringBuilder(512); GetMenuStringW(menu,(uint)i,sb,512,0x400);
      string txt=sb.ToString().Replace("&","");
      if(txt.Length==0 && id==0xFFFFFFFF) continue;
      r.Add("MENU|"+depth+"|"+i+"|"+id+"|"+txt);
      IntPtr sub=GetSubMenu(menu,i);
      if(sub!=IntPtr.Zero) r.AddRange(MenuDump(sub,depth+1,maxDepth));
    }
    return r;
  }
}
'@
if (-not ('FpWinUi2' -as [type])) { Add-Type -TypeDefinition $src -Language CSharp }

$BM_CLICK = 0x00F5
$WM_COMMAND = 0x0111
$WM_SETTEXT = 0x000C

function Get-Tops { return @([FpWinUi2]::Tops([uint32]$TargetPid)) }

function Find-MainFrame {
  foreach ($h in Get-Tops) {
    $m = [FpWinUi2]::GetMenu($h)
    if ($m -ne [IntPtr]::Zero) { return $h }
  }
  return [IntPtr]::Zero
}

if ($Mode -eq 'list') {
  foreach ($h in Get-Tops) {
    $cls = [FpWinUi2]::Cls($h)
    $vis = if ([FpWinUi2]::IsWindowVisible($h)) { '1' } else { '0' }
    $topText = [FpWinUi2]::Txt($h) -replace "`r`n", ' / ' -replace "`n", ' / '
    $text = $topText
    if ($cls -eq '#32770') {
      $parts = @()
      foreach ($c in [FpWinUi2]::Descendants($h)) {
        if ([FpWinUi2]::Cls($c) -eq 'Static') {
          $ct = [FpWinUi2]::Txt($c) -replace "`r`n", ' / ' -replace "`n", ' / '
          if ($ct.Length -gt 0) { $parts += $ct }
        }
      }
      if ($parts.Count -gt 0) { $text = $topText + ' :: ' + ($parts -join ' | ') }
    }
    Write-Output ("WIN|" + $cls + "|" + $vis + "|" + $text)
  }
  exit 0
}

if ($Mode -eq 'menus') {
  $frame = Find-MainFrame
  if ($frame -eq [IntPtr]::Zero) { Write-Output 'NOMAINFRAME'; exit 1 }
  Write-Output ("FRAME|" + [FpWinUi2]::Cls($frame) + "|" + [FpWinUi2]::Txt($frame))
  foreach ($line in [FpWinUi2]::MenuDump([FpWinUi2]::GetMenu($frame), 0, $MaxDepth)) { Write-Output $line }
  exit 0
}

if ($Mode -eq 'tree') {
  foreach ($h in Get-Tops) {
    $cls = [FpWinUi2]::Cls($h)
    $vis = if ([FpWinUi2]::IsWindowVisible($h)) { '1' } else { '0' }
    Write-Output ("TOP|" + $cls + "|" + $vis + "|" + [FpWinUi2]::Txt($h))
    foreach ($c in [FpWinUi2]::Descendants($h)) {
      $cc = [FpWinUi2]::Cls($c)
      $ct = [FpWinUi2]::Txt($c) -replace "`r`n", ' / ' -replace "`n", ' / '
      $id = [FpWinUi2]::GetDlgCtrlID($c)
      $v = if ([FpWinUi2]::IsWindowVisible($c)) { '1' } else { '0' }
      if ($ct.Length -gt 200) { $ct = $ct.Substring(0, 200) }
      Write-Output ("CTL|" + $cc + "|" + $id + "|" + $v + "|" + $ct)
    }
  }
  exit 0
}

if ($Mode -eq 'click') {
  $clicked = $false
  foreach ($h in Get-Tops) {
    if ([FpWinUi2]::Cls($h) -ne '#32770') { continue }
    foreach ($c in [FpWinUi2]::Descendants($h)) {
      if ([FpWinUi2]::Cls($c) -ne 'Button') { continue }
      $ct = [FpWinUi2]::Txt($c)
      $match = ($Button -eq '') -or ($ct -eq $Button) -or ($ct -like "*$Button*")
      if (-not $match) { continue }
      [void][FpWinUi2]::SendMessageW($c, $BM_CLICK, [IntPtr]::Zero, [IntPtr]::Zero)
      Write-Output ("CLICKED|" + $ct)
      $clicked = $true
      break
    }
    if ($clicked) { break }
  }
  if (-not $clicked) { Write-Output 'NOBUTTON' }
  exit 0
}

if ($Mode -eq 'cmd') {
  $frame = Find-MainFrame
  if ($frame -eq [IntPtr]::Zero) { Write-Output 'NOMAINFRAME'; exit 1 }
  $id = $CommandId
  if ($id -eq 0 -and $MenuPath -ne '') {
    $want = $MenuPath
    foreach ($line in [FpWinUi2]::MenuDump([FpWinUi2]::GetMenu($frame), 0, $MaxDepth)) {
      $p = $line -split '\|'
      if ($p.Count -ge 5 -and $p[4] -eq $want -and $p[3] -ne '4294967295') { $id = [int]$p[3]; break }
    }
  }
  if ($id -eq 0) { Write-Output 'NOCOMMAND'; exit 1 }
  [void][FpWinUi2]::PostMessageW($frame, $WM_COMMAND, [IntPtr]$id, [IntPtr]::Zero)
  Write-Output ("POSTED|" + $id + "|" + [FpWinUi2]::Cls($frame))
  exit 0
}
