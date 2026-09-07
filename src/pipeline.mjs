// dsh-plugin-desktop-notice — 通知管线（M1+M2+M3）
// F1 总开关 → F2 事件开关 → F5 前台 → F6 全屏 → F7 勿扰时段 → F3 合并节流 → F4 渐进提醒/心跳 → 渲染分发
// waiting 默认豁免 F5/F6/F7（FR-4：阻塞在烧用户时间）；被抑制的通知进汇总队列（FR-4.6）。
// 渲染通道：toast / sound(或 TTS) / push 互不阻塞；sideEffects 承接历史落盘与统计。
// now/schedule/cancel/focus 可注入，供单测驱动时钟与焦点判定（test/*.test.mjs）。

import { buildContent, buildMergedContent } from "./content.mjs";
import { inSchedule } from "./filters/dnd.mjs";

/**
 * @typedef {import("./types.mjs").NoticeEvent} NoticeEvent
 * @typedef {import("./types.mjs").NoticeContent} NoticeContent
 */

/**
 * @param {Object} deps
 * @param {() => object} getConfig
 * @param {object} adapter 平台适配器（probe 产物，含 notify/play）
 * @param {object=} tts    TTS 实例（cfg.tts 开启时替代音效）
 * @param {object=} push   推送实例（按分级路由外发）
 * @param {object} log
 * @param {() => number} [now]
 * @param {(fn: Function, ms: number) => any} [schedule]
 * @param {(handle: any) => void} [cancel]
 * @param {{foregroundMatched: (matches: string[]) => Promise<boolean>,
 *          isFullscreen: () => Promise<boolean>}} [focus] 平台焦点判定（注入便于测试）
 * @param {{onDelivered?: Function, onSuppressed?: Function}} [sideEffects] 历史/统计钩子
 */
