# dsh-plugin-desktop-notice — foreground window title + user notification state (single spawn)
# Output: single-line JSON {"fgTitle":"...","quns":<int>}
# QUNS: 1=NOT_PRESENT 2=BUSY 3=RUNNING_APP(fullscreen) 4=HIDDEN 5=APP (SHQueryUserNotificationState)
# ASCII-only on purpose: PowerShell 5.1 reads BOM-less UTF-8 as ANSI.
param()
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class Win32FocusProbe {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("shell32.dll")] public static extern int SHQueryUserNotificationState();
}
'@

$h = [Win32FocusProbe]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 512
$null = [Win32FocusProbe]::GetWindowText($h, $sb, 512)
$title = $sb.ToString()
$quns = [Win32FocusProbe]::SHQueryUserNotificationState()

@{ fgTitle = $title; quns = $quns } | ConvertTo-Json -Compress
