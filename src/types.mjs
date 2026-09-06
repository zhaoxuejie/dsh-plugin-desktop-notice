// dsh-plugin-desktop-notice — 共享类型（JSDoc，零构建纯 ESM）
// NoticeEvent 为事件归一化产物（docs/phase1-interface-spec.md §3），
// 下游管线与渲染只认这个结构，不感知宿主事件形态。

/**
 * @typedef {"done" | "waiting" | "error"} NoticeKind
 */

/**
 * 归一化通知事件。所有字段"尽力而为"：取不到就缺省，绝不编造、绝不阻塞。
 * @typedef {Object} NoticeEvent
 * @property {NoticeKind} kind                       通知种类
 * @property {string} sessionId                      宿主会话 id
 * @property {string} sessionKey                     会话键（去重 / 渐进提醒 / 熔断的作用域）
 * @property {string=} project                       项目名（工作目录 basename 等，M1 兜底可能缺省）
 * @property {string=} branch                        git 分支（取不到省略）
 * @property {number=} durationMs                    任务耗时（turn/end.time - turn/start.time，epoch ms）
 * @property {number=} tokens                        token 用量（assistant/message.usage，可得时）
 * @property {string=} summary                       AI 结论摘要（最后一条 assistant message 截断）
 * @property {string=} detail                        补充行（waiting: 工具+理由；error: LlmFailure 摘要）
 * @property {boolean=} escalated                    渐进强提醒重发标记（waiting 专用）
 * @property {unknown=} raw                          原始宿主事件 payload（调试用）
 */

/**
 * 渲染内容（content.mjs 组装产物，受 preview.titleMax / bodyMax 截断）。
 * @typedef {Object} NoticeContent
 * @property {string} title
 * @property {string} body
 */

export {};
