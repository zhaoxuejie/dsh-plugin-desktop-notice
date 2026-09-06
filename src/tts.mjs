// dsh-plugin-desktop-notice — TTS 语音播报（FR-10，M3，默认关）
// win32：System.Speech（系统自带、离线）；darwin：say；linux：不做。
// 开启 TTS 的事件不再播放 wav（管线里互斥，spec §7）。

import { spawn } from "node:child_process";
import { POWERSHELL } from "./adapters/win32.mjs";

export function createTts({ log }) {
  async function run(cmd, args, timeoutMs = 15000) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (r) => { if (!settled) { settled = true; resolve(r); } };
      let child;
      try {
        child = spawn(cmd, args, { windowsHide: true, stdio: "ignore" });
      } catch (e) {
        done({ ok: false, error: String(e?.message ?? e) });
        return;
      }
      const timer = setTimeout(() => { try { child.kill(); } catch { /* 已退出 */ } done({ ok: false, error: "timeout" }); }, timeoutMs);
      child.on("error", (e) => { clearTimeout(timer); done({ ok: false, error: String(e?.message ?? e) }); });
      child.on("exit", (code) => { clearTimeout(timer); done(code === 0 ? { ok: true } : { ok: false, error: `exit ${code}` }); });
    });
  }

  /** 播报文本（≤60 字，管线负责截断）。失败静默。 */
  async function speak(text) {
    const safe = String(text ?? "").slice(0, 60).replace(/["\r\n]/g, " ");
    if (!safe) return { ok: false, skipped: "empty" };
    if (process.platform === "win32") {
      const script = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Volume = 80; $s.Speak("${safe}")`;
      return run(POWERSHELL, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-STA", "-WindowStyle", "Hidden", "-Command", script]);
    }
    if (process.platform === "darwin") {
      return run("/usr/bin/say", [safe]);
    }
    return { ok: false, skipped: "unsupported" };
  }

  return { speak };
}
