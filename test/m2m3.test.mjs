// dsh-plugin-desktop-notice — M2/M3 单测（node --test）
// 覆盖：勿扰时段（跨午夜）、前台/全屏抑制与豁免、汇总队列、心跳、关键词、统计、历史落盘、推送路由。

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createPipeline } from "../src/pipeline.mjs";
import { inSchedule } from "../src/filters/dnd.mjs";
import { createAttention } from "../src/filters/attention.mjs";
import { createKeywords } from "../src/keywords.mjs";
import { createStats } from "../src/stats.mjs";
import { createHistory } from "../src/history.mjs";
import { createPush, buildRequest } from "../src/push.mjs";

/* ---------- 复用 M1 的时钟/适配器桩 ---------- */

function fakeClock(start = 0) {
  let t = start;
  const timers = new Set();
  return {
    now: () => t,
    schedule(fn, ms) { const h = { fn, at: t + ms }; timers.add(h); return h; },
    cancel(h) { timers.delete(h); },
    advance(ms) {
      t += ms;
      for (const h of [...timers]) {
        if (h.at <= t) { timers.delete(h); h.fn(); }
      }
    },
  };
}

function mockAdapter() {
  const calls = [];
  return {
    calls,
    async notify(p) { calls.push(["notify", p]); return { ok: true }; },
    async play(s) { calls.push(["play", s]); return { ok: true }; },
  };
}

const baseCfg = {
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
    clientWindowMatch: ["DSH"],
    fullscreenSilent: true,
    schedule: [],
    exemptWaiting: true,
    summaryOnExit: true,
  },
  history: { enabled: true, keepDays: 30, maxLines: 1000 },
  push: { provider: "off", endpoint: "", headers: {}, token: "", kinds: ["waiting", "error"] },
  tts: false,
  debug: false,
};

function makePipeline(cfg, { clock = fakeClock(), adapter = mockAdapter(), focus = { foregroundMatched: async () => false, isFullscreen: async () => false }, sideEffects = {} } = {}) {
  const log = { debug() {}, error() {} };
  const pipeline = createPipeline({
    getConfig: () => (typeof cfg === "function" ? cfg() : cfg),
    adapter, log,
    now: clock.now, schedule: clock.schedule, cancel: clock.cancel,
    focus, sideEffects,
  });
  const flushAsync = () => new Promise((r) => setImmediate(r));
  const notifies = () => adapter.calls.filter((c) => c[0] === "notify");
  return { pipeline, adapter, clock, flushAsync, notifies };
}

/* ---------- M2：勿扰时段 ---------- */

test("勿扰时段：常规区间与跨午夜", () => {
  const mk = (h, m) => new Date(2026, 8, 6, h, m); // 2026-09-06 是周日=7
  const rules = [{ days: [7], start: "22:00", end: "08:30" }];
  assert.equal(inSchedule(mk(23, 30), rules), true, "当晚 23:30 在时段内");
  assert.equal(inSchedule(mk(2, 0), rules), true, "跨午夜凌晨 2 点在时段内");
  assert.equal(inSchedule(mk(12, 0), rules), false, "中午不在时段内");
  assert.equal(inSchedule(mk(9, 0), [{ days: [1], start: "22:00", end: "08:30" }]), false, "周日不在 days 内");
  assert.equal(inSchedule(mk(23, 0), []), false, "空配置=关闭");
});

test("M2 F5 前台抑制 + sound-only 模式", async () => {
  const fg = { foregroundMatched: async (m) => m.includes("DSH") && true, isFullscreen: async () => false };
  const { pipeline, adapter, flushAsync } = makePipeline(baseCfg, { focus: fg });
  pipeline.admit("done", { kind: "done", sessionId: "s1", sessionKey: "s1" });
  await flushAsync();
  assert.equal(adapter.calls.length, 0, "skip 模式：前台匹配 → 完全抑制");

  const cfg2 = { ...baseCfg, dnd: { ...baseCfg.dnd, suppressWhenFocused: "sound-only" } };
  const { pipeline: p2, adapter: a2, flushAsync: f2 } = makePipeline(cfg2, { focus: fg });
  p2.admit("done", { kind: "done", sessionId: "s1", sessionKey: "s1" });
  await f2();
  assert.ok(a2.calls.some((c) => c[0] === "play"), "sound-only：只响音效");
  assert.ok(!a2.calls.some((c) => c[0] === "notify"), "sound-only：不弹 Toast");
});

