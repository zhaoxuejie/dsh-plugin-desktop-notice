# Phase 3 接口规范（M3）— 关键词 + 多通道推送 + 历史/统计浮卡 + Linux

> 范围：M3 = FR-1.6 关键词监听 + FR-7 多通道推送 + FR-9 统计与 client 浮卡 + **Linux 适配器**（尽力而为）+ FR-10 按需（TTS / agent 通知工具）。
> 上游：`DESIGN.md`（v0.2）、`docs/step0-calibration.md`、`docs/phase1-interface-spec.md`、`docs/phase2-interface-spec.md`（复用 M1/M2 全部管线与适配器）。
> 状态：规范稿，M2 验收后按此开工。

---

## 1. 交付物与模块增量（M3）

```
src/
├── keywords.mjs           # FR-1.6 流式关键词匹配
├── push/
│   ├── index.mjs          # 通道接口 + 分级路由
│   ├── bark.mjs / ntfy.mjs / webhook.mjs
├── stats.mjs              # FR-9.2 统计聚合
├── server.mjs             # 扩展：history / stats 查询路由
├── client.js              # FR-9.3 overlay 浮卡（dsh.client 契约）
├── adapters/linux.mjs     # notify-send + paplay
├── tts.mjs                # FR-10 TTS（可选，默认关）
└── tools/notify-send.mjs  # FR-10 agent 通知工具（defineTool）
package.json               # 增补 dsh.client: { platform: "web" } + exports["./client"]
```

## 2. 关键词监听（keywords.mjs，FR-1.6）

- 数据源：`session/event` 的 `assistant/chunk`（StreamChunk 形态按校准 §4#6 确认后落地——M3 开工首项）；
- 匹配：per-turn 增量 buffer（内存上限 64KB，超出丢弃头部）；关键词大小写不敏感；`keywords` 配置为空数组即整体关闭；
- 频控：**每 turn 最多 1 条** + 复用 M1 `mergeWindowSeconds` 全局节流——关键词命中的价值在"有信号"，轰炸即失败；
- 触发：产出 `kind: 'keyword'` 的 NoticeEvent（detail = 命中词 + 上下文 ±30 字符），走既有管线（含勿扰/合并/历史）；
- 配置：`events.keyword: eventCfg('notice')` + 顶层 `keywords` 数组（M1 schema 已预留）。

## 3. 多通道推送（push/，FR-7）

### 3.1 通道接口与实现

```ts
interface PushChannel { id: 'bark' | 'ntfy' | 'webhook'; send(n: NoticeEvent, cfg): Promise<void> }
```

| 通道 | 调用方式 |
|---|---|
| bark | `POST https://api.day.app/<key>` body `{ title, body, group: 'dsh' }` |
| ntfy | `POST https://ntfy.sh/<topic>` header `Priority: <done=low/waiting=high/error=max>`，body 为纯文本 |
| webhook | `POST <endpoint>` JSON `{ kind, title, body, sessionId, project, time }` + 自定义 headers（万能接口，用户自接飞书/钉钉/Slack） |

统一约束：超时 5s abort；失败静默降级 + 日志（不影响桌面通道）；重试 0 次（通知是尽力而为语义）。

### 3.2 分级路由（设计核心）

- 默认：`done → 仅桌面`；`waiting / error → 桌面 + 手机`（阻塞与失败的成本在"人不在"时最高）；
- 配置：`events[kind].push: boolean` 细粒度覆盖；顶层 `push.provider` 默认 `'off'`；
- **安全边界**：推送内容仅 title + 截断摘要（≤120 字符），不含文件路径之外的任何工作内容；首次开启时 README/配置面板明示"通知摘要将发送到外部服务"（DESIGN 设计原则"本地优先"）；
- `token` 类配置 role secret，不落明文日志。

## 4. 统计（stats.mjs，FR-9.2）

- 落盘：`<DSH_HOME>/data/desktop-notice/stats.json`（.tmp + rename 原子写），按天滚动保留 90 天；
- 聚合口径：`{ date, done, waiting, error, keyword, aiRunMs /* Σ turn 时长 */, waitedMs /* Σ (approval/decided.time - approval/asked.time) */ }`；
- 事件来源全部为已有订阅，零新增订阅点；写入在管线尾部 append 侧路，失败不影响通知；
- 输出供浮卡展示，招牌指标：**"今天 AI 等了你 X 分钟"**（waitedMs）。

## 5. 浮卡（client.js，FR-9.3，vault-memory / daily-digest 契约）

