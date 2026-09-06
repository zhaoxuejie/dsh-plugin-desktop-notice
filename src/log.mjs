// dsh-plugin-desktop-notice — 极简日志：<DSH_HOME>/data/desktop-notice/notice.log
// debug 全量记录（含每次 spawn 结果），普通模式只记 error；>5MB 粗截断。
// 铁律：日志自身任何失败都必须静默——绝不影响通知与 agent 主流程。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** 插件数据目录（落盘范式：<DSH_HOME>/data/<插件名>/，vault-memory 同款）。 */
export function dataDir() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  return path.join(home, "data", "desktop-notice");
}

export function createLogger({ debug = false } = {}) {
  let debugOn = !!debug;
  let ensured = false;
  const file = path.join(dataDir(), "notice.log");

  function write(level, msg) {
    if (!debugOn && level !== "error") return;
    try {
      if (!ensured) {
        fs.mkdirSync(dataDir(), { recursive: true });
        ensured = true;
      }
      try {
        const st = fs.statSync(file);
        if (st.size > 5 * 1024 * 1024) fs.writeFileSync(file, "");
      } catch { /* 首次不存在 */ }
      fs.appendFileSync(file, `[${new Date().toISOString()}] [${level}] ${msg}\n`);
    } catch { /* 静默 */ }
  }

  return {
    debug: (msg) => write("debug", msg),
    error: (msg) => write("error", msg),
    setDebug(v) { debugOn = !!v; },
  };
}
