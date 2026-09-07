// dsh-plugin-desktop-notice — 通知历史落盘（FR-9.1，M2）
// history.jsonl：一行一条 JSON；启动时计数、每 append 惰性滚动清理（keepDays / maxLines）。
// 落盘失败静默（只记插件日志），绝不影响通知主链路。

import fs from "node:fs";
import path from "node:path";

export function createHistory({ dir, getConfig, log, now = () => Date.now() }) {
  let file = path.join(dir, "history.jsonl");
  let lineCount = 0;
  let counted = false;
  let rolledDay = "";

  function ensure() {
    fs.mkdirSync(dir, { recursive: true });
    if (!counted) {
      try {
        lineCount = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).length;
      } catch { lineCount = 0; }
      counted = true;
    }
  }

  /** 滚动清理：按行数截断 + 按天数删除（启动/跨天/每 200 条触发）。 */
  function rotate() {
    try {
      const cfg = getConfig().history;
      if (lineCount > cfg.maxLines) {
        const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim());
        const keep = lines.slice(Math.floor(lines.length / 2)); // 对半保留，避免频繁重写
        fs.writeFileSync(file, keep.join("\n") + (keep.length ? "\n" : ""));
        lineCount = keep.length;
        log.debug(`history 滚动：保留 ${keep.length} 条`);
      }
      const day = new Date(now()).toISOString().slice(0, 10);
      if (day !== rolledDay) {
        rolledDay = day;
        const cutoff = now() - cfg.keepDays * 86400000;
        const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim());
        const keep = lines.filter((l) => {
          try { return JSON.parse(l).time >= cutoff; } catch { return false; }
        });
        if (keep.length !== lines.length) {
          fs.writeFileSync(file, keep.join("\n") + (keep.length ? "\n" : ""));
          lineCount = keep.length;
          log.debug(`history 过期清理：保留 ${keep.length} 条`);
        }
      }
    } catch (e) {
      log.error(`history rotate: ${e?.message ?? e}`);
    }
  }

  return {
    /** entry: { kind, sessionId, project, title, delivered, suppressed }，time 自动补。 */
    append(entry) {
      try {
        if (!getConfig().history.enabled) return;
        ensure();
        const line = JSON.stringify({ time: now(), ...entry });
        fs.appendFileSync(file, line + "\n");
        lineCount += 1;
        // rotate 幂等：行数截断仅在超限时读文件、天数清理仅在跨天时读文件，故每次都调用
        // 以确保 keepDays 跨天清理及时触发（不依赖"每 200 条"这一偶然节奏）。
        rotate();
      } catch (e) {
        log.error(`history append: ${e?.message ?? e}`);
      }
    },

    /** 供 M3 路由/浮卡查询：最近 limit 条（新在前）。 */
    readRecent(limit = 50) {
      try {
        ensure();
        const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim());
        return lines.slice(-limit).reverse().map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      } catch (e) {
        log.error(`history read: ${e?.message ?? e}`);
        return [];
      }
    },
  };
}
