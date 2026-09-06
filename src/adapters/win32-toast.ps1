# dsh-plugin-desktop-notice — Windows 原生 Toast（WinRT 内联，零第三方依赖）
# 用法：powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File win32-toast.ps1 -PayloadPath <json>
# payload: { title, body, scenario: 'default'|'reminder', aumid }
# 说明：audio silent —— 声音由独立通道（win32-sound.ps1）控制，不交给系统默认音（spec §6.2）。
param([string]$PayloadPath = "")
$ErrorActionPreference = 'Stop'
$payload = Get-Content -Raw -Encoding UTF8 -LiteralPath $PayloadPath | ConvertFrom-Json

[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null

function Esc([string]$s) { [System.Security.SecurityElement]::Escape($s) }
$scenario = if ($payload.scenario -eq 'reminder') { 'reminder' } else { 'default' }
$xmlText = "<toast activationType=""foreground"" scenario=""$scenario"">" +
  "<visual><binding template=""ToastGeneric"">" +
  "<text>$(Esc $payload.title)</text>" +
  "<text>$(Esc $payload.body)</text>" +
  "</binding></visual>" +
  "<audio silent=""true""/></toast>"

$doc = New-Object Windows.Data.Xml.Dom.XmlDocument
$doc.LoadXml($xmlText)
$toast = New-Object Windows.UI.Notifications.ToastNotification($doc)
$aumid = if ($payload.aumid) { $payload.aumid } else { '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe' }
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($aumid).Show($toast)