export function createPipeline({
  getConfig, adapter, tts, push, log,
  now = () => Date.now(),
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancel = (h) => clearTimeout(h),
  focus = { foregroundMatched: async () => false, isFullscreen: async () => false },
  sideEffects = {},
}) {
  /** @type {Map<string, { items: NoticeEvent[], endsAt: number, timer: any }>} kind → 合并窗口 */
  const windows = new Map();
  /** @type {Map<string, any>} sessionKey → 渐进提醒 timer */
  const escalations = new Map();
  /** @type {Map<string, any>} sessionKey → 心跳 timer */
  const heartbeats = new Map();
  /** @type {Array<{ kind: string, notice: NoticeEvent, reason: string }>} 勿扰/焦点抑制汇总队列 */
  const suppressed = [];
  let disposed = false;
  const MAX_SUPPRESSED = 100; // 汇总队列上限：长期勿扰/全屏时避免内存无限增长

  const withContent = (kind, n) => ({ ...n, content: buildContent(kind, n, getConfig()) });

  const safe = (fn, tag) => Promise.resolve().then(fn).catch((e) => { log.error(`${tag}: ${e?.message ?? e}`); return { ok: false }; });

  /** 渲染分发：toast / sound(或TTS) / push 互不阻塞；结果交 sideEffects（历史/统计）。 */
  async function dispatch(kind, notice, channelOverride = null) {
    let result = { toast: null, sound: null, push: null };
    try {
      const cfg = getConfig();
      const ev = channelOverride ?? cfg.events[kind] ?? { desktop: true, sound: "off" };
      const jobs = [];
      if (ev.desktop) {
        const scenario = kind === "waiting" || kind === "heartbeat" ? "reminder" : "default";
        jobs.push(
          safe(() => adapter.notify({ ...notice.content, scenario, sessionKey: notice.sessionKey ?? "" }), "toast 通道异常")
            .then((r) => { result.toast = r; return r; }),
        );
      }
      if (cfg.tts && tts) {
        jobs.push(safe(() => tts.speak(ttsText(kind, notice)), "tts 通道异常").then((r) => { result.sound = r; return r; }));
      } else if (ev.sound && ev.sound !== "off") {
        jobs.push(
          safe(() => adapter.play(ev.sound, cfg.volume), "sound 通道异常")
            .then((r) => { result.sound = r; return r; }),
        );
      }
      await Promise.allSettled(jobs);
      if (push && cfg.push?.provider && cfg.push.provider !== "off" && cfg.push.kinds?.includes(kind)) {
        result.push = await safe(() => push.sendFor(kind, notice), "push 通道异常");
      }
      log.debug(`[dispatch] ${kind}${notice.escalated ? "(escalated)" : ""} ${JSON.stringify(result)}`);
      try { sideEffects.onDelivered?.(kind, notice, result); } catch (e) { log.error(`onDelivered: ${e?.message ?? e}`); }
    } catch (e) {
      log.error(`dispatch 异常: ${e?.message ?? e}`);
    }
    return result;
  }

  /** TTS 播报文本：事件文案 + 项目 + 耗时，≤60 字（spec §7）。 */
  function ttsText(kind, notice) {
    const meta = { done: "任务完成", waiting: "AI 在等你", error: "任务失败", heartbeat: "任务仍在运行", keyword: "关键词命中" }[kind] ?? "通知";
    const bits = [meta];
    if (notice.project) bits.push(notice.project);
    if (notice.durationMs != null) {
      const m = Math.round(notice.durationMs / 60000);
      if (m >= 1) bits.push(`耗时约 ${m} 分钟`);
    }
    return bits.join("，").slice(0, 60);
  }

  /** F4 渐进提醒（仅 waiting）：N 分钟未处理 → 强提醒重发一次。 */
  function armEscalation(notice) {
    const cfg = getConfig();
    resetWaiting(notice.sessionKey);
    if (!cfg.escalateWaitingMinutes) return;
    const timer = schedule(async () => {
      escalations.delete(notice.sessionKey);
      if (disposed) return;
      const n = { ...notice, escalated: true };
      await dispatch("waiting", withContent("waiting", n));
    }, cfg.escalateWaitingMinutes * 60000);
    escalations.set(notice.sessionKey, timer);
  }

  /** FR-1.4 心跳（M2）：turn/start 起计时，超阈值弹一次，此后每 repeatMinutes 最多一次。 */
  function turnStarted(sessionKey, project) {
    try {
      disarmHeartbeat(sessionKey);
      const cfg = getConfig();
      const ev = cfg.events.heartbeat;
      if (!ev || ev.thresholdSeconds <= 0 || (!ev.desktop && (!ev.sound || ev.sound === "off"))) return;
      let count = 0;
      const rearm = () => {
        const n = count;
        const timer = schedule(() => {
          if (disposed) return;
          count += 1;
          admit("heartbeat", {
            kind: "heartbeat", sessionId: sessionKey, sessionKey, project,
            detail: n === 0 ? `已运行超过 ${Math.round(ev.thresholdSeconds / 60)} 分钟` : `仍在运行（第 ${count} 次提醒）`,
          });
          rearm();
        }, (n === 0 ? ev.thresholdSeconds : ev.repeatMinutes * 60) * 1000);
        heartbeats.set(sessionKey, timer);
      };
      rearm();
    } catch (e) {
      log.error(`turnStarted 异常: ${e?.message ?? e}`);
    }
  }

  function turnEnded(sessionKey) {
    disarmHeartbeat(sessionKey);
  }

  function disarmHeartbeat(sessionKey) {
    const t = heartbeats.get(sessionKey);
    if (t) {
      cancel(t);
      heartbeats.delete(sessionKey);
    }
  }

  /** F3 窗口到点：缓冲 1 条原样补发，多条合并。 */
  function flush(kind) {
    const w = windows.get(kind);
    windows.delete(kind);
    if (disposed || !w || w.items.length === 0) return;
    try {
      const items = w.items;
      if (items.length === 1) {
        dispatch(kind, withContent(kind, items[0]));
        if (kind === "waiting") armEscalation(items[0]);
      } else {
        dispatch(kind, { kind, sessionId: "", sessionKey: "", content: buildMergedContent(kind, items, getConfig()) });
      }
    } catch (e) {
      log.error(`flush 异常: ${e?.message ?? e}`);
    }
  }

  /** 被抑制通知入队（FR-4.6）；原因与条目一并交给 sideEffects（历史留痕）。 */
  function suppress(kind, notice, reason) {
    if (suppressed.length >= MAX_SUPPRESSED) {
      const dropped = suppressed.shift(); // 队列满丢弃最旧（内存上限优先于逐条补发）
      log.debug(`[suppressed] 队列已满，丢弃最旧 ${dropped?.kind}（${dropped?.reason}）`);
    }
    suppressed.push({ kind, notice, reason });
    try { sideEffects.onSuppressed?.(kind, notice, reason); } catch (e) { log.error(`onSuppressed: ${e?.message ?? e}`); }
    log.debug(`[suppressed] ${kind} ← ${reason}（队列 ${suppressed.length}）`);
  }

  /** F8 汇总：按 kind 分组合并补发（时段结束 / 回到前台 / 用户发言时触发）。 */
  function flushSuppressed() {
    if (disposed || suppressed.length === 0) return;
    if (!getConfig().dnd?.summaryOnExit) { suppressed.length = 0; return; }
    const items = suppressed.splice(0);
    const cfg = getConfig();
    for (const kind of [...new Set(items.map((i) => i.kind))]) {
      const group = items.filter((i) => i.kind === kind);
      if (group.length === 1) {
        dispatch(kind, withContent(kind, group[0].notice));
        if (kind === "waiting") armEscalation(group[0].notice);
      } else {
        dispatch(kind, { kind, sessionId: "", sessionKey: "", content: buildMergedContent(kind, group.map((g) => g.notice), cfg) });
      }
    }
  }

  /** 管线入口。 */
  async function admit(kind, notice) {
    try {
      const cfg = getConfig();
      const dnd = cfg.dnd ?? {};
      if (!cfg.enabled) return;                                                          // F1
      const ev = cfg.events[kind];
      if (!ev || (!ev.desktop && (!ev.sound || ev.sound === "off") && kind !== "heartbeat")) return; // F2

      // 队列非空且当前环境已恢复（不在勿扰/非全屏/未匹配前台）→ 先汇总（FR-4.6 ①②）
      if (suppressed.length > 0) {
        const [fg, fs] = await Promise.all([focus.foregroundMatched(dnd.clientWindowMatch ?? []), focus.isFullscreen()]);
        if (!fg && !fs && !inSchedule(new Date(now()), dnd.schedule)) flushSuppressed();
      }

      // F5/F6/F7 防打扰（waiting 豁免，FR-4：阻塞在烧用户时间）
      const exempt = kind === "waiting" && dnd.exemptWaiting;
      let soundOnly = false;
      if (!exempt) {
        if (dnd.suppressWhenFocused !== "off") {
          const fg = await focus.foregroundMatched(dnd.clientWindowMatch ?? []);
          if (fg) {
            if (dnd.suppressWhenFocused === "sound-only") soundOnly = true;
            else return suppress(kind, notice, "foreground");
          }
        }
        if (!soundOnly && dnd.fullscreenSilent && (await focus.isFullscreen())) return suppress(kind, notice, "fullscreen");
        if (!soundOnly && inSchedule(new Date(now()), dnd.schedule)) return suppress(kind, notice, "dnd");
      }

      const channelOverride = soundOnly ? { desktop: false, sound: ev.sound } : null;

      if (cfg.mergeWindowSeconds > 0) {                                                  // F3
        const t = now();
        let w = windows.get(kind);
        if (!w || t >= w.endsAt) {
          w = {
            items: [],
            endsAt: t + cfg.mergeWindowSeconds * 1000,
            timer: schedule(() => flush(kind), cfg.mergeWindowSeconds * 1000),
          };
          windows.set(kind, w);
          dispatch(kind, withContent(kind, notice), channelOverride);                    // 窗口首条立即发
          if (kind === "waiting" && !soundOnly) armEscalation(notice);
          return;
        }
        w.items.push(notice);
        return;
      }

      dispatch(kind, withContent(kind, notice), channelOverride);
      if (kind === "waiting" && !soundOnly) armEscalation(notice);
    } catch (e) {
      log.error(`admit 异常: ${e?.message ?? e}`);
    }
  }

  function resetWaiting(sessionKey) {
    const t = escalations.get(sessionKey);
    if (t) {
      cancel(t);
      escalations.delete(sessionKey);
    }
  }

  function dispose() {
    disposed = true;
    for (const w of windows.values()) cancel(w.timer);
    windows.clear();
    for (const t of escalations.values()) cancel(t);
    escalations.clear();
    for (const t of heartbeats.values()) cancel(t);
    heartbeats.clear();
    suppressed.length = 0;
  }

  function snapshotHealth() {
    return {
      windows: [...windows.keys()],
      pendingEscalations: escalations.size,
      heartbeats: heartbeats.size,
      suppressed: suppressed.length,
    };
  }

  return { admit, dispatch, resetWaiting, flushSuppressed, turnStarted, turnEnded, dispose, snapshotHealth };
}
