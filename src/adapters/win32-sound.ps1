# dsh-plugin-desktop-notice — wav 播放：MCI（winmm，可编程音量 0-1000）→ SoundPlayer 后备（无音量控制）
# 用法：powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File win32-sound.ps1 -WavPath <wav> -Volume <0..1000>
param([string]$WavPath = "", [int]$Volume = 600)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $WavPath)) { throw "wav not found: $WavPath" }

$mciOk = $false
try {
  if (-not ('MciWin' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class MciWin {
  [DllImport("winmm.dll", CharSet = CharSet.Auto)]
  public static extern int mciSendString(string command, System.Text.StringBuilder buffer, int bufferSize, IntPtr hwndCallback);
}
'@
  }
  $sb = New-Object System.Text.StringBuilder 256
  $r = [MciWin]::mciSendString('open "' + $WavPath + '" type waveaudio alias dshnotice', $sb, 256, [IntPtr]::Zero)
  if ($r -eq 0) {
    $null = [MciWin]::mciSendString('setaudio dshnotice volume to ' + $Volume, $sb, 256, [IntPtr]::Zero)
    $null = [MciWin]::mciSendString('play dshnotice wait', $sb, 256, [IntPtr]::Zero)
    $null = [MciWin]::mciSendString('close dshnotice', $sb, 256, [IntPtr]::Zero)
    $mciOk = $true
  }
} catch { $mciOk = $false }

if (-not $mciOk) {
  $sp = New-Object System.Media.SoundPlayer($WavPath)
  $sp.PlaySync()
}
