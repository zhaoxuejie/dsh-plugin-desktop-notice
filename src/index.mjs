// dsh-plugin-desktop-notice — 插件入口（M1+M2+M3）
// 契约参照 dsh-plugin-vault-memory（已真机验证）：
//   export const name / inject / Config + export function apply(ctx, entryConfig)
//   settings.register(name, Config, { applies: "live", base }) → scope.get()/watch() 热更新
// 铁律：apply 内任何初始化失败 → 降级（noop 适配器 / 入口配置兜底），绝不 throw 出 apply。

import path from "node:path";
import url from "node:url";
import { configSchema, resolveConfig } from "./config.mjs";
import { createLogger, dataDir } from "./log.mjs";
import { probe } from "./adapters/probe.mjs";
import { createPipeline } from "./pipeline.mjs";
import { createAttention } from "./filters/attention.mjs";
import { createHistory } from "./history.mjs";
import { createStats } from "./stats.mjs";
import { createKeywords } from "./keywords.mjs";
import { createPush } from "./push.mjs";
import { createTts } from "./tts.mjs";
import { subscribe } from "./events.mjs";
import { registerRoutes } from "./server.mjs";
import { registerNotifySendTool } from "./tools/notify-send.mjs";

export const name = "dsh-plugin-desktop-notice";
// cordis 语义：ctx.tools 属性访问要求服务在 inject 中声明（否则抛 "without inject"）；
// webServer 走 ctx.get() 不需要 inject（vault-memory 真机先例）。
export const inject = ["settings", "tools"];
export const Config = configSchema;
export const version = "0.2.1";

