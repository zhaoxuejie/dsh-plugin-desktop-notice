# Step 0 — 校准记录（M0）

> 目的：开工前反查 DSH 宿主真实源码，把 `DESIGN.md` 中所有"待校准 / 勿假设"的条目逐项落成事实。
> 方法：直接读取本机安装的宿主包 **TypeScript 类型定义**（`lib/types/*.d.ts`，即插件可见契约的真源），并对照已真机验证的参考插件 `dsh-plugin-vault-memory` 的实现代码。
> 校准时间：2026-09-05 · 结论状态：**主要事件源全部落定，FR-1.2 风险解除**。

---

## 0. 环境事实

| 项 | 事实 |
|---|---|
| 宿主版本 | `@deepseek-ai/dsh` **0.1.2-rc.1** |
| 安装位置 | `~/AppData/Local/hermes/node/node_modules/@deepseek-ai/dsh`（dsh CLI 同目录） |
| 宿主包树 | `dsh/node_modules/@deepseek-ai/` 下含全套 `dsh-*` 子包（dsh-session / dsh-jobs / dsh-settings / dsh-user-approval / dsh-user-questions / dsh-host-webserver / …） |
| DSH_HOME | `process.env.DSH_HOME \|\| path.join(os.homedir(), ".dsh")`（vault-memory 实测写法）；本机 `~/.dsh` 存在（profiles / settings.yaml / sessions / data） |
| 参考实现 | `<dsh-plugin-vault-memory 仓库路径>`（= `dsh-plugin-vault-memory`，真机验证通过；入口契约：`export const name / inject / Config` + `export function apply(ctx, entryConfig)`） |
| 平台 | Windows 10（10.0.19045）x64 |

---

## 1. 事件源校准（对应 DESIGN FR-1）

### 1.1 `session/event` — 通知管线的主动力 ✅

`dsh-session/lib/types/index.d.ts`：

```ts
'session/event'(this: Scoped<Session>, session: Session, event: SessionEvent): void;
// @mode emit —— post-commit 广播、fire-and-forget；监听器失败被记录并隔离，
// 不会使已提交的 append 失败。Scope-filtered dispatch（agent 作用域监听只收该 agent 的会话）。
```

**结论：被动监听安全，零副作用，本插件的主力订阅点。**

`SessionEvent` 信封（`dsh-session/lib/types/types.d.ts` L435）：

```ts
{ type: K; seq: SessionSeq; time: number /* Unix epoch ms */; data: SessionEventMap[K]; ignorable? }
```

`time` 字段直接支撑耗时计算（`turn/end.time - turn/start.time`）。

### 1.2 `SessionEventMap` 事件词汇表（types.d.ts L235）

| 事件 | payload | 对本插件的意义 |
|---|---|---|
| `turn/start` | `{ turn }` | 计时起点；心跳/渐进提醒的状态机驱动 |
| `turn/end` | `{ turn, reason: TurnEndReason }` | **完成 / 失败 / 阻塞的判定主源** |
| `assistant/message` | `{ turn, step, message: AssistantMessage, usage?: TokenUsage, interrupted?: true }` | **摘要行来源**（最后一条 AI 消息）+ token 数 |
| `assistant/chunk` | `{ turn, step, chunk: StreamChunk }` | FR-1.6 关键词匹配的数据源（P2） |
| `tool/call` | `{ turn, step, callId, name, arguments }` | 内部数据源（心跳"正在执行 X"） |
| `tool/result` | `{ turn, step, message, error?: { name, code }, meta? }` | 同上；**不作通知事件**（去噪决策） |
| `user/message` | `UserMessage` | 渐进提醒复位信号（用户回来了） |
| `approval/asked` | `{ id, toolName, callId?, reason? }` | **FR-1.2 权限确认事件** ✅ |
| `approval/decided` | `{ id, outcome }` | FR-1.2 渐进提醒复位信号 |
| `request/header` / `request/context` / `session/end-seed` | — | 不使用 |

