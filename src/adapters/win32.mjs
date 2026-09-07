// dsh-plugin-desktop-notice — Windows 适配器：Toast（WinRT 内联）+ wav 音效（MCI 音量 → SoundPlayer 后备）
// spawn 防护（FR-2.5 / spec §6.2）：同一会话 1s 去重、超时 5s kill、连续 3 次失败熔断。
// payload 走临时 JSON 文件而非命令行参数，规避引号/注入问题（spec §6.2）。

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";

const DIR = path.dirname(url.fileURLToPath(import.meta.url));
const TOAST_PS1 = path.join(DIR, "win32-toast.ps1");
const SOUND_PS1 = path.join(DIR, "win32-sound.ps1");
const REGISTER_PS1 = path.join(DIR, "win32-register-aumid.ps1");

export const POWERSHELL = path.join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32", "WindowsPowerShell", "v1.0", "powershell.exe",
);

export const AUMID_POWERSHELL = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";
/** 插件自有应用身份：注册后通知源显示为"DSH Desktop Notice"，横幅行为不借用 PowerShell。 */
export const AUMID_OWN = "DSH.DesktopNotice";

const MAX_CONSECUTIVE_FAILURES = 3;
const SPAWN_TIMEOUT_MS = 5000;

/** spawn PowerShell，resolve { ok, error? }；绝不 reject、绝不抛出。导出供焦点探测复用。 */
export function runPowerShell(script, args) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    let child;
    try {
      child = spawn(
        POWERSHELL,
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-STA", "-WindowStyle", "Hidden", "-File", script, ...args],
        { windowsHide: true, stdio: "ignore" },
      );
    } catch (e) {
      done({ ok: false, error: String(e?.message ?? e) });
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 已退出 */ }
      done({ ok: false, error: "timeout" });
    }, SPAWN_TIMEOUT_MS);
    child.on("error", (e) => { clearTimeout(timer); done({ ok: false, error: String(e?.message ?? e) }); });
    child.on("exit", (code) => { clearTimeout(timer); done(code === 0 ? { ok: true } : { ok: false, error: `exit ${code}` }); });
  });
}

/** spawn PowerShell 并捕获 stdout（焦点探测用，超时 3s）。失败/超时 resolve null。 */
export function runPowerShellCapture(script, args, timeoutMs = 3000) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    let child;
    let out = "";
    try {
      child = spawn(
        POWERSHELL,
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-STA", "-WindowStyle", "Hidden", "-File", script, ...args],
        { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
      );
    } catch {
      done(null);
      return;
    }
    child.stdout?.on("data", (d) => { out += String(d); });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* 已退出 */ } done(null); }, timeoutMs);
    child.on("error", () => { clearTimeout(timer); done(null); });
    child.on("exit", (code) => { clearTimeout(timer); done(code === 0 ? out : null); });
  });
}

export function createWin32Adapter({ assetsDir, log }) {
  let consecutiveFailures = 0;
  let lastSpawnBySession = new Map(); // sessionKey → 最近 toast 时间戳（per-session 1s 去重，FR-2.5）
  let toastConfirmed = false; // 首条成功 = toast 能力实测确认（probe 的 'unknown' 落定）
  let registered = false;     // 自有 AUMID 是否注册成功
  let registrationPromise = null;

  /** 一次性注册自有应用身份（开始菜单快捷方式 + AUMID）；幂等，失败回退 PowerShell 身份。 */
  function ensureRegistered() {
    if (!registrationPromise) {
      registrationPromise = runPowerShell(REGISTER_PS1, ["-Aumid", AUMID_OWN]).then((r) => {
        registered = r.ok;
        if (r.ok) log.debug(`AUMID 注册成功：${AUMID_OWN}`);
        else log.error(`AUMID 注册失败，回退 PowerShell 身份: ${r.error}`);
        return r.ok;
      });
    }
    return registrationPromise;
  }

  /** 弹 Toast。content: { title, body }，scenario: 'default' | 'reminder'（waiting 长驻）。 */
  async function notify({ title, body, scenario = "default", sessionKey = "" }) {
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      return { ok: false, skipped: "circuit" };
    }
    const now = Date.now();
    const last = lastSpawnBySession.get(sessionKey) ?? 0;
    if (now - last < 1000) return { ok: false, skipped: "dedupe" };
    lastSpawnBySession.set(sessionKey, now);
    // 惰性清理过期桶，避免 Map 随 session 数量无限增长
    if (lastSpawnBySession.size > 512) {
      for (const [k, v] of lastSpawnBySession) {
        if (now - v >= 1000) lastSpawnBySession.delete(k);
      }
    }

    await ensureRegistered(); // 幂等；失败时 registered=false → 回退旧身份
    const aumid = registered ? AUMID_OWN : AUMID_POWERSHELL;

    const payloadPath = path.join(os.tmpdir(), `dsh-notice-${process.pid}-${now}.json`);
    try {
      fs.writeFileSync(payloadPath, JSON.stringify({ title, body, scenario, aumid }), "utf8");
    } catch (e) {
      consecutiveFailures += 1;
      log.error(`payload 写入失败: ${e?.message ?? e}`);
      return { ok: false, error: "payload write failed" };
    }

    const r = await runPowerShell(TOAST_PS1, ["-PayloadPath", payloadPath]);
    try { fs.unlinkSync(payloadPath); } catch { /* 清理失败无害 */ }

    if (r.ok) {
      consecutiveFailures = 0;
      toastConfirmed = true;
    } else {
      consecutiveFailures += 1;
      log.error(`toast spawn 失败: ${r.error}（连续 ${consecutiveFailures} 次）`);
    }
    // 带上实际使用的身份，供 health / test / smoke 暴露「own vs PowerShell 回退」，
    // 便于定位「只进通知中心、不弹横幅」——回退 PowerShell AUMID 正是典型病因。
    return { ...r, aumid };
  }

  /** 播放音效。sound: 'success'|'notice'|'alert'（内置）或绝对路径（自定义，P1 开放）；volume: 0-100。 */
  async function play(sound, volume) {
    if (!sound || sound === "off") return { ok: false, skipped: "off" };
    const file = path.isAbsolute(sound) ? sound : path.join(assetsDir, `${sound}.wav`);
    if (!fs.existsSync(file)) {
      log.error(`音效文件不存在: ${file}`);
      return { ok: false, error: "wav missing" };
    }
    const r = await runPowerShell(SOUND_PS1, ["-WavPath", file, "-Volume", String(Math.round((volume / 100) * 1000))]);
    if (!r.ok) log.error(`音效播放失败: ${r.error}`);
    return r;
  }

  return {
    id: "win32",
    get toastConfirmed() { return toastConfirmed; },
    get registered() { return registered; },
    notify,
    play,
  };
}