- 契约：`package.json` 声明 `dsh.client: { platform: "web" }` + `exports["./client"]` → `src/client.js`；`lib/client.js` 打包形态同 vault-memory（`window.__ModuleLoader__.load({ id, factory })`，模块导出 `{ name, apply(ctx), }`，apply 返回 dispose）；
- 形态：右下角胶囊「🔔」→ 展开面板（纯 DOM，无框架）：
  - **历史**：近 50 条（GET `/desktop-notice/history?limit=50`），按 kind 着色，标注 suppressed 原因；
  - **统计**：今日四类计数 + AI 运行时长 + 等待时长；
  - **操作**：测试按钮（POST `/desktop-notice/test`）、静音快捷开关（写 settings）、勿扰快捷开关；
- 服务端：`server.mjs` 增 `GET /desktop-notice/history` 与 `GET /desktop-notice/stats`（只读，M2 落盘数据的查询封装）；
- fetch 轮询间隔 30s，浮卡打开时 5s；dispose 清理 DOM 与定时器。

## 6. Linux 适配器（adapters/linux.mjs，尽力而为）

- **Toast**：`spawn('notify-send', [title, body, '-u', urgency, '-a', 'DSH'])`（args 数组，无 shell）；`waiting` / `error` 用 `-u critical`（长驻），其余 `normal`；
- **Sound**：`paplay`（PulseAudio/PipeWire），失败回退 `canberra-gtk-play`，均无则静默；
- **probe**：命令存在性探测（`which`）；无通知守护进程（无头 / WSL）→ 走 FR-2.6 降级链至 noop；
- 不做：前台/全屏检测（无统一 API，默认 off）、点击聚焦、三态样式（notify-send 能力所及仅标题/正文/紧急度）；
- 验收：有 Linux 桌面环境则真机（补测用例），否则代码交付 + 社区验证（对齐开放问题 #7 精神）。

## 7. FR-10 按需项

| 项 | 方案 | 配置 | 备注 |
|---|---|---|---|
| TTS 播报 | win32：PowerShell `System.Speech` `SpeakAsync`（系统自带，离线）；darwin：`say` | `events.tts: boolean` 默认 false；播报文本 = 事件文案 + 耗时，≤60 字 | 摸鱼场景；与 sound 互斥触发（开了 TTS 则该事件不再放 wav） |
| `notify_send` agent 工具 | `defineTool`：`{ name: 'notify_send', parameters: { title, body, kind } }`，注册 `ctx.tools.register`；内部走同一管线（受 F3 节流约束） | 默认注册，可在设置关 | 让 AI 长任务里主动"跑完这批叫我"；工具实现待 M3 开工时以 `dsh-tools` 源码核对签名（校准精神） |
| 番茄钟 | 不排期 | — | backlog 记录，需求验证后再启动 |

## 8. 配置增量（M3 全量字段，叠加 M1/M2）

```js
events: Schema.object({
  /* M1 已有 done/waiting/error */
  keyword: eventCfg('notice'),   // FR-1.6
}),
keywords: Schema.array(Schema.string()).default([]),
push: Schema.object({            // FR-7，默认全关
  provider: Schema.union(['off', 'bark', 'ntfy', 'webhook']).default('off'),
  endpoint: Schema.string(),     // bark key / ntfy topic / webhook URL
  headers: Schema.dict(Schema.string()),
  token: Schema.string().role('secret'),
}),
tts: Schema.boolean().default(false),
```

## 9. 验收映射

| 用例 | 覆盖 |
|---|---|
| T13 关键词命中弹窗 | §2 |
| T14 等待输入推送到手机 | §3 |
| 浮卡 | §5（历史可回看、统计可见"AI 等了你 X 分钟"、测试按钮可用） |
| Linux 弹窗 | §6（有环境则真机） |
| TTS / notify_send | §7（交付即验收：开关生效、工具可调用） |

## 10. 开工任务拆解

1. keywords.mjs（前置：校准 §4#6 StreamChunk 形态确认）；
2. push/ 三通道 + 分级路由 + 安全边界（先 ntfy——最简，再 bark、webhook）；
3. stats.mjs 聚合 + 落盘；
4. server.mjs 查询路由扩展；
5. client.js 浮卡（契约核对 vault-memory 客户端实现后动工）；
6. linux.mjs + probe 扩展；
7. FR-10 按需（TTS → notify_send）；
8. 真机验收 T13/T14 + 浮卡 → README / DESIGN 状态更新。
