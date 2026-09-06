// dsh-plugin-desktop-notice — macOS 适配器（M2，spec §7）
// Toast：osascript（参数走 args 数组，不经 shell 拼接）；Sound：afplay（自带音量 0-2，mp3 亦支持）。
// 系统专注模式天然兜底，插件勿扰在该平台做减法。

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const OSASCRIPT = "/usr/bin/osascript";
export const AFPLAY = "/usr/bin/afplay";

function runCmd(cmd, args, timeoutMs = 5000) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    let child;
    try {
      child = spawn(cmd, args, { stdio: "ignore" });
    } catch (e) {
      done({ ok: false, error: String(e?.message ?? e) });
      return;
    }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* 已退出 */ } done({ ok: false, error: "timeout" }); }, timeoutMs);
    child.on("error", (e) => { clearTimeout(timer); done({ ok: false, error: String(e?.message ?? e) }); });
    child.on("exit", (code) => { clearTimeout(timer); done(code === 0 ? { ok: true } : { ok: false, error: `exit ${code}` }); });
  });
}

/** AppleScript 字符串转义：仅去除会破坏字面量的引号/反斜杠（内容安全优先于保真）。 */
const asEsc = (s) => String(s ?? "").replace(/["\\]/g, "");

export function createDarwinAdapter({ assetsDir, log }) {
  let consecutiveFailures = 0;

  async function notify({ title, body, scenario = "default", sessionKey = "" }) {
    if (consecutiveFailures >= 3) return { ok: false, skipped: "circuit" };
    // reminder 场景在 macOS 无对应概念 → 用 subtitle 承载"在等你"语义
    const script = scenario === "reminder"
      ? `display notification "${asEsc(body)}" with title "${asEsc(title)}" subtitle "AI 在等你"`
      : `display notification "${asEsc(body)}" with title "${asEsc(title)}"`;
    const r = await runCmd(OSASCRIPT, ["-e", script]);
    if (r.ok) consecutiveFailures = 0;
    else {
      consecutiveFailures += 1;
      log.error(`osascript 失败: ${r.error}（连续 ${consecutiveFailures} 次）`);
    }
    return r;
  }

  async function play(sound, volume) {
    if (!sound || sound === "off") return { ok: false, skipped: "off" };
    const file = path.isAbsolute(sound) ? sound : path.join(assetsDir, `${sound}.wav`);
    if (!fs.existsSync(file)) {
      log.error(`音效文件不存在: ${file}`);
      return { ok: false, error: "wav missing" };
    }
    // afplay 音量区间 0-2（1 为原声）
    const r = await runCmd(AFPLAY, [file, "-v", String(Math.max(0, Math.min(2, volume / 50)))]);
    if (!r.ok) log.error(`afplay 失败: ${r.error}`);
    return r;
  }

  /** 前台应用名（spec §7；供 attention 判定）。失败返回空。 */
  async function queryFocus() {
    try {
      const out = await new Promise((resolve) => {
        let child;
        let buf = "";
        try {
          child = spawn(OSASCRIPT, ["-e", 'tell application "System Events" to name of first application process whose frontmost is true'], { stdio: ["ignore", "pipe", "ignore"] });
        } catch { resolve(""); return; }
        child.stdout?.on("data", (d) => { buf += String(d); });
        const timer = setTimeout(() => { try { child.kill(); } catch { /* 已退出 */ } resolve(buf); }, 3000);
        child.on("error", () => { clearTimeout(timer); resolve(buf); });
        child.on("exit", () => { clearTimeout(timer); resolve(buf); });
      });
      return { fgTitle: String(out ?? "").trim(), quns: 5 }; // quns=5(APP)：macOS 全屏检测不实现（系统专注模式兜底）
    } catch {
      return { fgTitle: "", quns: 0 };
    }
  }

  return { id: "darwin", focusQuery: queryFocus, notify, play };
}
