// dsh-plugin-desktop-notice — 单测（node --test test/）
// 覆盖：管线 F1/F2 开关、F3 合并节流、F4 渐进提醒与复位、内容模板截断。
// 时钟/定时器全部注入（pipeline 支持依赖注入），测试不同真实 setTimeout 纠缠。

import test from "node:test";
import assert from "node:assert/strict";
import { createPipeline } from "../src/pipeline.mjs";
import { buildContent, buildMergedContent, fmtDuration } from "../src/content.mjs";

/** 可编程时钟：advance 到点触发定时器（同步、按调度序）。 */
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
    async play(sound) { calls.push(["play", sound]); return { ok: true }; },
  };
}

function makePipeline(cfg, { clock = fakeClock(), adapter = mockAdapter(), log } = {}) {
  const logger = log ?? { debug() {}, error() {} };
  const pipeline = createPipeline({
    getConfig: () => (typeof cfg === "function" ? cfg() : cfg),
    adapter,
    log: logger,
    now: clock.now,
    schedule: clock.schedule,
    cancel: clock.cancel,
  });
  const flushAsync = () => new Promise((r) => setImmediate(r));
  return { pipeline, adapter, clock, flushAsync };
}

const baseCfg = {
  enabled: true,
  events: {
    done: { desktop: true, sound: "success" },
    waiting: { desktop: true, sound: "notice" },
    error: { desktop: true, sound: "alert" },
  },
  preview: { titleMax: 40, bodyMax: 120 },
  mergeWindowSeconds: 10,
  escalateWaitingMinutes: 5,
  volume: 60,
};

test("F1 总开关：enabled=false 时任何事件都不出管线", async () => {
  const { pipeline, adapter, flushAsync } = makePipeline({ ...baseCfg, enabled: false });
  pipeline.admit("done", { kind: "done", sessionId: "s1", sessionKey: "s1" });
  await flushAsync();
  assert.equal(adapter.calls.length, 0);
});

test("F2 事件开关：desktop/sound 全关的事件不出管线", async () => {
  const cfg = { ...baseCfg, events: { ...baseCfg.events, done: { desktop: false, sound: "off" } } };
  const { pipeline, adapter, flushAsync } = makePipeline(cfg);
  pipeline.admit("done", { kind: "done", sessionId: "s1", sessionKey: "s1" });
  await flushAsync();
  assert.equal(adapter.calls.length, 0);
});

test("F3 合并节流：窗口首条立即发，后续合并为一条", async () => {
  const { pipeline, adapter, clock, flushAsync } = makePipeline(baseCfg);
  pipeline.admit("done", { kind: "done", sessionId: "s1", sessionKey: "s1", project: "alpha", durationMs: 1000 });
  await flushAsync();
  assert.equal(adapter.calls.filter((c) => c[0] === "notify").length, 1, "首条立即发");

  clock.advance(2000);
  pipeline.admit("done", { kind: "done", sessionId: "s2", sessionKey: "s2", project: "beta", durationMs: 2000 });
  clock.advance(2000);
  pipeline.admit("done", { kind: "done", sessionId: "s3", sessionKey: "s3", project: "gamma", durationMs: 3000 });
  await flushAsync();
  assert.equal(adapter.calls.filter((c) => c[0] === "notify").length, 1, "窗口内不追加弹窗");

  clock.advance(10001); // 窗口到点 → flush 合并
  await flushAsync();
  const notifies = adapter.calls.filter((c) => c[0] === "notify");
  assert.equal(notifies.length, 2);
  assert.match(notifies[1][1].title, /2 个任务完成/);
  assert.match(notifies[1][1].body, /beta/);
  assert.match(notifies[1][1].body, /gamma/);
});

test("F4 渐进提醒：等待 N 分钟未处理重发一次，标题升级为『仍在等你』", async () => {
  const { pipeline, adapter, clock, flushAsync } = makePipeline(baseCfg);
  pipeline.admit("waiting", { kind: "waiting", sessionId: "s1", sessionKey: "s1", project: "p", detail: "bash" });
  await flushAsync();
  const notifies = () => adapter.calls.filter((c) => c[0] === "notify");
  assert.equal(notifies().length, 1);
  assert.match(notifies()[0][1].title, /AI 在等你/);

  clock.advance(5 * 60000);
  await flushAsync();
  assert.equal(notifies().length, 2);
  assert.match(notifies()[1][1].title, /仍在等你/);

  clock.advance(5 * 60000); // 不再二次升级（M1 只升一级）
  await flushAsync();
  assert.equal(notifies().length, 2);
});

test("F4 复位：approval/decided → resetWaiting 后不再强提醒", async () => {
  const { pipeline, adapter, clock, flushAsync } = makePipeline(baseCfg);
  pipeline.admit("waiting", { kind: "waiting", sessionId: "s1", sessionKey: "s1", detail: "bash" });
  await flushAsync();
  pipeline.resetWaiting("s1");
  clock.advance(5 * 60000);
  await flushAsync();
  assert.equal(adapter.calls.filter((c) => c[0] === "notify").length, 1);
});

test("内容模板：标题/正文按 preview 截断，字段缺省整行省略", () => {
  const cfg = { preview: { titleMax: 20, bodyMax: 30 } };
  const c1 = buildContent("done", {
    project: "a-very-long-project-name-that-exceeds", branch: "feature/x",
    durationMs: 252000, tokens: 3200, summary: "很长的摘要".repeat(20),
  }, cfg);
  assert.ok(c1.title.length <= 20);
  assert.ok(c1.body.length <= 30);

  const c2 = buildContent("waiting", { detail: "bash · 等待授权" }, cfg);
  assert.match(c2.title, /AI 在等你/);
  assert.ok(!c2.body.includes("耗时"));
});

test("合并模板：多于 3 条给计数", () => {
  const cfg = { preview: { titleMax: 40, bodyMax: 120 } };
  const items = [1, 2, 3, 4, 5].map((i) => ({ project: `p${i}`, durationMs: i * 1000 }));
  const m = buildMergedContent("done", items, cfg);
  assert.match(m.title, /5 个任务完成/);
  assert.match(m.body, /等共 5 条/);
});

test("fmtDuration 基本格式", () => {
  assert.equal(fmtDuration(252000), "4 分 12 秒");
  assert.equal(fmtDuration(41000), "41 秒");
  assert.equal(fmtDuration(3600000), "1 小时 0 分");
  assert.equal(fmtDuration(undefined), "");
});