test("M2 waiting 豁免：前台匹配时等待输入仍弹窗", async () => {
  const fg = { foregroundMatched: async () => true, isFullscreen: async () => false };
  const { pipeline, adapter, flushAsync, notifies } = makePipeline(baseCfg, { focus: fg });
  pipeline.admit("waiting", { kind: "waiting", sessionId: "s1", sessionKey: "s1", detail: "bash" });
  await flushAsync();
  assert.equal(notifies().length, 1, "exemptWaiting 默认 true → 等待输入穿透前台抑制");
});

test("M2 F6 全屏静默 + F8 汇总（用户回来后合并补发）", async () => {
  let fullscreen = true;
  const focus = { foregroundMatched: async () => false, isFullscreen: async () => fullscreen };
  const { pipeline, adapter, clock, flushAsync, notifies } = makePipeline(baseCfg, { focus });
  pipeline.admit("done", { kind: "done", sessionId: "s1", sessionKey: "s1", project: "alpha", durationMs: 1000 });
  pipeline.admit("done", { kind: "done", sessionId: "s2", sessionKey: "s2", project: "beta", durationMs: 2000 });
  await flushAsync();
  assert.equal(notifies().length, 0, "全屏中全部抑制入队");

  fullscreen = false;          // 用户退出全屏
  clock.advance(2000);
  pipeline.admit("waiting", { kind: "waiting", sessionId: "s3", sessionKey: "s3" }); // 触发队列检查
  await flushAsync();
  assert.equal(notifies().length, 2, "汇总：两条 done 合并为 1 条 + waiting 立即 1 条");
  assert.match(notifies()[0][1].title, /2 个任务完成/);
});

/* ---------- M2：心跳（FR-1.4） ---------- */

test("M2 心跳：超阈值弹一次，此后按 repeat 间隔，turn 结束即停", async () => {
  const { pipeline, adapter, clock, flushAsync, notifies } = makePipeline(baseCfg);
  pipeline.turnStarted("s1", "proj");
  clock.advance(600 * 1000);   // 阈值 600s
  await flushAsync();
  assert.equal(notifies().length, 1, "第一次心跳");
  assert.match(notifies()[0][1].title, /任务仍在运行/);

  clock.advance(10 * 60000);   // repeatMinutes=10
  await flushAsync();
  assert.equal(notifies().length, 2, "第二次心跳（repeat 间隔）");

  pipeline.turnEnded("s1");
  clock.advance(30 * 60000);
  await flushAsync();
  assert.equal(notifies().length, 2, "turn 结束后不再心跳");
});

/* ---------- M3：关键词（FR-1.6） ---------- */

test("M3 关键词：增量缓冲命中、每 turn 一次、resetTurn 复位", () => {
  const cfg = { ...baseCfg, keywords: ["error", "完成"] };
  const kw = createKeywords({ getConfig: () => cfg, log: { debug() {}, error() {} } });

  assert.equal(kw.feed("s1", "一切正", "p"), null, "未命中");
  const hit = kw.feed("s1", "常，但是 error 出现了", "p");
  assert.ok(hit, "跨增量命中");
  assert.match(hit.detail, /error/);
  assert.equal(kw.feed("s1", "又一个 error", "p"), null, "每 turn 最多 1 条");

  kw.resetTurn("s1");
  const hit2 = kw.feed("s1", "任务完成", "p");
  assert.ok(hit2, "复位后可再次命中");
  assert.match(hit2.detail, /完成/);

  const empty = createKeywords({ getConfig: () => ({ ...baseCfg, keywords: [] }), log: { debug() {}, error() {} } });
  assert.equal(empty.feed("s2", "error", "p"), null, "keywords 为空 = 关闭");
});

