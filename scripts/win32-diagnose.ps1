# dsh-plugin-desktop-notice - Windows Toast banner diagnosis
# One-shot checklist that prints every layer that can silently swallow a banner
# while still leaving the toast in Action Center + a playing MCI sound.
#
# Usage:
#   powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File scripts\win32-diagnose.ps1 [-Aumid "DSH.DesktopNotice"]
#
# ASCII-only on purpose: PowerShell 5.1 reads BOM-less UTF-8 as ANSI (breaks param binding).

param([string]$Aumid = "DSH.DesktopNotice")
$ErrorActionPreference = 'Continue'

function Line([string]$k, [object]$v) {
  Write-Output ("{0,-26} {1}" -f $k, $v)
}
function Rule([string]$t) {
  Write-Output ("----- {0} -----" -f $t)
}

Write-Output "=== Windows Toast banner diagnosis ==="

# ---- 1. OS ----
Rule "1. OS"
try {
  $os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
  Line "OS" "$($os.Caption) $($os.Version) build $($os.BuildNumber)"
} catch {
  Line "OS" "query failed: $($_.Exception.Message)"
}

# ---- 2. Start Menu shortcut + AUMID (the #1 cause: no valid .lnk = no banner) ----
Rule "2. App identity (shortcut AUMID)"
$lnk = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\DSH Desktop Notice.lnk"
Line "ShortcutPath" $lnk
if (Test-Path -LiteralPath $lnk) {
  Line "ShortcutExists" "yes"
  try {
    $shell = New-Object -ComObject Shell.Application
    $folder = $shell.Namespace((Split-Path -Parent $lnk))
    $item = $folder.ParseName((Split-Path -Leaf $lnk))
    $onDisk = [string]$item.ExtendedProperty("System.AppUserModel.ID")
    Line "ShortcutAumid" ("'{0}'" -f $onDisk)
    Line "AumidMatches" $(if ($onDisk -eq $Aumid) { "YES" } else { "NO  <-- banner will NOT show" })
  } catch {
    Line "ShortcutAumid" "read failed: $($_.Exception.Message)"
  }
} else {
  Line "ShortcutExists" "NO  <-- banner will NOT show"
}

# ---- 3. WinRT notification setting (own AUMID + PowerShell fallback) ----
Rule "3. ToastNotifier Setting"
try {
  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  $ownSetting = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($Aumid).Setting
  Line "Setting(own AUMID)" $ownSetting
  $psAumid = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
  $psSetting = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($psAumid).Setting
  Line "Setting(powershell)" $psSetting
  Line "Enabled expected" "Enabled (anything else = disabled)"
} catch {
  Line "WinRT load" "failed: $($_.Exception.Message)"
}

# ---- 4. Notification platform services ----
Rule "4. Notification services (Wpn*)"
$wpn = Get-Service -ErrorAction SilentlyContinue | Where-Object { $_.Name -like 'Wpn*' -or $_.Name -like '*PushNotification*' }
if ($wpn) {
  $wpn | ForEach-Object { Line ("svc:" + $_.Name) $_.Status }
} else {
  Line "svc" "no Wpn* service found"
}

# ---- 5. Registry notification settings ----
Rule "5. Registry settings"
$nk = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Notifications\Settings"
$toastEnabled = (Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\PushNotifications" -Name ToastEnabled -ErrorAction SilentlyContinue).ToastEnabled
Line "ToastEnabled(global)" $(if ($null -eq $toastEnabled) { "n/a" } else { $toastEnabled })
$globalToasts = (Get-ItemProperty $nk -Name NOC_GLOBAL_SETTING_TOASTS_ENABLED -ErrorAction SilentlyContinue).NOC_GLOBAL_SETTING_TOASTS_ENABLED
Line "GlobalToastsEnabled" $(if ($null -eq $globalToasts) { "n/a" } else { $globalToasts })

$appKey = Join-Path $nk $Aumid
if (Test-Path $appKey) {
  $p = Get-ItemProperty $appKey
  Line "App.Enabled" $p.Enabled
  Line "App.ShowInActionCenter" $p.ShowInActionCenter
} else {
  Line "AppSettings" "not present yet (created on first toast)"
}

# ---- 6. Fire one real toast with the OWN AUMID, then check history ----
Rule "6. Live toast + history"
try {
  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
  $xmlText = "<toast activationType=""foreground"" scenario=""default""><visual><binding template=""ToastGeneric""><text>DSH diagnose test</text><text>Banner visible = toast rendering works.</text></binding></visual><audio silent=""true""/></toast>"
  $doc = New-Object Windows.Data.Xml.Dom.XmlDocument
  $doc.LoadXml($xmlText)
  $toast = New-Object Windows.UI.Notifications.ToastNotification($doc)
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($Aumid).Show($toast)
  Start-Sleep -Milliseconds 800
  $history = @([Windows.UI.Notifications.ToastNotificationManager]::History.GetHistory($Aumid))
  Line "HistoryCount" $history.Count
  Line "Verdict" "count >= 1 = toast delivered to center; watch bottom-right for the banner"
} catch {
  Line "Live toast" "failed: $($_.Exception.Message)"
}

Rule "7. Manual checks (WinRT cannot see these)"
Write-Output "  - Focus Assist / Do Not Disturb ON silences the banner but NOT this plugin's MCI sound"
Write-Output "    (sound path is independent of the toast). Check Quick Settings -> focus assist."
Write-Output "  - Banner setting per app: Settings -> Notifications -> 'DSH Desktop Notice' -> banners ON."
Write-Output "  - If all green and still no banner: press Win+Shift+S (screenshot). If that banner"
Write-Output "    is missing too, the toast *rendering layer* is broken (sfc /scannow, or reboot)."
