// dsh-plugin-desktop-notice — 平台探测（FR-2.6）：启动时一次，结果缓存，选定适配器。
// 顺序：win32 → darwin → linux → noop。toast 能力初始 'unknown'，由首条真实 Toast 的成败落定。

import fs from "node:fs";
import { createNoopAdapter } from "./noop.mjs";
import { createWin32Adapter, POWERSHELL } from "./win32.mjs";
import { createDarwinAdapter, OSASCRIPT, AFPLAY } from "./darwin.mjs";
import { createLinuxAdapter } from "./linux.mjs";

const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };

export function probe({ assetsDir, log }) {
  if (process.platform === "win32" && exists(POWERSHELL)) {
    return {
      id: "win32",
      // 无会话名 → 疑似服务/无头环境；M1 起不据此禁用，交给首条 Toast 实测与降级链
      headless: !process.env.SESSIONNAME,
      capabilities: { toast: "unknown", sound: true },
      degraded: [],
      adapter: createWin32Adapter({ assetsDir, log }),
    };
  }

  if (process.platform === "darwin" && exists(OSASCRIPT) && exists(AFPLAY)) {
    return {
      id: "darwin",
      headless: false,
      capabilities: { toast: "unknown", sound: true },
      degraded: [],
      adapter: createDarwinAdapter({ assetsDir, log }),
    };
  }

  if (process.platform === "linux") {
    const notifySend = ["/usr/bin/notify-send", "/usr/local/bin/notify-send"].find(exists);
    if (notifySend) {
      return {
        id: "linux",
        headless: false,
        capabilities: { toast: "unknown", sound: true },
        degraded: [],
        adapter: createLinuxAdapter({ assetsDir, log }),
      };
    }
    const reason = "未找到 notify-send（无头/精简系统？），已降级为仅日志";
    log.error(reason);
    return { id: "noop", headless: true, capabilities: { toast: false, sound: false }, degraded: [reason], adapter: createNoopAdapter(reason) };
  }

  const reason = `平台 ${process.platform} 暂不支持，已降级为仅日志`;
  log.error(reason);
  return { id: "noop", headless: false, capabilities: { toast: false, sound: false }, degraded: [reason], adapter: createNoopAdapter(reason) };
}
