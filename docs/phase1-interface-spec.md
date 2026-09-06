# Phase 1 接口规范（M1）— dsh-plugin-desktop-notice

> 范围：M1 = FR-1.1（完成）/ FR-1.2（等待输入）/ FR-1.3（失败）+ FR-2（Windows Toast）+ FR-3（音效）+ FR-8（配置 / 热更新 / 测试路由），仅 Windows 适配器。
> 上游：`DESIGN.md`（v0.2 产品需求与总设计）、`docs/step0-calibration.md`（M0 校准，事件源已全部落定）。
> 状态：规范稿，按此直接开工。

---

## 1. 交付物与目录结构（M1）

```
dsh-plugin-desktop-notice/
├── package.json            # 零构建纯 ESM；exports["."] → src/index.mjs；dsh.bundle.patch
├── cordis.patch.yml        # bundle 挂载声明（同 vault-memory 格式）
├── src/
│   ├── index.mjs           # 入口：name / inject / Config / apply(ctx, entryConfig)
│   ├── config.mjs          # schemastery schema + resolveConfig
│   ├── events.mjs          # 事件订阅 + 归一化（宿主事件 → NoticeEvent）
│   ├── pipeline.mjs        # 过滤器链 + 合并节流 + 渐进提醒状态机 + 渲染分发
│   ├── adapters/
│   │   ├── probe.mjs       # 平台探测（M1 仅 win32）：能力 / 权限 / headless
│   │   ├── win32.mjs       # Toast（PowerShell WinRT）+ SoundPlayer（wav）
│   │   └── noop.mjs        # 无能力平台兜底：仅日志
│   └── server.mjs          # webServer 路由：health / test
├── assets/
│   ├── success.wav         # 内置音效 ×3（来源与许可见 §7）
│   ├── notice.wav
│   └── alert.wav
└── docs/…  README.md
```

M1 不含：history.mjs（M2）、client 浮卡（M3）、push/tts/keywords（M2/M3）。

## 2. 插件入口契约

```js
export const name = "dsh-plugin-desktop-notice";
export const inject = ["settings", "webServer"];   // M1 不用 tools/systemPrompt
export const Config = configSchema;                // §4

export function apply(ctx, entryConfig) {
  // 1) settings.register(name, Config, { applies: "live" }) → scope.get()/watch() 热更新
  // 2) adapters/probe.mjs 探测平台 → 选定 Notifier/SoundPlayer（结果缓存，含降级链决策）
  // 3) events.mjs 订阅（ctx.effect 包裹，返回清理函数）
  // 4) server.mjs 注册 health / test 路由
  // 任何初始化失败：降级为 noop 适配器 + 日志，绝不 throw 出 apply()
}
```

## 3. 事件订阅与归一化（events.mjs）

订阅（全部经 `ctx.effect(() => [...])` 注册，自动清理）：

| 宿主事件 | 订阅方式 | 用途 |
|---|---|---|
| `session/event`（`ctx.on`） | 被动广播 | 主源：`turn/end`、`approval/asked`、`approval/decided`、`turn/start`、`user/message`、`assistant/message` |
| `agent/session-start` | 被动广播 | 历史（M1 仅日志） |
| `user-questions/request`（agent 作用域 waterfall） | 观察式：记录后 `next()` 透传 | FR-1.2 提问分支（**透传安全性按校准 §4#5 确认后再启用**） |
| `ctx.jobs.onJobDone` | 监听 + 取消订阅 | P1 并入完成通知，M1 不启用 |
| `agent/request-error` | **不订阅弹窗**，仅 debug 日志 | 校准 R2：瞬时错误含重试语义 |

归一化映射表（宿主事件 → 内部 `NoticeEvent`）：

```ts
interface NoticeEvent {
  kind: "done" | "waiting" | "error";
  sessionId: string;
  project?: string;     // ← 校准 §4#2 落定取法；M1 兜底：sessionId 前段
  branch?: string;      // ← 校准 §4#3；取不到则省略该字段
  durationMs?: number;  // ← turn/end.time - turn/start.time（信封 time, epoch ms）
  summary?: string;     // ← 本 turn 最后一条 assistant/message.message 纯文本截断
  tokens?: number;      // ← assistant/message.usage（可得时）
  detail?: string;      // waiting: approval/asked.toolName + reason；error: LlmFailure 摘要
  raw: unknown;
}
```

