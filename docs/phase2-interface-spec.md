# Phase 2 接口规范（M2）— 防打扰引擎 + 内容增强 + macOS

> 范围：M2 = FR-4 全部（前台 / 全屏 / 勿扰时段 / 勿扰汇总）+ FR-5 内容增强 + FR-9.1 历史落盘 + FR-6.1 点击聚焦（探索 spike）+ **macOS 适配器**。
> 上游：`DESIGN.md`（v0.2）、`docs/step0-calibration.md`、`docs/phase1-interface-spec.md`（M1 已交付的 F1–F4 过滤器、合并节流、渐进提醒、win32 适配器在本阶段直接复用与扩展）。
> 状态：规范稿，M1 验收后按此开工。

---

## 1. 交付物与模块增量（M2）

```
src/
├── filters/
│   ├── foreground.mjs     # F5 前台检测（win32 + darwin）
│   ├── fullscreen.mjs     # F6 全屏/演示检测（win32）
│   └── dnd.mjs            # F7 勿扰时段 + F8 勿扰汇总队列
├── content.mjs            # 内容模板：项目 / 分支 / 耗时 / token / 摘要
├── history.mjs            # history.jsonl + 滚动清理
├── adapters/
│   ├── win32.mjs          # 扩展：前台+全屏合并探测脚本
│   └── darwin.mjs         # 新增：osascript + afplay + frontmost
└── pipeline.mjs           # 插入 F5/F6/F7（M1 预留的过滤器接口位）
```

## 2. 管线扩展

```
NoticeEvent → F1 enabled → F2 事件开关 → F5 前台 → F6 全屏 → F7 勿扰时段
           → F3 合并节流 → F4 渐进提醒 → 渲染分发 → history.append
```

- F5/F6/F7 未通过时**不丢弃**：入 `dndQueue`（F8），标注抑制原因；
- **等待输入豁免**（设计决策）：`waiting` 事件默认**豁免** F5/F6/F7（阻塞在烧用户时间，勿扰也要提醒），`dnd.exemptWaiting: true` 可关；
- F8 汇总触发时机：① 勿扰时段结束；② F5 检测到用户回到前台；③ 插件收到新会话的用户输入（`user/message`，用户回来了）。汇总为一条："刚才 N 个任务完成、M 个失败、K 个在等你"。

## 3. 前台 / 全屏检测（filters/foreground.mjs、fullscreen.mjs）

- **win32**：合并为一次 PowerShell spawn——`GetForegroundWindow`（对比 DSH 客户端窗口，比对目标按校准 §4#9 确认后定稿；先行方案：对客户端进程窗口标题/class 模糊匹配）+ `SHQueryUserNotificationState`（`QUNS_BUSY` / `QUNS_RUNNING_APP` 视为全屏）；单次开销 ~150–300ms；
- **darwin**：`osascript` 查客户端进程 frontmost；全屏项不实现（macOS 系统专注模式自动抑制）；
- **结果缓存 TTL 10s**（跨事件复用，避免高频 spawn）；spawn 失败 → 视为"未命中抑制"（宁多弹不漏弹）+ 日志；
- 配置：`dnd.suppressWhenFocused: 'skip' | 'sound-only' | 'off'`（默认 `skip`——前台时连音效也不响；`sound-only` 保留提示音）；`dnd.fullscreenSilent: boolean`（默认 true）。

## 4. 勿扰时段（filters/dnd.mjs）

- 配置 `dnd.schedule: Array<{ days: number[] /* 1-7 */, start: 'HH:mm', end: 'HH:mm' }>`，支持跨午夜（end < start 时按次日计算）；
- 判定为纯本地时间比较，零 spawn；
- 汇总队列（F8）：内存队列 + 进程退出前 flush 到 history（防丢失）；队列条目复用 `NoticeEvent`，汇总通知走正常渲染通道。

## 5. 内容增强（content.mjs，FR-5）

标题 / 正文模板（字段缺省则整段省略，绝不占位）：

```
✅ 任务完成 · moqian-web (feat/notify)        ← icon + 事件文案 · project (branch)
耗时 4 分 12 秒 · 3.2k tokens                  ← durationMs + usage（可得时）
"已将通知组件接入设置页，测试通过…"            ← summary 截断
```

