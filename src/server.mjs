// dsh-plugin-desktop-notice — webServer 路由（M1+M3，spec §8 / phase3 §5）
// health（探测/降级/管线状态）、test（三态轮发测试通知）、history（M3 浮卡查询）、stats（M3 统计）。
// handler 为原生 (req, res)（daily-digest / vault-memory 先例）；注册失败仅日志，不影响通知主链路。

import { buildContent } from "./content.mjs";

const KINDS = ["done", "waiting", "error"];

const SAMPLES = {
  done: { sessionId: "sample", sessionKey: "", project: "demo-project", branch: "main", durationMs: 252000, tokens: 3200, summary: "已将通知组件接入设置页，测试通过，共改动 5 个文件" },
  waiting: { sessionId: "sample", sessionKey: "", project: "dsh-plugin-desktop-notice", detail: "bash · 需要运行 npm test 验证改动" },
  error: { sessionId: "sample", sessionKey: "", project: "api-gateway 调研", durationMs: 167000, detail: "LlmError: 请求超时（3 次重试后放弃），请检查网络或 API 状态" },
};

export function registerRoutes(ctx, runtime) {
  const webServer = ctx.get("webServer");
  if (!webServer || typeof webServer.register !== "function") return () => {};

  const json = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  };

  webServer.register({
    kind: "exact",
    path: "/desktop-notice/health",
    handler: (req, res) => json(res, 200, runtime.health()),
  });

  let rotate = 0;
  webServer.register({
    kind: "exact",
    path: "/desktop-notice/test",
    handler: async (req, res) => {
      try {
        let kind;
        if (req.method === "POST") {
          const chunks = [];
          let size = 0;
          for await (const c of req) {
            size += c.length;
            if (size > 10000) break;
            chunks.push(c);
          }
          const raw = Buffer.concat(chunks).toString("utf8");
          kind = raw.trim() ? JSON.parse(raw).kind : undefined;
        }
        if (!kind) {
          const u = new URL(req.url ?? "/", "http://localhost");
          kind = u.searchParams.get("kind") ?? KINDS[rotate++ % KINDS.length];
        }
        if (!KINDS.includes(kind)) {
          return json(res, 400, { error: `kind 必须是 ${KINDS.join(" / ")}` });
        }
        const notice = { ...SAMPLES[kind] };
        const content = buildContent(kind, notice, runtime.getConfig());
        const r = await runtime.pipeline.dispatch(kind, { ...notice, content }); // 绕过 F3/F4 直发
        json(res, 200, { ok: true, kind, ...r });
      } catch (e) {
        json(res, 500, { error: String(e?.message ?? e) });
      }
    },
  });

  // M3：浮卡数据通道
  webServer.register({
    kind: "exact",
    path: "/desktop-notice/history",
    handler: (req, res) => {
      const u = new URL(req.url ?? "/", "http://localhost");
      const limit = Math.min(200, Math.max(1, Number(u.searchParams.get("limit")) || 50));
      json(res, 200, { items: runtime.history ? runtime.history.readRecent(limit) : [] });
    },
  });

  webServer.register({
    kind: "exact",
    path: "/desktop-notice/stats",
    handler: (req, res) => json(res, 200, runtime.stats ? runtime.stats.snapshot() : {}),
  });

  return () => {};
}