/* ---------- M3：统计（FR-9.2） ---------- */

test("M3 统计：计数 + 运行/等待时长聚合", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-stats-"));
  const stats = createStats({ dir, log: { debug() {}, error() {} } });
  stats.record("done");
  stats.record("done");
  stats.record("waiting");
  stats.recordRun(90 * 60000);
  stats.recordWait(47 * 60000);

  const s = stats.snapshot();
  assert.equal(s.done, 2);
  assert.equal(s.waiting, 1);
  assert.equal(s.aiRunMinutes, 90);
  assert.equal(s.waitedMinutes, 47);

  // 重新加载应读回同一份数据
  const stats2 = createStats({ dir, log: { debug() {}, error() {} } });
  assert.equal(stats2.snapshot().done, 2, "持久化后可读回");
});

/* ---------- M2：历史落盘（FR-9.1） ---------- */

test("M2 历史：追加、读取、超限滚动", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-hist-"));
  const cfg = { ...baseCfg, history: { enabled: true, keepDays: 30, maxLines: 10 } };
  const hist = createHistory({ dir, getConfig: () => cfg, log: { debug() {}, error() {} } });
  for (let i = 0; i < 15; i++) {
    hist.append({ kind: "done", sessionId: `s${i}`, project: "p", title: `t${i}`, delivered: { desktop: true, sound: true }, suppressed: null });
  }
  const recent = hist.readRecent(5);
  assert.equal(recent.length, 5);
  assert.equal(recent[0].title, "t14", "新在前");
  const all = hist.readRecent(100);
  assert.ok(all.length <= 10, "maxLines 滚动生效");
});

/* ---------- M3：推送路由（FR-7） ---------- */

test("M3 推送：请求构造与分级路由", () => {
  const notice = { kind: "waiting", content: { title: "⏸ AI 在等你", body: "bash" }, sessionId: "s1" };

  const bark = buildRequest("bark", notice, { endpoint: "https://api.day.app/key123", headers: {} });
  assert.equal(bark.url, "https://api.day.app/key123");
  assert.match(bark.body, /AI 在等你/);

  const ntfy = buildRequest("ntfy", notice, { endpoint: "https://ntfy.sh/mytopic", headers: {} });
  assert.equal(ntfy.headers.Priority, "high", "waiting → high");
  const ntfyErr = buildRequest("ntfy", { ...notice, kind: "error" }, { endpoint: "https://ntfy.sh/t", headers: {} });
  assert.equal(ntfyErr.headers.Priority, "max", "error → max");

  const hook = buildRequest("webhook", notice, { endpoint: "https://example.com/hook", token: "t0k", headers: {} });
  assert.equal(hook.headers.authorization, "Bearer t0k");
  assert.match(hook.body, /"kind":"waiting"/);
});

test("M3 推送：sendFor 分级路由（done 默认不发）", async () => {
  const cfg = { ...baseCfg, push: { provider: "webhook", endpoint: "https://example.com/hook", headers: {}, token: "", kinds: ["waiting", "error"] } };
  const calls = [];
  const push = createPush({ getConfig: () => cfg, log: { debug() {}, error() {} }, fetchImpl: async (url, opt) => { calls.push({ url, body: opt.body }); return { ok: true }; } });

  const doneResult = await push.sendFor("done", { kind: "done", content: { title: "t", body: "b" } });
  assert.equal(doneResult.skipped, "route", "done 不在路由名单 → 跳过");

  await push.sendFor("waiting", { kind: "waiting", content: { title: "t", body: "b" }, sessionId: "s" });
  assert.equal(calls.length, 1, "waiting 外发");
  await push.sendFor("error", { kind: "error", content: { title: "t", body: "b" }, sessionId: "s" });
  assert.equal(calls.length, 1, "3 秒节流窗口内第二条被跳过");
});