`TurnEndReasonMap`（types.d.ts L161）完整枚举：

```ts
completed | aborted { reason: TurnEndCancelCause } | blocked
| error { error: LlmFailure }   // 结构化失败，含 LlmError 事实
| max-tokens | interrupted      // 崩溃孤儿回填标记，不通知
```

> `blocked` 与 `completed`/`error` 并列——阻塞语义与 `approval/asked` 互为印证：**M1 以 `approval/asked` 为弹窗触发，`turn/end(kind='blocked')` 作补充观察**，真机验证两者时序后定稿。

### 1.3 agent 生命周期事件（`dsh-agent/lib/types/runtime-types.d.ts`）

| 事件 | 形态 | 决策 |
|---|---|---|
| `agent/status` | emit，payload `{ agent, status: 'idle' \| 'running' }` | 辅助信号：running→idle 配合 pending 审批可交叉验证"在等你"；M1 仅记录 |
| `agent/request-error` | **waterfall**，payload `{ agent, turn, step, provider, failure: LlmFailure, retryPolicy, signal }`，须 `next()` 返回 retry 决策 | **不作为弹窗源**——含重试语义，瞬时错误会先走 retryPolicy，逐次弹窗即误报；仅写 debug 日志 |
| `agent/session-start` | emit | FR-1.5 历史记录 |
| `agent/pre-step` / `agent/turn-stopping` / `agent/inbox/*` | — | 不使用 |

### 1.4 提问流（`dsh-user-questions/lib/types/types.d.ts`）

```ts
'user-questions/request'(this: Scoped<Agent>, request: AskUserQuestionRequestEvent,
                         next: () => Promise<AskUserQuestionAnswer>): Promise<AskUserQuestionAnswer>;
// @mode waterfall —— agent 作用域
```

**FR-1.2 第二源确认存在。** ⚠️ 开工确认项：waterfall 监听器是否**必须**调用 `next()`（观察式透传是否安全）——见 §4 残留未知 #5。

### 1.5 后台任务（`dsh-jobs/lib/types/index.d.ts`）

```ts
interface Context { jobs: JobRegistry }   // ctx.jobs
abstract onJobDone(listener: JobDoneListener): () => void;   // 返回取消订阅函数
```

**FR-1.1 的后台任务辅源成立。** `JobDoneListener` 精确 payload（JobSnapshot 字段）见 §4 残留未知 #1。

---

## 2. 对 DESIGN v0.2 的修订（校准触发）

| # | 修订 | 理由 |
|---|---|---|
| R1 | **FR-1.2 风险解除，进 M1** | `approval/asked`（权限确认）与 `user-questions/request`（agent 提问）两个事件源均确认存在，原"M1.5 降级预案"作废 |
| R2 | **FR-1.3 主源改为 `session/event` 的 `turn/end(reason.kind='error')`** | `agent/request-error` 是 waterfall + 含重试，瞬时错误逐次弹窗即误报；`turn/end(kind='error')` 是被动终态，零副作用 |
| R3 | **FR-1.1 主源定为 `turn/end(reason.kind='completed')`** | DESIGN 原写"session/event（stop 类）"不存在；真实词汇是 `turn/end`；`max-tokens` 并入完成类（附标注） |
| R4 | **durationMs 计算方式落定** | `turn/end.time - turn/start.time`（信封 `time` 为 epoch ms，无需自建计时器） |
| R5 | 渐进提醒复位信号落定 | `approval/decided` / `user/message`（用户发言即"回来了"） |
| R6 | FR-1.5 补充 `session/created` | `dsh-session` 另有 `session/created` / `session/disposed` emit 事件，历史记录可用 |

---

## 3. 服务 / 注册 API 校准