触发规则：

| NoticeEvent.kind | 宿主触发条件 | 备注 |
|---|---|---|
| `done` | `session/event` 且 `type==='turn/end'` 且 `reason.kind==='completed'`（`'max-tokens'` 亦归 done，detail 标注） | 空转（turn 无 `step/end`，如仅输入被拒）不通知，防噪音 |
| `waiting` | `type==='approval/asked'` | `detail = toolName + (reason ? ' · ' + reason : '')`；同一 `id` 只触发一次 |
| `waiting` 复位 | `type==='approval/decided'`（同 id）或 `type==='user/message'` | 复位渐进提醒计时器 |
| `error` | `turn/end` 且 `reason.kind==='error'` | `detail = reason.error` 的 message/code（LlmFailure 摘要 ≤120 字符） |
| 计时状态 | `turn/start` 记 `startTime`；`turn/end` 汇总 | per-session 内存 Map，`session/disposed` 时清理 |

## 4. 配置 schema（config.mjs，M1 全量字段）

```js
export const configSchema = Schema.object({
  enabled: Schema.boolean().default(true),

  events: Schema.object({
    done:    eventCfg("success"),  // { desktop: boolean, sound: 'success'|'notice'|'alert'|'off'|自定义文件名 }
    waiting: eventCfg("notice"),
    error:   eventCfg("alert"),
  }),

  preview: Schema.object({         // FR-5.5：系统通知会截断长文本
    titleMax: Schema.number().min(10).max(64).default(40),
    bodyMax:  Schema.number().min(40).max(300).default(120),
  }),

  mergeWindowSeconds: Schema.number().min(0).max(120).default(10),      // 防轰炸（FR-4.4 的 M1 子集）
  escalateWaitingMinutes: Schema.number().min(0).max(60).default(5),    // 渐进提醒（FR-4.5 的 M1 子集；0=关）
  volume: Schema.percent().default(60),

  debug: Schema.boolean().default(false),
});
// eventCfg(sound) = Schema.object({
//   desktop: Schema.boolean().default(true),
//   sound:   Schema.union(["success","notice","alert","off"]).default(sound),
// })
```

`resolveConfig(entryConfig)`：settings scope 热值覆盖 entryConfig 默认，供 `scope.watch` 回调重建运行时配置（vault-memory 同款）。

## 5. 管线（pipeline.mjs）

```
NoticeEvent → [F1 enabled 总开关] → [F2 事件开关 events[kind]] → [F3 合并节流] → [F4 渐进提醒状态机] → 渲染分发（desktop / sound 并行、互不等待）→ 日志
```

- **F3 合并节流**：每 `kind` 维护窗口队列，窗口 = `mergeWindowSeconds`；窗口内第 2 条起合入队列，窗口结束时发一条合并通知（"N 个任务完成"或逐条列出 ≤3 条）；窗口内首条立即发（不延迟首条）。
- **F4 渐进提醒状态机（仅 waiting）**：`approval/asked` → 发首条 + 启动计时器；`escalateWaitingMinutes > 0` 且未复位 → 到时重发（重复 notice 音效，正文标注"仍在等你"）；复位信号（§3 表）→ 清计时器。每会话仅一个活动计时器，`session/disposed` 清理。
- **渲染分发**：`desktop` 与 `sound` 两个通道独立 try/catch + 独立降级；任一失败不影响另一通道，均不影响 DSH 主流程。
- M1 预留 F5（前台检测）、F6（勿扰时段）的过滤器接口位（P1 插入，不改管线结构）。

## 6. 平台适配器（adapters/）

### 6.1 probe.mjs（启动探测一次，结果缓存）

探测项（按序）：`process.platform` → win32 命令可用性（powershell.exe 在 PATH）→ **headless**（无交互桌面会话：`process.env.SESSIONNAME` 为空 / 以 `Console` 以外的远程会话特征 / WSL 判定）→ Toast 试发结果（首条真实通知即验证）。
输出：`{ adapter: 'win32' | 'noop', capabilities: { toast: bool, sound: bool }, degraded: [原因...] }`。探测失败 → noop 适配器 + 日志警告（FR-2.6）。

### 6.2 win32.mjs — Toast