export function apply(ctx, entryConfig) {
  const log = createLogger({ debug: false });
  const assetsDir = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..", "assets");
  const dir = dataDir();
  const runtime = { cfg: resolveConfig(entryConfig), probe: null, pipeline: null };

  // --- 平台探测（FR-2.6）：选定适配器；焦点判定由适配器提供（win32/darwin 有，linux 无） ---
  try {
    runtime.probe = probe({ assetsDir, log });
    log.debug(`probe → ${runtime.probe.id} capabilities=${JSON.stringify(runtime.probe.capabilities)} headless=${runtime.probe.headless}`);
  } catch (e) {
    log.error(`probe 失败，通知已降级为仅日志: ${e?.message ?? e}`);
  }
  const adapter = runtime.probe
    ? runtime.probe.adapter
    : { id: "noop", async notify() { return { ok: false, skipped: "noop" }; }, async play() { return { ok: false, skipped: "noop" }; } };

  // --- 焦点判定（F5/F6；结果 TTL 缓存在模块内） ---
  const attention = createAttention({ query: adapter.focusQuery, log });

  // --- 历史 / 统计（FR-9） ---
  runtime.history = createHistory({ dir, getConfig: () => runtime.cfg, log });
  runtime.stats = createStats({ dir, log });

  // --- 推送 / TTS（FR-7 / FR-10） ---
  const push = createPush({ getConfig: () => runtime.cfg, log });
  const tts = createTts({ log });

  // --- 管线 ---
  runtime.pipeline = createPipeline({
    getConfig: () => runtime.cfg,
    adapter,
    tts,
    push,
    log,
    focus: attention,
    sideEffects: {
      onDelivered: (kind, notice, result) => {
        try { runtime.stats?.record(kind); } catch { /* 统计失败不影响通知 */ }
        try {
          runtime.history?.append({
            kind, sessionId: notice.sessionId, project: notice.project ?? null,
            title: notice.content?.title ?? "",
            delivered: { desktop: Boolean(result?.toast?.ok), sound: Boolean(result?.sound?.ok), push: Boolean(result?.push?.ok) },
            suppressed: null,
          });
        } catch { /* 静默 */ }
      },
      onSuppressed: (kind, notice, reason) => {
        try {
          runtime.history?.append({
            kind, sessionId: notice.sessionId, project: notice.project ?? null,
            title: notice.content?.title ?? "",
            delivered: { desktop: false, sound: false }, suppressed: reason,
          });
        } catch { /* 静默 */ }
      },
    },
  });
  runtime.getConfig = () => runtime.cfg;

  // --- 设置（缺失/失败时退回入口 config，不崩） ---
  let unwatch = null;
  try {
    const settings = ctx.get("settings");
    if (settings && typeof settings.register === "function") {
      const scope = settings.register(name, Config, {
        applies: "live",
        base: entryConfig && typeof entryConfig === "object" ? entryConfig : undefined,
      });
      runtime.cfg = resolveConfig(scope.get());
      log.setDebug(runtime.cfg.debug);
      unwatch = scope.watch((next) => {
        runtime.cfg = resolveConfig(next);
        log.setDebug(runtime.cfg.debug);
      });
    }
  } catch (e) {
    log.error(`settings 注册失败，使用入口配置: ${e?.message ?? e}`);
  }

  // --- 关键词（FR-1.6） ---
  const keywords = createKeywords({ getConfig: () => runtime.cfg, log });

  // --- 事件订阅（ctx.effect 统一清理；effect 不可用时跳过订阅） ---
  if (typeof ctx.effect === "function") {
    ctx.effect(() => [
      subscribe(ctx, {
        log,
        onNotice: (kind, notice) => runtime.pipeline?.admit(kind, notice),
        onWaitingReset: (sessionKey) => {
          runtime.pipeline?.resetWaiting(sessionKey);
          keywords?.resetTurn(sessionKey);
        },
        onTurnStart: (sessionKey, project) => runtime.pipeline?.turnStarted(sessionKey, project),
        onTurnEnd: (sessionKey, durationMs) => {
          runtime.pipeline?.turnEnded(sessionKey);
          keywords?.drop(sessionKey);
          if (durationMs != null) runtime.stats?.recordRun(durationMs);
        },
        onWaitSpan: (ms) => runtime.stats?.recordWait(ms),
        onChunk: (sessionKey, project, text) => {
          const hit = keywords?.feed(sessionKey, text, project);
          if (hit) runtime.pipeline?.admit("keyword", hit);
        },
        onUserPresent: () => runtime.pipeline?.flushSuppressed(),
      }),
    ]);
  } else {
    log.error("ctx.effect 不可用，事件订阅已跳过");
  }

  // --- 路由（webServer 缺失时跳过） ---
  try {
    registerRoutes(ctx, runtime);
  } catch (e) {
    log.error(`路由注册失败: ${e?.message ?? e}`);
  }

  // --- notify_send agent 工具（FR-10；tools 服务缺失时跳过） ---
  let toolsApi = null;
  try {
    toolsApi = ctx.tools ?? null; // 已声明 inject；防御性再包一层
  } catch {
    toolsApi = null;
  }
  if (toolsApi && typeof toolsApi.register === "function") {
    try {
      const offTool = registerNotifySendTool(ctx, runtime);
      if (typeof ctx.effect === "function") ctx.effect(() => [offTool]);
    } catch (e) {
      log.error(`notify_send 工具注册失败: ${e?.message ?? e}`);
    }
  }

  // --- health 视图 ---
  runtime.health = () => ({
    version,
    adapter: adapter.id,
    registered: adapter.registered, // win32 特有：AUMID 是否注册成功（其余平台 undefined，JSON 省略）
    capabilities: { ...runtime.probe.capabilities, toast: adapter.toastConfirmed ?? runtime.probe.capabilities.toast },
    headless: runtime.probe.headless,
    degraded: runtime.probe.degraded,
    pipeline: runtime.pipeline.snapshotHealth(),
    dataDir: dir,
  });

  // --- 卸载清理 ---
  if (typeof ctx.effect === "function") {
    ctx.effect(() => () => {
      try { unwatch?.(); } catch { /* 静默 */ }
      runtime.pipeline?.dispose?.();
    });
  }
}
