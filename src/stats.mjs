// dsh-plugin-desktop-notice — 统计聚合（FR-9.2，M3）
// stats.json：按天累计 { done, waiting, error, keyword, aiRunMs, waitedMs }，滚动保留 90 天。
// 招牌指标："今天 AI 等了你 X 分钟"（waitedMs）。写入失败静默。

import fs from "node:fs";
import path from "node:path";

const KEEP_DAYS = 90;

export function createStats({ dir, log, now = () => Date.now() }) {
  const file = path.join(dir, "stats.json");
  /** @type {Map<string, {done:number,waiting:number,error:number,keyword:number,aiRunMs:number,waitedMs:number}>} day → 计数 */
  const days = new Map();
  let loaded = false;

  function ensure() {
    if (loaded) return;
    loaded = true;
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      for (const [day, v] of Object.entries(raw ?? {})) days.set(day, v);
    } catch { /* 首次/损坏 → 从零开始 */ }
  }

  function persist() {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const cutoff = now() - KEEP_DAYS * 86400000;
      for (const [day] of days) {
        if (new Date(`${day}T00:00:00`).getTime() < cutoff) days.delete(day);
      }
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(days), null, 2));
      fs.renameSync(tmp, file);
    } catch (e) {
      log.error(`stats persist: ${e?.message ?? e}`);
    }
  }

  function today() {
    ensure();
    const day = new Date(now()).toISOString().slice(0, 10);
    if (!days.has(day)) days.set(day, { done: 0, waiting: 0, error: 0, keyword: 0, aiRunMs: 0, waitedMs: 0 });
    return { day, cell: days.get(day) };
  }

  return {
    record(kind) {
      try {
        const { cell } = today();
        if (cell[kind] != null) cell[kind] += 1;
        persist();
      } catch (e) { log.error(`stats record: ${e?.message ?? e}`); }
    },

    /** AI 运行时长（turn 累计，仅完成的 turn）。 */
    recordRun(ms) {
      try {
        if (!Number.isFinite(ms) || ms <= 0) return;
        today().cell.aiRunMs += ms;
        persist();
      } catch (e) { log.error(`stats recordRun: ${e?.message ?? e}`); }
    },

    /** 等待时长（approval asked→decided 累计）。 */
    recordWait(ms) {
      try {
        if (!Number.isFinite(ms) || ms <= 0) return;
        today().cell.waitedMs += ms;
        persist();
      } catch (e) { log.error(`stats recordWait: ${e?.message ?? e}`); }
    },

    /** 浮卡展示：今日计数 + 时长（分钟取整）。 */
    snapshot() {
      const { day, cell } = today();
      return {
        day,
        ...cell,
        aiRunMinutes: Math.round(cell.aiRunMs / 60000),
        waitedMinutes: Math.round(cell.waitedMs / 60000),
      };
    },
  };
}
