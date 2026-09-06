// dsh-plugin-desktop-notice — 勿扰时段判定（FR-4.3，M2）
// 纯函数、零副作用：跨午夜时段（end <= start）按次日计算。

/**
 * @param {Date} date 本地时间
 * @param {Array<{days: number[], start: string, end: string}>} schedule
 * @returns {boolean} 当前是否处于任一勿扰时段
 */
export function inSchedule(date, schedule) {
  if (!Array.isArray(schedule) || schedule.length === 0) return false;
  const minutes = date.getHours() * 60 + date.getMinutes();
  const day = date.getDay() === 0 ? 7 : date.getDay(); // JS 周日=0 → 转 1-7（周一=1）
  for (const rule of schedule) {
    if (!rule || !Array.isArray(rule.days) || !rule.days.includes(day)) continue;
    const [sh, sm] = String(rule.start ?? "0:0").split(":").map(Number);
    const [eh, em] = String(rule.end ?? "0:0").split(":").map(Number);
    if (![sh, sm, eh, em].every(Number.isFinite)) continue;
    const s = sh * 60 + sm;
    const e = eh * 60 + em;
    if (s === e) continue; // 零长度时段视为无效
    if (s < e) {
      if (minutes >= s && minutes < e) return true;
    } else {
      // 跨午夜：22:00-08:30 → [22:00,24:00) ∪ [0:00,08:30)
      if (minutes >= s || minutes < e) return true;
    }
  }
  return false;
}
