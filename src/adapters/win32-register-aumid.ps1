# dsh-plugin-desktop-notice — AUMID self-registration (one-time, idempotent)
# Creates a Start Menu shortcut carrying the plugin's own AppUserModelID so Windows
# treats notifications as coming from a registered app ("DSH Desktop Notice") and
# shows banners. Same principle as BurntToast's registration helper.
# Usage: powershell ... -File win32-register-aumid.ps1 -Aumid "DSH.DesktopNotice"
#                              [-ShortcutPath <lnk>] [-TargetPath <exe>] [-IconPath <exe>]
# ASCII-only on purpose: PowerShell 5.1 reads BOM-less UTF-8 as ANSI (breaks param binding).

param(
    [string]$Aumid = "DSH.DesktopNotice",
    [string]$ShortcutPath = "",
    [string]$TargetPath = "",
    [string]$IconPath = ""
)
$ErrorActionPreference = 'Stop'

if (-not $ShortcutPath) {
    $ShortcutPath = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\DSH Desktop Notice.lnk"
}
if (-not $TargetPath) {
    $TargetPath = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
}
if (-not $IconPath) { $IconPath = $TargetPath }

if (Test-Path -LiteralPath $ShortcutPath) {
    Write-Output "already"
    exit 0
}

Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class ToastShortcutRegistration
{
    [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
    private class ShellLinkCom {}

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("000214F9-0000-0000-C000-000000000046")]
    private interface IShellLinkW
    {
        void GetPath([Out] StringBuilder pszFile, int cch, IntPtr pfd, uint fFlags);
        void GetIDList(out IntPtr ppidl);
        void SetIDList(IntPtr pidl);
        void GetDescription([Out] StringBuilder pszName, int cch);
        void SetDescription(string pszName);
        void GetWorkingDirectory([Out] StringBuilder pszDir, int cch);
        void SetWorkingDirectory(string pszDir);
        void GetArguments([Out] StringBuilder pszArgs, int cch);
        void SetArguments(string pszArgs);
        void GetHotkey(out short pwHotkey);
        void SetHotkey(short wHotkey);
        void GetShowCmd(out int piShowCmd);
        void SetShowCmd(int iShowCmd);
        void GetIconLocation([Out] StringBuilder pszIconPath, int cch, out int piIcon);
        void SetIconLocation(string pszIconPath, int iIcon);
        void SetRelativePath(string pszPathRel, uint dwReserved);
        void Resolve(IntPtr hwnd, uint fFlags);
        void SetPath(string pszFile);
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PropertyKey
    {
        public Guid fmtid;
        public uint pid;
        public PropertyKey(Guid fmtid, uint pid) { this.fmtid = fmtid; this.pid = pid; }
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct PropVariant
    {
        [FieldOffset(0)] public ushort vt;
        [FieldOffset(8)] public IntPtr pointerValue;
    }

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
    private interface IPropertyStore
    {
        void GetCount(out uint cProps);
        void GetAt(uint iProp, out PropertyKey key);
        void GetValue(ref PropertyKey key, out PropVariant value);
        void SetValue(ref PropertyKey key, ref PropVariant value);
        void Commit();
    }

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("0000010B-0000-0000-C000-000000000046")]
    private interface IPersistFile
    {
        void GetClassID(out Guid clsid);
        void IsDirty();
        void Load(string fileName, uint mode);
        void Save(string fileName, bool remember);
        void SaveCompleted(string fileName);
        void GetCurFile(out string fileName);
    }

    private static readonly PropertyKey AppUserModelID =
        new PropertyKey(new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), 12);

    public static void Register(string shortcutPath, string aumid, string targetPath, string iconPath)
    {
        IShellLinkW link = (IShellLinkW)(object)new ShellLinkCom();
        link.SetPath(targetPath);
        link.SetArguments("");
        link.SetIconLocation(iconPath, 0);

        var store = (IPropertyStore)link;
        var key = AppUserModelID; // static readonly fields cannot be passed by ref; copy to local
        var pv = new PropVariant();
        pv.vt = 31; // VT_LPWSTR
        pv.pointerValue = Marshal.StringToCoTaskMemUni(aumid);
        try
        {
            store.SetValue(ref key, ref pv);
            store.Commit();
        }
        finally
        {
            Marshal.FreeCoTaskMem(pv.pointerValue);
        }

        ((IPersistFile)link).Save(shortcutPath, true);
    }
}
'@

$dir = Split-Path -Parent $ShortcutPath
if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }

[ToastShortcutRegistration]::Register($ShortcutPath, $Aumid, $TargetPath, $IconPath)
Write-Output "registered: $ShortcutPath (AUMID=$Aumid)"