- `project`：按校准 §4#2 落定（Session/workspace 映射）；兜底 sessionId 前段；
- `branch`：读 `<cwd>/.git/HEAD`（解析 `ref: refs/heads/x`），按 cwd 缓存 5s；取不到省略；
- `summary`：本 turn 最后一条 `assistant/message.message` 提取纯文本，按 `preview.bodyMax` 截断；
- `waiting` 正文固定强调语义："AI 在等你 · {toolName 或问题摘要}"。

## 6. 历史落盘（history.mjs，FR-9.1）

- 文件：`<DSH_HOME>/data/desktop-notice/history.jsonl`；`.tmp` + rename 原子轮转；
- 行格式：`{ time, kind, sessionId, project, branch?, title, delivered: { desktop: bool, sound: bool }, suppressed: 'foreground' | 'fullscreen' | 'dnd' | null }`；
- 写入时机：渲染分发后（含被抑制的事件，标注 suppressed）；
- 清理：启动时 + 每 500 条 lazy 检查，`keepDays: 30` / `maxLines: 1000`（可配）；
- M2 只落盘不读（查询 API 留给 M3 浮卡）。

## 7. macOS 适配器（adapters/darwin.mjs）

- **Toast**：`spawn('osascript', ['-e', script])`——参数一律走 **args 数组**（不经 shell 拼接，规避注入）；script 模板：`display notification "BODY" with title "TITLE" subtitle "SUB"`（waiting 用 subtitle 放"AI 在等你"）；
- **Sound**：`spawn('afplay', [file, '-v', volume])`——afplay 自带音量（0–2 实数区间），映射 `volume% → 0..2`；天然支持 mp3；
- **前台检测**：`osascript -e 'tell application "System Events" to name of first process whose frontmost is true'`，对比客户端进程名；
- **probe 扩展**：darwin 分支探测 `osascript` / `afplay` 存在性 + 系统版本 ≥12；授权状态无法编程查询（UNUserNotificationCenter 需原生运行时）——以"首条试发后用户反馈"为准，README 写明（校准 §4 补充项）；
- 勿扰/汇总/渐进提醒逻辑与平台无关，直接复用。

## 8. 点击聚焦 spike（FR-6.1，探索性）

- 目标：点击 Windows Toast → 激活 DSH 客户端窗口；
- 技术路径：Toast XML `activationType` + AUMID 注册 / 协议激活回调——需验证 WinRT 后台激活在"无注册 AUMID"前提下的可达性；
- **时间盒 1 天**，产出 spike 结论写入本文档附录：可行 → 实现；不可行 → FR-6.1 关闭（保留通知中心回看，零成本），DESIGN 状态同步；
- macOS 侧聚焦依赖 terminal-notifier bundled 二进制（与零依赖冲突），默认不做，仅记录。

## 9. 配置增量（M2 全量字段，叠加 M1）

```js
dnd: Schema.object({
  suppressWhenFocused: Schema.union(['skip', 'sound-only', 'off']).default('skip'),
  fullscreenSilent: Schema.boolean().default(true),
  schedule: Schema.array(Schema.object({
    days: Schema.array(Schema.number()).default([1,2,3,4,5,6,7]),
    start: Schema.string().default('22:00'),
    end: Schema.string().default('08:30'),
  })).default([]),
  exemptWaiting: Schema.boolean().default(true),
  summaryOnExit: Schema.boolean().default(true),
}),
history: Schema.object({
  enabled: Schema.boolean().default(true),
  keepDays: Schema.number().default(30),
  maxLines: Schema.number().default(1000),
}),
```

## 10. 验收映射

| 用例 | 覆盖 |
|---|---|
| T9 前台不弹 | §3 + §2 F5 |
| T10 全屏静默 + 退出汇总 | §3 F6 + §2 F8 |
| T11 勿扰时段 | §4 |
| T12 心跳阈值 | M1 F4 复用 + §5 内容（T12 主体在 M1 已验，此处回归） |
| T15 macOS 三类事件 | §7 |
| 通知内容增强 | §5（project/branch/耗时/token/摘要） |

## 11. 开工任务拆解

1. pipeline 插入 F5/F6（win32 合并探测脚本 + TTL 缓存）；
2. dnd.mjs（时段 + 队列 + 汇总 + waiting 豁免）；
3. content.mjs 模板（校准 §4#2/#3 落地）；
4. history.mjs 落盘 + 清理；
5. darwin.mjs + probe 扩展（mac 真机验证 T15，无真机则代码交付 + 社区验证，见开放问题 #7）；
6. 点击聚焦 spike（时间盒 1 天）→ 附录结论；
7. 真机验收 T9–T12 / T15 → 更新 README 状态表。
