// dsh-plugin-desktop-notice — 事件订阅与归一化（M1+M2+M3）
// 主力：session/event（emit 广播，监听器失败被宿主隔离，被动安全——calibration §1.1）。
// done/error ← turn/end(reason)；waiting ← approval/asked；心跳 ← turn/start 驱动；
// 等待耗时 ← approval asked→decided 差值；关键词 ← assistant/chunk(text-delta，校准 §1.2)。
// agent/request-error 不订阅弹窗（waterfall + 重试语义——calibration R2）。
// user-questions/request 瀑布的透传安全性未校准（calibration §4#5），不启用。

/** @typedef {import("./types.mjs").NoticeEvent} NoticeEvent */

const textOf = (m) => {
  try {
    const c = m?.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) return c.map((b) => (typeof b === "string" ? b : b?.text ?? "")).join("");
    return c?.text ?? "";
  } catch { return ""; }
};

const tokensOf = (u) => {
  try { return u?.output_tokens ?? u?.output ?? u?.completion_tokens ?? null; } catch { return null; }
};

const errText = (f) => {
  try {
    if (!f) return "";
    if (typeof f === "string") return f;
    return f.message ?? JSON.stringify(f);
  } catch { return ""; }
};

/**
 * @param {object} ctx 宿主上下文
 * @param {object} hooks
 * @param {(kind: string, notice: object) => void} hooks.onNotice     归一化完成 → 管线
 * @param {(sessionKey: string) => void} hooks.onWaitingReset        等待复位 → 管线
 * @param {(sessionKey: string, project?: string) => void} hooks.onTurnStart    心跳计时起点
 * @param {(sessionKey: string, durationMs: number|null) => void} hooks.onTurnEnd 心跳终止 + 运行时长统计
 * @param {(ms: number) => void} hooks.onWaitSpan                    "AI 等了你"统计（asked→decided）
 * @param {(sessionKey: string, project: string|undefined, text: string) => void} hooks.onChunk 关键词数据源
 * @param {() => void} hooks.onUserPresent                           用户发言 → 勿扰汇总触发
 * @param {object} hooks.log
 * @returns {() => void} 清理函数
 */
export function subscribe(ctx, hooks) {
  /** @type {Map<string, number>} sessionId → turn 开始时间 */
  const turnStart = new Map();
  /** @type {Map<string, { summary: string, tokens: number | null }>} */
  const lastAssistant = new Map();
  /** @type {Set<string>} approval/asked id 去重 */
  const askedSeen = new Set();
  /** @type {Map<string, number>} sessionId → approval asked 时间（等待耗时统计） */
  const askedAt = new Map();

  const projectOf = (session) => {
    // 校准 §4#2 未落定前的兜底链：常见字段尽力而为，取不到就缺省
    try {
      return session?.project ?? session?.workspace?.name ?? session?.cwd ?? undefined;
    } catch { return undefined; }
  };

  const offSessionEvent = ctx.on("session/event", (session, event) => {
    try {
      const sid = String(session?.id ?? "");
      const project = projectOf(session);
      switch (event?.type) {
        case "turn/start":
          turnStart.set(sid, event.time);
          hooks.onTurnStart(sid, project);
          hooks.onWaitingReset(sid); // 新一轮开始 = 旧等待已有结果
          break;

        case "assistant/message": {
          const text = String(textOf(event.data?.message) ?? "").trim();
          if (text) {
            lastAssistant.set(sid, { summary: text.slice(0, 300), tokens: tokensOf(event.data?.usage) });
          }
          break;
        }

        case "assistant/chunk": {
          // FR-1.6 关键词数据源（text-delta 变体携带增量文本，calibration §1.2）
          const chunk = event.data?.chunk;
          if (chunk?.type === "text-delta" && chunk.text) {
            hooks.onChunk(sid, project, String(chunk.text));
          }
          break;
        }

        case "user/message":
          hooks.onWaitingReset(sid);
          hooks.onUserPresent(); // 用户发言 = 回来了 → 勿扰汇总触发
          break;

        case "approval/asked": {
          const id = String(event.data?.id ?? "");
          if (askedSeen.has(id)) break;
          askedSeen.add(id);
          if (askedSeen.size > 500) askedSeen.clear();
          if (Number.isFinite(event.time)) askedAt.set(sid, event.time);
          const detail = [event.data?.toolName, event.data?.reason].filter(Boolean).join(" · ");
          hooks.onNotice("waiting", {
            kind: "waiting", sessionId: sid, sessionKey: sid, project,
            detail: detail || "需要你的确认", raw: event.data,
          });
          break;
        }

        case "approval/decided": {
          const asked = askedAt.get(sid);
          askedAt.delete(sid);
          if (Number.isFinite(asked) && Number.isFinite(event.time) && event.time > asked) {
            try { hooks.onWaitSpan(event.time - asked); } catch { /* 统计失败不影响通知 */ }
          }
          hooks.onWaitingReset(sid);
          break;
        }

        case "turn/end": {
          const start = turnStart.get(sid);
          turnStart.delete(sid);
          const durationMs = Number.isFinite(start) && Number.isFinite(event.time) ? event.time - start : null;
          const last = lastAssistant.get(sid) ?? {};
          lastAssistant.delete(sid);
          hooks.onTurnEnd(sid, durationMs);
          const reasonKind = event.data?.reason?.kind;

          if (reasonKind === "completed" || reasonKind === "max-tokens") {
            hooks.onNotice("done", {
              kind: "done", sessionId: sid, sessionKey: sid, project, durationMs,
              tokens: last.tokens, summary: last.summary,
              detail: reasonKind === "max-tokens" ? "达到输出 token 上限" : undefined,
              raw: event.data,
            });
          } else if (reasonKind === "error") {
            hooks.onNotice("error", {
              kind: "error", sessionId: sid, sessionKey: sid, project, durationMs,
              detail: errText(event.data?.reason?.error), raw: event.data,
            });
          }
          // blocked / aborted / interrupted：不通知（blocked 与 approval/asked 重叠）
          break;
        }

        default:
          break;
      }
    } catch (e) {
      hooks.log.error(`session/event 处理异常: ${e?.message ?? e}`);
    }
  });

  const offs = [offSessionEvent];
  try {
    offs.push(ctx.on("session/disposed", (session) => {
      const sid = String(session?.id ?? "");
      turnStart.delete(sid);
      lastAssistant.delete(sid);
      askedAt.delete(sid);
      hooks.onTurnEnd(sid, null);
      hooks.onWaitingReset(sid);
    }));
  } catch { /* 事件不可用时忽略 */ }

  return () => offs.forEach((off) => { try { off?.(); } catch { /* 静默 */ } });
}