- Node 侧组装 **JSON payload 写入临时文件**（ `%TEMP%\dsh-notice-<ts>.json`，含 title/body/kind/silent），spawn：
  `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File <script.ps1>`（脚本随插件分发，payload 走文件不走命令行，规避引号/注入问题）；
- 脚本内联 WinRT：`ToastNotificationManager` + `ToastGeneric` 模板（title + body 两行）；`scenario="reminder"` 用于 waiting（长驻），其余默认短驻；Toast `<audio silent="true"/>`——声音由独立通道控制，不交给系统默认音；
- AUMID 用 PowerShell 官方标识（零注册弹出，进 Windows 通知中心）；
- **spawn 状态机**：单飞（同会话 1s 内去重）、超时 5s kill、连续 3 次失败熔断（本会话静默 + 日志）；
- 临时文件用后即删，异常路径由下次启动清理（>1h 的残留）。

### 6.3 win32.mjs — SoundPlayer

- 播放 wav：优先 **MCI（winmm.dll，Add-Type P/Invoke）** `open → setaudio volume to <0..1000> → play wait → close`——MCI 是 Windows 上唯一可编程音量的 wav 播放路径；MCI 失败 → 后备 `System.Media.SoundPlayer`（无音量控制，音量形同 100%）；两者都失败 → 仅 Toast；
- 自定义音效：`sound` 为文件名时在配置目录解析（M1 仅支持绝对路径/相对插件 assets 的文件名，目录选择器 P1）；
- 校准 §4#8 实测项：MCI 音量曲线 / SoundPlayer 后备 / 权限拒绝场景。

## 7. 内置音效资产

`assets/{success,notice,alert}.wav`：16-bit PCM 44.1kHz 单声道，< 300KB/个。来源二选一（开工时定）：① 自制合成音（CC0，无许可负担）；② 精选 CC0 音效库。**禁用**无许可的系统音提取。

## 8. Web 路由（server.mjs）

| 路由 | 方法 | 行为 |
|---|---|---|
| `/desktop-notice/health` | GET | `{ adapter, capabilities, degraded, headless, lastError?, version }`——降级可视化 |
| `/desktop-notice/test` | POST | body `{ kind: 'done' \| 'waiting' \| 'error' }` → 用样例 NoticeEvent 走完整管线（含音效）发一条测试通知；`kind` 缺省轮流发三态 |

handler 形态按校准 §4#7 确认后落地；路由注册失败仅日志，不影响通知主链路。

> Windows 友好验证（不用 curl）：① 浏览器直开 test/health URL（GET 即可，`?kind=` 指定）；② `npm run notify:test -- [kind]`（内置 fetch 客户端，先 health 后 test，失败给排查提示）；③ PowerShell `irm <url>`。test 响应体带 `toast` / `sound` 各通道结果。

## 9. 日志与降级

- 日志文件：`<DSH_HOME>/data/desktop-notice/notice.log`（滚动：>5MB 截断）；`debug=true` 时额外记录每次 spawn 命令、耗时、退出码、payload；
- **降级链**（FR-2.6）：Toast 失败 → 仅音效 → 仅日志；熔断后 `health` 路由可见 `degraded` 原因；
- 铁律：管线内所有异步路径 try/catch，**任何异常不得逃逸到事件回调之外**。

## 10. 验收映射（对照 DESIGN §2.3）

| 用例 | 覆盖 |
|---|---|
| T1 完成 / T2 等待 / T3 失败 | §3 触发规则 + §6.2 Toast |
| T4 测试通知 | §8 test 路由 |
| T5 热更新 | §2 settings scope.watch |
| T6 权限关闭 | §6.1 probe + §9 降级链 |
| T7 headless | §6.1 探测 → noop |
| T8 事件风暴 | §5 F3 合并节流 |

## 11. 开工任务拆解（建议顺序）

1. 脚手架：package.json / cordis.patch.yml / index.mjs 契约 / config.mjs；
2. adapters/probe + win32（Toast 先通，真机单发成功）——**§4#8 实测前置**；
3. SoundPlayer（MCI 主路径 + 后备）；
4. events.mjs 订阅 + 归一化（先只接 `session/event`）；
5. pipeline.mjs（F1/F2 → F3 → F4 → 分发）；
6. server.mjs health/test；
7. 日志 + 熔断 + 降级收口；
8. 真机验收 T1–T8 → 更新 README 状态表。
