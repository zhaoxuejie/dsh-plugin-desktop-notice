// dsh-plugin-desktop-notice — Linux 适配器（M3，尽力而为，spec §6）
// Toast：notify-send（freedesktop 标准）；Sound：paplay → canberra-gtk-play 后备。
// 不做：前台/全屏检测（无统一 API，默认关）、点击聚焦、三态样式（仅标题/正文/紧急度）。
// 无通知守护进程（无头/WSL）→ probe 阶段降级（FR-2.6）。

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export function createLinuxAdapter({ assetsDir, log }) {
  let consecutiveFailures = 0;

  function run(cmd, args, timeoutMs = 5000) {
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

  async function notify({ title, body, scenario = "default", sessionKey = "" }) {
    if (consecutiveFailures >= 3) return { ok: false, skipped: "circuit" };
    // waiting/error 用 critical（长驻）；其余 normal
    const urgency = scenario === "reminder" || title.includes("失败") ? "critical" : "normal";
    const r = await run("notify-send", [String(title ?? ""), String(body ?? ""), "-u", urgency, "-a", "DSH"]);
    if (r.ok) consecutiveFailures = 0;
    else {
      consecutiveFailures += 1;
      log.error(`notify-send 失败: ${r.error}（连续 ${consecutiveFailures} 次）`);
    }
    return r;
  }

  async function play(sound, volume) {
    if (!sound || sound === "off") return { ok: false, skipped: "off" };
    const file = path.isAbsolute(sound) ? sound : path.join(assetsDir, `${sound}.wav`);
    if (!fs.existsSync(file)) return { ok: false, error: "wav missing" };
    let r = await run("paplay", [file]);
    if (!r.ok) r = await run("canberra-gtk-play", ["-f", file]);
    if (!r.ok) log.error(`linux 播放失败: ${r.error}`);
    return r;
  }

  return { id: "linux", notify, play };
}
