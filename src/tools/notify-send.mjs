// dsh-plugin-desktop-notice — notify_send agent 工具（FR-10，M3）
// 让 AI 在长任务里主动发通知（"跑完这批叫我"）；dispatch 直发：绕过勿扰/合并（AI 主动提醒优先级高），
// 但受 enabled 总开关约束（关插件 = AI 也不能弹）。事件级开关（events.<kind>.desktop）由 dispatch 内部兜底。
// 工具形状对齐 vault-memory 真机实现：ctx.tools.register({ name, description, parameters, timeoutMs, output, execute })。

export function registerNotifySendTool(ctx, runtime) {
  if (!ctx.tools || typeof ctx.tools.register !== "function") return () => {};

  const DESCRIPTION = `主动发送一条桌面通知提醒用户（不依赖对话轮次结束）。适用于长任务中途播报进度、跑完批量任务后"叫我"等场景。
注意：通知会弹在用户桌面并可能推送手机，仅在真正需要提醒时使用，不要滥用（同会话 1 秒内重复调用会被去重）。`;

  try {
    ctx.tools.register({
      name: "notify_send",
      description: DESCRIPTION,
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "通知标题，≤40 字，例如「批量转换完成」" },
          body: { type: "string", description: "通知正文，≤120 字，一句话说明结果" },
          kind: { type: "string", description: "通知种类：done（默认，成功）| waiting（等待用户）| error（失败）" },
        },
        required: ["title"],
      },
      timeoutMs: 10000,
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            ok: { type: "boolean" },
            toast: { type: "object" },
            sound: { type: "object" },
          },
        },
        // 展示层：默认 JSON 卡片即可（output.render 略），
      },
      async execute(args) {
        // 受 enabled 总开关约束（关插件 = AI 也不能弹）；勿扰/合并仍绕过（主动提醒优先级高）。
        if (runtime.getConfig?.()?.enabled === false) return { ok: false };
        const kind = ["done", "waiting", "error"].includes(args?.kind) ? args.kind : "done";
        const notice = {
          kind,
          sessionId: "notify_send",
          sessionKey: `notify_send:${kind}`,
          project: undefined,
          detail: undefined,
        };
        const content = { title: String(args?.title ?? "DSH 通知"), body: String(args?.body ?? "").slice(0, 120) };
        const result = await runtime.pipeline.dispatch(kind, { ...notice, content }); // dispatch 直发：绕过勿扰/合并
        return { ok: Boolean(result?.toast?.ok || result?.sound?.ok), ...result };
      },
    });
    return () => { try { ctx.tools.remove?.("notify_send"); } catch { /* 无独立移除则随插件卸载 */ } };
  } catch {
    return () => {};
  }
}