| API | 校准结论 | 证据 |
|---|---|---|
| 插件入口 | `export const name / inject / Config` + `export function apply(ctx, entryConfig)`；`inject = ["settings", ...]` 按需 | vault-memory `src/index.mjs:15-21`（真机验证） |
| settings | `settings.register(ns, schema, { applies: "live", ... }) → SettingsScope<T>`；`scope.get()` / `scope.watch(cb)` 热更新；`applies?: SettingsApplies` | `dsh-settings/lib/types/index.d.ts:216`；vault-memory `src/index.mjs:130-138` 同款 |
| webServer | `webServer.register(route: WebRoute): () => void`；`WebRoute = { kind: 'exact' \| 'prefix', path, handler }`；另有 `registerUpgrade` / `registerFallback` | `dsh-host-webserver/lib/types/index.d.ts:90-106` |
| 数据落盘 | `<DSH_HOME>/data/<插件名>/`；原子写 `.tmp` + `rename` | vault-memory 范式 + 宿主含 `dsh-atomic-write`（零依赖自实现即可） |
| PowerShell 惯例 | 宿主自身依赖 `powershell-utils`（win32 spawn PowerShell 有先例） | `dsh/node_modules/powershell-utils` |
| cordis 基础 | `ctx.effect(() => [ctx.on(...), ...])` 注册并自动清理；`@deepseek-ai/cordis` peer | vault-memory 实测 |

---

## 4. 残留未知清单（M1 开工首日逐项确认，勿假设）

1. `JobDoneListener` 精确签名与 `JobSnapshot` payload 字段（`dsh-jobs/lib/types/types.d.ts`）；
2. **Session → 项目名 / 工作目录映射**：`SessionHeader` / `dsh-workspace` 服务如何取 cwd（通知内容 FR-5 依赖）；
3. git 分支获取方式：自读 `.git/HEAD` vs `dsh-workspace` 是否提供；
4. `AskUserQuestionRequestEvent` 字段（问题文本 / 选项，`dsh-user-questions/lib/types/types.d.ts`）——决定提问通知的正文；
5. `user-questions/request` waterfall 的参与规则：观察式监听（记录后 `next()` 透传）是否安全、是否会干扰答案链；
6. `StreamChunk` 形态（FR-1.6 关键词匹配用，P2 前确认即可）；
7. webServer `handler` 的 req/resp 精确形态（返回值约定）；
8. **Windows Toast 真机实测**：PowerShell WinRT 内联脚本弹出 / 进通知中心 / 权限拒绝场景 / `-ExecutionPolicy Bypass` 无策略拦截；
9. 客户端形态确认（web / 桌面壳）→ 影响前台检测比对目标（M2）与点击聚焦（P2）。

---

## 5. 反查路径索引

```
宿主根：~/AppData/Local/hermes/node/node_modules/@deepseek-ai/dsh\
├── package.json                                    # 版本 0.1.2-rc.1
└── node_modules\@deepseek-ai\
    ├── dsh-session\lib\types\index.d.ts            # session/event、session/created、信封
    ├── dsh-session\lib\types\types.d.ts            # SessionEventMap、TurnEndReasonMap（L161/L235/L435）
    ├── dsh-session\lib\types\known-event-types.d.ts
    ├── dsh-agent\lib\types\runtime-types.d.ts      # agent/status、agent/request-error（feihualing 副本同）
    ├── dsh-user-approval\lib\types\{index,types}.d.ts   # ApprovalService、approval/asked|decided
    ├── dsh-user-questions\lib\types\types.d.ts     # user-questions/request waterfall
    ├── dsh-jobs\lib\types\index.d.ts               # ctx.jobs、onJobDone
    ├── dsh-settings\lib\types\index.d.ts           # settings.register 签名（L216）
    ├── dsh-host-webserver\lib\types\index.d.ts     # WebRoute、register（L90）
    └── dsh-atomic-write\…                          # 原子写参考

参考插件：<dsh-plugin-vault-memory 仓库路径>\src\index.mjs   # 入口契约 + settings 用法（真机验证）
本机用户目录：~\.dsh\{profiles, settings.yaml, sessions, data}   # DSH_HOME 实际形态
```
