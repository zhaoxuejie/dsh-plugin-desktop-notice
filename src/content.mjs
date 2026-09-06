// dsh-plugin-desktop-notice — 通知内容模板（FR-5 / spec §5）
// 所有字段尽力而为：取不到就整段省略，绝不占位、绝不编造。
// 标题 ≤ preview.titleMax、正文 ≤ preview.bodyMax（FR-5.5，系统通知会截断长文本）。

/** @typedef {import("./types.mjs").NoticeEvent} NoticeEvent */
/** @typedef {import("./types.mjs").NoticeContent} NoticeContent */

export const KIND_META = {
  done: { icon: "✅", label: "任务完成" },
  waiting: { icon: "⏸", label: "AI 在等你" },
  error: { icon: "❌", label: "任务失败" },
  heartbeat: { icon: "⏳", label: "任务仍在运行" },
  keyword: { icon: "🔑", label: "关键词命中" },
};

export function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return r ? `${m} 分 ${r} 秒` : `${m} 分钟`;
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}

function trunc(s, n) {
  s = String(s ?? "");
  return s.length > n ? s.slice(0, Math.max(0, n - 1)) + "…" : s;
}

/** 单条通知 → { title, body }。 */
export function buildContent(kind, notice, cfg) {
  const meta = KIND_META[kind] ?? { icon: "🔔", label: "通知" };
  const label = kind === "waiting" && notice.escalated ? "仍在等你" : meta.label;

  let title = `${meta.icon} ${label}`;
  if (notice.project) title += ` · ${notice.project}`;
  if (notice.branch) title += ` (${notice.branch})`;
  title = trunc(title, cfg.preview.titleMax);

  const lines = [];
  if (kind === "waiting") {
    if (notice.detail) lines.push(String(notice.detail));
  } else if (kind === "done") {
    const bits = [];
    if (notice.durationMs != null) bits.push(`耗时 ${fmtDuration(notice.durationMs)}`);
    if (notice.tokens != null) bits.push(`${notice.tokens} tokens`);
    if (bits.length) lines.push(bits.join(" · "));
  } else if (kind === "error") {
    if (notice.durationMs != null) lines.push(`运行 ${fmtDuration(notice.durationMs)}后失败`);
    if (notice.detail) lines.push(String(notice.detail));
  } else if (kind === "heartbeat") {
    if (notice.detail) lines.push(String(notice.detail));
  } else if (kind === "keyword") {
    if (notice.detail) lines.push(String(notice.detail));
  }
  if (notice.summary) lines.push(`“${String(notice.summary)}”`);

  const body = trunc(lines.filter(Boolean).join("\n"), cfg.preview.bodyMax);
  return { title, body };
}

/** 合并通知（F3 防轰炸）→ { title, body }：列出至多 3 条，多于 3 条给计数。 */
export function buildMergedContent(kind, items, cfg) {
  const meta = KIND_META[kind] ?? { icon: "🔔", label: "通知" };
  const noun = kind === "done" ? "个任务完成" : kind === "error" ? "个任务失败" : "个会话在等你";
  const title = trunc(`${meta.icon} ${items.length} ${noun}`, cfg.preview.titleMax);

  const body = items
    .slice(0, 3)
    .map((i) => {
      const head = i.project || i.sessionId || "任务";
      const tail = i.durationMs != null ? ` — ${fmtDuration(i.durationMs)}` : "";
      return `· ${head}${tail}`;
    })
    .join("\n");
  const extra = items.length > 3 ? `\n…等共 ${items.length} 条` : "";
  return { title, body: trunc(body + extra, cfg.preview.bodyMax) };
}
