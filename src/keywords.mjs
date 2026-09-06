// dsh-plugin-desktop-notice — 关键词监听（FR-1.6，M3）
// 数据源：assistant/chunk(text-delta) 增量文本；per-turn 缓冲（64KB 环形）+ 大小写不敏感匹配。
// 频控：每 turn 最多 1 条 + 复用管线合并窗口；keywords 为空 = 整体关闭。

const BUFFER_CAP = 64 * 1024;

export function createKeywords({ getConfig, log }) {
  /** @type {Map<string, string>} sessionKey → 文本缓冲（仅保留尾部 BUFFER_CAP） */
  const buffers = new Map();
  /** @type {Set<string>} 本 turn 已命中的 sessionKey（每 turn 最多 1 条） */
  const hitThisTurn = new Set();

  function resetTurn(sessionKey) {
    hitThisTurn.delete(sessionKey);
  }

  function drop(sessionKey) {
    buffers.delete(sessionKey);
    hitThisTurn.delete(sessionKey);
  }

  /**
   * 喂入增量文本；命中返回 { word, context }，否则 null。
   * @param {string} sessionKey
   * @param {string} text 增量文本（text-delta.text）
   * @param {string} project 通知里展示用
   */
  function feed(sessionKey, text, project) {
    try {
      const words = getConfig().keywords;
      if (!Array.isArray(words) || words.length === 0 || !text) return null;
      if (hitThisTurn.has(sessionKey)) return null; // 每 turn 最多 1 条

      let buf = (buffers.get(sessionKey) ?? "") + text;
      if (buf.length > BUFFER_CAP) buf = buf.slice(-BUFFER_CAP);
      buffers.set(sessionKey, buf);

      const lower = buf.toLowerCase();
      for (const w of words) {
        const word = String(w ?? "").trim();
        if (!word) continue;
        const at = lower.indexOf(word.toLowerCase());
        if (at >= 0) {
          hitThisTurn.add(sessionKey);
          const context = buf.slice(Math.max(0, at - 30), at + word.length + 30).replace(/\s+/g, " ").trim();
          log.debug(`[keyword] 命中 "${word}" @${sessionKey}`);
          return { kind: "keyword", sessionId: sessionKey, sessionKey, project, detail: `命中 “${word}”：${context}` };
        }
      }
      return null;
    } catch (e) {
      log.error(`keywords feed: ${e?.message ?? e}`);
      return null;
    }
  }

  return { feed, resetTurn, drop };
}
