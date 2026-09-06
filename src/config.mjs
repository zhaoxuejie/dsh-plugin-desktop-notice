// dsh-plugin-desktop-notice — 设置 schema（schemastery）+ 默认值归并
// M1+M2+M3 全量字段（docs/phase1|2|3-interface-spec.md）。
// 唯一 import schemastery 的模块之一（其余模块零依赖）。

import Schema from "schemastery";

const eventCfg = (sound) =>
  Schema.object({
    /** 是否弹桌面 Toast */
    desktop: Schema.boolean().default(true),
    /** 音效：内置三选一 / 关闭 */
    sound: Schema.union(["success", "notice", "alert", "off"]).default(sound),
  });

export const configSchema = Schema.object({
  enabled: Schema.boolean().default(true),

  events: Schema.object({
    done: eventCfg("success"),
    waiting: eventCfg("notice"),
    error: eventCfg("alert"),
    /** 长任务心跳（FR-1.4，M2）：超过 thresholdSeconds 弹一次，此后每 repeatMinutes 最多一次 */
    heartbeat: Schema.object({
      desktop: Schema.boolean().default(true),
      sound: Schema.union(["success", "notice", "alert", "off"]).default("off"),
      thresholdSeconds: Schema.number().min(0).max(86400).default(600),
      repeatMinutes: Schema.number().min(1).max(240).default(10),
    }),
    /** 关键词命中（FR-1.6，M3）：keywords 非空时生效 */
    keyword: eventCfg("notice"),
  }),

  /** 关键词列表（FR-1.6）：输出命中即提醒；空数组 = 关闭 */
  keywords: Schema.array(Schema.string()).default([]),

  /** 预览长度（FR-5.5：系统通知会截断长文本） */
  preview: Schema.object({
    titleMax: Schema.number().min(10).max(64).default(40),
    bodyMax: Schema.number().min(40).max(300).default(120),
  }),

  /** 防轰炸合并窗口（秒）；0 = 关闭（FR-4.4） */
  mergeWindowSeconds: Schema.number().min(0).max(120).default(10),
  /** 等待输入渐进提醒（分钟）；0 = 关闭（FR-4.5） */
  escalateWaitingMinutes: Schema.number().min(0).max(60).default(5),
  /** 音效音量 0-100 */
  volume: Schema.number().min(0).max(100).default(60),

  /** 防打扰引擎（FR-4，M2） */
  dnd: Schema.object({
    /** DSH 客户端在前台时：skip=完全静默 / sound-only=只响音效 / off=不检测 */
    suppressWhenFocused: Schema.union(["skip", "sound-only", "off"]).default("skip"),
    /** 前台窗口标题命中任一子串即视为"用户正在看 DSH" */
    clientWindowMatch: Schema.array(Schema.string()).default(["DSH", "DeepSeek"]),
    fullscreenSilent: Schema.boolean().default(true),
    /** 勿扰时段（支持跨午夜）：days 1-7（周一=1） */
    schedule: Schema.array(
      Schema.object({
        days: Schema.array(Schema.number()).default([1, 2, 3, 4, 5, 6, 7]),
        start: Schema.string().default("22:00"),
        end: Schema.string().default("08:30"),
      }),
    ).default([]),
    /** 等待输入豁免勿扰（阻塞在烧用户时间，默认也要提醒） */
    exemptWaiting: Schema.boolean().default(true),
    /** 退出勿扰/回到前台时合并汇总被抑制的通知（FR-4.6） */
    summaryOnExit: Schema.boolean().default(true),
  }),

  /** 通知历史落盘（FR-9.1，M2） */
  history: Schema.object({
    enabled: Schema.boolean().default(true),
    keepDays: Schema.number().min(1).max(365).default(30),
    maxLines: Schema.number().min(50).max(100000).default(1000),
  }),

  /** 多通道推送（FR-7，M3）：默认全关；kinds 控制分级路由 */
  push: Schema.object({
    provider: Schema.union(["off", "bark", "ntfy", "webhook"]).default("off"),
    endpoint: Schema.string().default(""),
    headers: Schema.any().default({}),
    token: Schema.string().default(""),
    kinds: Schema.array(Schema.string()).default(["waiting", "error"]),
  }),

  /** TTS 语音播报（FR-10，M3）：开启后替代音效 */
  tts: Schema.boolean().default(false),

  debug: Schema.boolean().default(false),
});

export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  events: {
    done: { desktop: true, sound: "success" },
    waiting: { desktop: true, sound: "notice" },
    error: { desktop: true, sound: "alert" },
    heartbeat: { desktop: true, sound: "off", thresholdSeconds: 600, repeatMinutes: 10 },
    keyword: { desktop: true, sound: "notice" },
  },
  keywords: [],
  preview: { titleMax: 40, bodyMax: 120 },
  mergeWindowSeconds: 10,
  escalateWaitingMinutes: 5,
  volume: 60,
  dnd: {
    suppressWhenFocused: "skip",
    clientWindowMatch: ["DSH", "DeepSeek"],
    fullscreenSilent: true,
    schedule: [],
    exemptWaiting: true,
    summaryOnExit: true,
  },
  history: { enabled: true, keepDays: 30, maxLines: 1000 },
  push: { provider: "off", endpoint: "", headers: {}, token: "", kinds: ["waiting", "error"] },
  tts: false,
  debug: false,
});

/** 两层深合并（数组/标量整体替换），把 settings 解析结果归一为普通对象。 */
function merge(defaults, src) {
  const out = { ...defaults };
  for (const k of Object.keys(src ?? {})) {
    const d = defaults?.[k];
    const s = src[k];
    if (d && typeof d === "object" && !Array.isArray(d) && s && typeof s === "object" && !Array.isArray(s)) {
      out[k] = merge(d, s);
    } else if (s !== undefined) {
      out[k] = s;
    }
  }
  return out;
}

export function resolveConfig(raw) {
  return merge(DEFAULT_CONFIG, raw && typeof raw === "object" ? raw : {});
}
