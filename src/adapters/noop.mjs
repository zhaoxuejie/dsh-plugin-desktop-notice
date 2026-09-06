// dsh-plugin-desktop-notice — 无能力平台兜底（FR-2.6 降级链终点）：所有通道静默跳过。
export function createNoopAdapter(reason) {
  return {
    id: "noop",
    reason,
    async notify() { return { ok: false, skipped: "noop" }; },
    async play() { return { ok: false, skipped: "noop" }; },
  };
}
