// dsh-plugin-desktop-notice — Windows Toast 横幅诊断入口
// 用法：npm run diagnose:win [-- Aumid]
// 本质是 spawn win32-diagnose.ps1 并把 stdout 透传（诊断脚本会自己输出检查清单）。
// 单独成脚本是为了：不依赖 DSH 运行、不经过插件管线，直接对系统做最底层探测。

import { spawn } from "node:child_process";
import path from "node:path";
import url from "node:url";

const DIR = path.dirname(url.fileURLToPath(import.meta.url));
const PS1 = path.join(DIR, "win32-diagnose.ps1");
const POWERSHELL = path.join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32", "WindowsPowerShell", "v1.0", "powershell.exe",
);

const aumid = process.argv[2] ?? "DSH.DesktopNotice";

const child = spawn(
  POWERSHELL,
  ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-STA", "-WindowStyle", "Hidden", "-File", PS1, "-Aumid", aumid],
  { windowsHide: true, stdio: ["ignore", "inherit", "inherit"] },
);

child.on("error", (e) => {
  console.error(`[diagnose] 无法启动 PowerShell: ${e?.message ?? e}`);
  process.exitCode = 1;
});

child.on("exit", (code) => {
  console.error(`[diagnose] 退出码 ${code}`);
  process.exitCode = code ?? 0;
});
