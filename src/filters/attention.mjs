// dsh-plugin-desktop-notice — 焦点/全屏判定（FR-4.1 / FR-4.2，M2）
// 结果短 TTL 缓存（spec §3.5：10s），避免高频 spawn；query 由平台适配器提供。
// 平台无检测能力（darwin 全屏、linux）时 query 返回空 → 判定 false（宁多弹不漏弹）。

export function createAttention({ query, ttlMs = 10000, now = () => Date.now() }) {
  let cache = null;
  let failures = 0;          // 连续失败计数：探测脚本异常（如崩溃）时熔断，避免反复拉起
  let backoffUntil = 0;

  async function state() {
    if (cache && now() - cache.at < ttlMs) return cache;
    if (now() < backoffUntil) return cache ?? { at: 0, fgTitle: "", quns: 0 };
    let raw = null;
    try {
      raw = query ? await query() : null;
    } catch {
      raw = null;
    }
    if (raw == null) {
      failures += 1;
      if (failures >= 3) backoffUntil = now() + 5 * 60000; // 连续 3 次失败 → 熔断 5 分钟
    } else {
      failures = 0;
    }
    cache = { at: now(), fgTitle: raw?.fgTitle ?? "", quns: raw?.quns ?? 0 };
    return cache;
  }

  return {
    /** DSH 客户端窗口是否处于前台（标题命中任一子串）。 */
    async foregroundMatched(matches) {
      if (!query || !Array.isArray(matches) || matches.length === 0) return false;
      const s = await state();
      const title = String(s.fgTitle ?? "").toLowerCase();
      return matches.some((m) => title.includes(String(m).toLowerCase()));
    },
    /** 是否全屏/繁忙（SHQueryUserNotificationState：BUSY=2、RUNNING_APP=3）。 */
    async isFullscreen() {
      if (!query) return false;
      const s = await state();
      return s.quns === 2 || s.quns === 3;
    },
  };
}
