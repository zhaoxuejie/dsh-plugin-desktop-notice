// dsh-plugin-desktop-notice — 多通道推送（FR-7，M3）
// 通道：bark / ntfy / webhook（万能接口）；分级路由：默认仅 waiting/error 外发（FR-7.2）。
// 安全边界：只发标题+摘要，token 不落日志；超时 5s、零重试、失败静默降级（spec §3）。

const TIMEOUT_MS = 5000;

/** 构造各通道请求（独立导出便于单测）。 */
export function buildRequest(provider, notice, cfg) {
  const title = String(notice.content?.title ?? "DSH 通知").slice(0, 60);
  const body = String(notice.content?.body ?? "").slice(0, 120);
  if (provider === "bark") {
    return {
      url: `${String(cfg.endpoint ?? "").replace(/\/+$/, "")}`,
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8", ...(cfg.headers ?? {}) },
      body: JSON.stringify({ title, body, group: "dsh" }),
    };
  }
  if (provider === "ntfy") {
    const priority = notice.kind === "error" ? "max" : notice.kind === "waiting" ? "high" : "low";
    return {
      url: `${String(cfg.endpoint ?? "").replace(/\/+$/, "")}`,
      method: "POST",
      headers: { Priority: priority, Title: encodeURIComponent(title).replace(/%20/g, " "), ...(cfg.headers ?? {}) },
      body,
    };
  }
  // webhook（万能接口：飞书/钉钉/Slack 自定义网关等）
  return {
    url: String(cfg.endpoint ?? ""),
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8", ...(cfg.token ? { authorization: `Bearer ${cfg.token}` } : {}), ...(cfg.headers ?? {}) },
    body: JSON.stringify({ kind: notice.kind, title, body, sessionId: notice.sessionId, project: notice.project ?? null, time: Date.now() }),
  };
}

export function createPush({ getConfig, log, fetchImpl = globalThis.fetch }) {
  let lastSentAt = 0;

  return {
    /** 分级路由判定 + 外发。返回 { ok, skipped? }。 */
    async sendFor(kind, notice) {
      try {
        const cfg = getConfig();
        if (cfg.push?.provider === "off" || !cfg.push?.endpoint) return { ok: false, skipped: "off" };
        if (!cfg.push.kinds?.includes(kind)) return { ok: false, skipped: "route" };
        // 防推送轰炸：全局最小间隔 3s
        const now = Date.now();
        if (now - lastSentAt < 3000) return { ok: false, skipped: "throttle" };
        lastSentAt = now;

        const req = buildRequest(cfg.push.provider, notice, cfg.push);
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
        try {
          const res = await fetchImpl(req.url, { method: req.method, headers: req.headers, body: req.body, signal: ctrl.signal });
          if (!res.ok) {
            log.error(`push[${cfg.push.provider}] HTTP ${res.status}`);
            return { ok: false, error: `HTTP ${res.status}` };
          }
          log.debug(`[push] ${kind} → ${cfg.push.provider} ok`);
          return { ok: true };
        } finally {
          clearTimeout(timer);
        }
      } catch (e) {
        log.error(`push 失败: ${e?.message ?? e}`); // 推送失败静默降级，不影响桌面通道
        return { ok: false, error: String(e?.message ?? e) };
      }
    },
  };
}
