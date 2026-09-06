# dsh-plugin-desktop-notice — 产品需求与设计（v0.2 草案）

> 定位一句话：**让 DSH 的每一次"需要你"都及时抵达桌面——任务完成、卡住等确认、出错失败，右下角弹窗 + 音效一秒知晓；人不在电脑前，手机也能收到。**
> 状态：设计阶段，未开工。v0.2：已逐条评估并合并用户参考稿（取舍见 §0.5）。拍板后再写接口规范（docs/phase1-interface-spec.md）并开工。
> 系列对齐：`dsh-plugin-vault-memory`（同系列文档风格、插件范式与校准流程）。

---

## 0. 为什么做这个插件：价值与痛点

### 0.1 核心洞察

DSH 是一个整天帮你干活的 AI 工作台，但"干活中 / 干完了 / 卡住了"的状态变化都发生在终端里。用户一旦切走（回微信、看文档、开会、摸鱼），就只剩两种糟糕的选择：

- **盯屏等待**：人被 AI 绑架，跑一个 5 分钟的任务就干瞪 5 分钟；
- **回头才知**：回来发现 AI 20 分钟前就完成了；或者更糟——**AI 19 分钟前就停下来等权限确认，干等你到现在**，你的时间在静默燃烧。

桌面上无数应用都会"主动找你"，唯独你最常用的生产力工具是哑巴。本插件补上这一块：

> **干活（DSH 会话） ↔ 提醒（操作系统桌面）**

### 0.2 痛点 → 解法 → 需求映射

| # | 痛点 | 解法 | 对应需求 |
|---|---|---|---|
| 1 | **AI 卡住等确认，你不知道**（最贵：烧的是你的时间） | "等待输入"事件即时弹窗 + 渐进式强提醒 | FR-1.2 / FR-4.5 |
| 2 | **任务完成时机不可知**，反复切窗口刷进度 | 完成事件弹窗，带耗时与结果摘要 | FR-1.1 / FR-5 |
| 3 | **任务失败了，很久才发现** | 错误事件红标弹窗 + 独立音效 | FR-1.3 |
| 4 | **通知疲劳**：弹多了被关掉，插件就死了 | 前台检测（你在看就不弹）、勿扰汇总、防轰炸合并 | FR-4 |
| 5 | **人不在电脑前**：下楼吃饭 / 开会，错过完成时机 | 多通道推送（Bark / ntfy / 自定义 webhook），按事件分级路由 | FR-7（P2） |
| 6 | **多项目并行分不清**哪个会话完成了 | 通知带项目名 / git 分支 / 工作目录 | FR-5 |
| 7 | **配了不知道有没有生效** | 一键"发送测试通知" | FR-8.3 |

### 0.3 给谁用

- **DSH 重度用户**：长任务多（编码 / 调研 / 批量处理），习惯切走干别的；
- **多会话并行用户**：同时跑几个项目，需要分得清谁完成了、谁在等；
- 所有有过"AI 干等我、我干等 AI"经历的人。

### 0.4 设计原则

- **绝不妨碍主流程**：通知链路任何失败（PowerShell 调用失败、音效文件丢失、推送超时）一律静默降级 + 记日志，绝不影响 agent 执行；
- **不打扰是默认值**：前台检测、防轰炸默认开启；宁可少弹，不误弹；
- **本地优先**：通知内容不出机器；多通道推送是唯一外发点，默认关闭，开启时在配置里明示；
- **零常驻**：事件驱动、按需 spawn 外部进程，无常驻后台进程，空闲资源占用趋近于零。

### 0.5 与参考稿的合并取舍（v0.2 新增）

用户提供了一份参考稿《DeepSeek-Harness 桌面通知插件详解》，本版已逐条评估合并：

| 参考稿内容 | 处置 | 说明 |
|---|---|---|
| 完成/报错通知、防抖合并、夜间静默、点击聚焦、总开关+分类开关 | ✅ 已有（FR-1/3/4/6/8） | 与本设计一致 |
| 长任务超时提醒 | ✅ 保留并调优（FR-1.4） | 默认阈值 45s → **600s**：45s 内多数编码任务仍在正常跑，按 45s 提醒会变成骚扰 |
| **自定义关键词触发通知** | ✅ 保留（FR-1.6，P2 默认关） | 有真实价值（盯 error 等信号词），依赖流式订阅，放 P2 |
| 通知预览长度（标题≤40 / 正文≤120） | ✅ 保留（FR-5.5） | 实用细节，系统通知会截断长文本 |
| 权限检测 + 控制台警告 | ✅ 保留（FR-2.6 环境自检） | |
| headless 环境自动禁用 | ✅ 保留并泛化到全平台（FR-2.6） | 不限于 Linux 服务器 |
| 后台运行条件说明 | ✅ 保留（§2.2 边界） | |
| 测试用例清单 | ✅ 保留并扩充（§2.3） | 融合为真机验收清单 |
| **工具调用完成通知**（每次工具执行都弹） | ❌ 移除 | 一次任务动辄几十次工具调用，逐一弹窗即通知轰炸；`tools/post-execute` 降级为内部数据源（耗时统计 / 心跳） |
| **新会话/消息事件弹窗** | ⚠️ 降级为不弹窗 | 保留为历史记录（FR-1.5）——新会话开始无需用户立即响应，弹窗属噪音 |
| **node-notifier 依赖 + TS 构建链**（tsconfig/dist） | ❌ 移除 | 与系列 A 路线（零构建纯 ESM、零捆绑二进制）冲突；跨平台由自研 spawn 适配层覆盖（§3.4），node-notifier 仅记为后备方案 |
| `onModelComplete` 等钩子名 | ⚠️ 修正 | 校准结论：DSH 真实事件为 `session/event` / `jobs.onJobDone` 等，映射表见 §3.3 |
| 第六部分"AI 生成提示词" | ❌ 移除 | 不属于设计文档；待接口规范定稿后基于真实 API 重新生成一份更准确的 |

---

## 1. 产品形态

- **插件名**：`dsh-plugin-desktop-notice`（与目录一致）
- **形态**：bundle 插件（Node 侧：事件订阅 + 过滤管线 + spawn 外部进程）；P2 增补 client overlay 浮卡（设置 / 历史 / 统计面板）
- **目标平台**：Windows 10/11 **M1 首发**（当前主环境）；macOS **M2** 跟进；Linux **M2/M3 尽力而为**。三平台共用同一套事件/过滤/分发管线，仅在"弹窗、音效、前台检测"三个触点上走**平台适配层**，能力按平台自动降级（见 §3.4）。
- **数据落盘**：`<DSH_HOME>/data/desktop-notice/`（历史记录 + 统计，`.tmp` 写入后 `rename` 原子替换）

---

## 2. 需求说明书

### 2.0 功能总览与优先级

| 模块 | 内容 | 优先级 |
|---|---|---|
| FR-1 | 事件订阅（完成 / 等待输入 / 失败 / 心跳 / 关键词） | **P0**（P0 仅前三项） |
| FR-2 | 桌面弹窗通知（Windows Toast） | **P0** |
| FR-3 | 音效引擎（内置音效 / 音量 / 按事件独立） | **P0** |
| FR-4 | 防打扰引擎（前台检测 / 全屏 / 勿扰时段 / 防轰炸 / 渐进提醒） | P1 |
| FR-5 | 通知内容增强（项目 / 分支 / 耗时 / 摘要） | P1 |
| FR-6 | 交互（点击聚焦、通知中心可回看） | P1~P2 |
| FR-7 | 多通道推送（Bark / ntfy / webhook） | P2 |
| FR-8 | 配置矩阵 + 热更新 + 测试通知 | **P0** |
| FR-9 | 通知历史 + 统计（overlay 面板） | P2 |
| FR-10 | TTS 语音播报 / agent 主动通知工具 | P2（发散储备） |

### FR-1 事件订阅（触发时机）

插件核心是事件驱动的通知管线。订阅 DSH 会话事件，映射为通知事件：

| 编号 | 通知事件 | 触发源（✅ 已校准，详见 docs/step0-calibration.md） | 默认动作 | 优先级 |
|---|---|---|---|---|
| FR-1.1 | **任务完成** | `session/event` 的 `turn/end`（reason.kind=`completed`，`max-tokens` 并入并标注）；后台任务辅以 `jobs.onJobDone`（P1） | 弹窗 + 成功音效 | P0 |
| FR-1.2 | **等待用户输入**（agent 提问、权限/工具确认） | `session/event` 的 `approval/asked`（权限确认）+ `user-questions/request`（agent 提问）——**校准确认存在** | 弹窗 + 提醒音效，文案强调"在等你" | P0 |
| FR-1.3 | **任务失败 / 报错** | `session/event` 的 `turn/end`（reason.kind=`error`，终态失败）；`agent/request-error` 仅记日志（含重试语义，逐次弹窗即误报） | 弹窗 + 失败音效，红标样式 | P0 |
| FR-1.4 | 长任务心跳 | `turn/start` 驱动计时状态机：任务运行超过阈值（默认 600s，可配） | 弹一次"任务仍在运行"，此后每 N 分钟最多一次防重复（默认关） | P1 |
| FR-1.5 | 会话开始 | `agent/session-start` / `session/created` | 不弹窗，仅写历史 | P1 |
| FR-1.6 | 关键词命中 | `session/event` 的 `assistant/chunk`（流式增量） | 输出命中配置关键词（如 error / 完成 / TODO）即弹窗（默认关） | P2 |

> ✅ 校准结论（2026-09-05，详见 docs/step0-calibration.md）：FR-1.2 两个事件源均确认存在，**原"M1.5 降级预案"作废，直接进 M1**；FR-1.3 主源由 `agent/request-error` 改为 `turn/end(kind='error')`（前者为 waterfall + 重试语义，防误报）；耗时由事件信封 `time`（epoch ms）直接计算。

> 🚫 去噪决策（吸收参考稿时的取舍）：**"每次工具调用完成都通知"不作为事件**——一次任务动辄触发几十次工具执行，逐一弹窗即通知轰炸；`tools/post-execute` 仅作内部数据源（耗时统计、长任务心跳）。同理"新会话/新消息"不弹窗，仅入历史（FR-1.5）。

### FR-2 桌面弹窗（平台适配层）

- FR-2.1 统一要求：弹窗**不依赖 DSH 客户端窗口可见**——用户切到任何应用都能看到；M1 落地 **Windows 原生 Toast**（右下角弹出、自动进 Windows 通知中心）；
- FR-2.2 Windows 实现路线：Node 侧 spawn PowerShell 内联脚本调用 WinRT `Windows.UI.Notifications`（无需安装 BurntToast 等第三方模块，开箱即用）；macOS / Linux 路线见 §3.4 适配层表格；
- FR-2.3 通知三态样式：成功（默认图标）/ 等待（黄）/ 失败（红），标题 + 正文两行结构；
- FR-2.4 通知停留时长按事件区分（完成 ~6s 自动消失；等待输入建议长驻，靠用户处理）；
- FR-2.5 spawn 防护：并发去重（同一会话 1s 内不重复 spawn）、超时杀进程、失败静默；
- FR-2.6 **环境自检与跨平台降级链**：适配层启动时对当前平台探测一次并缓存结果——命令存在性（osascript / notify-send）、系统版本、**通知权限状态**、**headless 环境**（无桌面会话 / WSL / SSH，自动禁用弹窗）；弹窗不可用 → 降级为仅音效；音效也不可用 → 降级为仅历史记录 + debug 日志；权限不足或环境不支持时在 DSH 日志/控制台输出警告（README 同步写明各平台授权方式），插件绝不报错崩溃、绝不影响 agent 主流程。

### FR-3 音效引擎

- FR-3.1 内置 3 套音效：成功（清脆短音）、等待输入（双音提示）、失败（低沉提示）；
- FR-3.2 音量 0–100 可调，0 即静音；每事件可独立选择：内置音效 / 自定义 wav / 静音；
- FR-3.3 自定义音效：配置目录，支持 `.wav`（v1 仅 wav，`System.Media.SoundPlayer` 原生播放；mp3 留待后续评估）；
- FR-3.4 播放与弹窗解耦：音效失败不影响弹窗，反之亦然。

### FR-4 防打扰引擎（本插件差异化核心）

通知管线的过滤器链，按序执行：

- FR-4.1 **前台检测**（默认开）：DSH 客户端窗口正处于前台焦点时，说明用户正盯着看 → 不弹 Toast、不响音效（可配置改为仅响音效）；
- FR-4.2 **全屏/演示检测**（默认开）：`SHQueryUserNotificationState` 检测全屏应用 / 投屏状态 → 静默，通知转入队列；
- FR-4.3 **勿扰时段**：按星期 + 时间段（如 22:00–08:30）静默；可一键临时勿扰（托盘/浮卡，P2）；
- FR-4.4 **防轰炸合并**：多会话短时间内连续完成 → 合并为一条"N 个任务完成"；同类通知设最小间隔（默认 10s）；
- FR-4.5 **渐进式提醒**（针对"等待输入"）：首次轻提醒 → N 分钟未处理（默认 5 分钟）→ 再次强提醒（重复音效）；处理过即复位；
- FR-4.6 **勿扰汇总**：勿扰期间的通知不丢弃，进队列；勿扰结束时（或用户回到前台时）合并为一条摘要："刚才 3 个任务完成、1 个在等你"。

### FR-5 通知内容

通知正文模板（示例）：

```
✅ 任务完成 · moqian-web (feat/notify)
耗时 4 分 12 秒 · 改动 5 个文件
"已将通知组件接入设置页，测试通过…"
```

- FR-5.1 标题行：状态图标 + 事件类型 + **项目名 + git 分支**；
- FR-5.2 元信息行：**耗时**、改动文件数等（以事件 payload 实际可得字段为准，校准后定稿）；
- FR-5.3 摘要行：AI 最后一条消息 / 任务结论截断（~60 字），让用户不回终端也能判断要不要立刻回来；
- FR-5.4 所有字段尽力而为：取不到就不显示该行，绝不阻塞、绝不编造；
- FR-5.5 **预览长度可配**：标题默认 ≤40 字符、正文默认 ≤120 字符（系统通知会截断长文本），配置项 `preview.titleMax / bodyMax`（吸收自参考稿）。

### FR-6 交互

- FR-6.1 点击通知 → 尝试激活 DSH 客户端窗口（P1，探索项：Toast launch 激活回调，受 WinRT 协议激活机制约束，校准后定稿）；
- FR-6.2 通知进 Windows 通知中心可回看（Toast 路线天然获得，零成本）；
- FR-6.3 Toast 操作按钮（"查看" / "忽略"）：P2 评估，依赖激活回调可行性。

### FR-7 多通道推送（P2）

- FR-7.1 通道：Bark（iOS）/ ntfy.sh / PushPlus / 自定义 webhook（POST JSON，万能接口）；
- FR-7.2 **按事件分级路由**：完成→仅桌面；等待输入→桌面+手机（阻塞在烧用户时间）；失败→桌面+手机；
- FR-7.3 推送失败静默降级，记录日志；推送内容仅含摘要，不含敏感文件内容；
- FR-7.4 默认全关，首次开启时配置面板明示"内容将发送到外部服务"。

### FR-8 配置与测试

- FR-8.1 配置接入 `settings.register`（schemastery schema，`applies: "live"` 热更新）；
- FR-8.2 **配置矩阵**：事件（完成/等待/失败/心跳）× 通道（弹窗/音效/推送）独立开关与参数，见 §3.6 schema 草案；
- FR-8.3 **"发送测试通知"**：`webServer.register` 提供 `/desktop-notice/test` 路由（P2 浮卡上做按钮），发送一条全样式测试弹窗 + 音效，用于验证配置；
- FR-8.4 预设档位：安静（仅等待输入+失败）/ 均衡（默认）/ 全开，一键切换。

### FR-9 历史与统计（P2）

- FR-9.1 通知历史落盘 `history.jsonl`（时间、事件、会话、项目、处理状态），上限滚动清理（默认保留 30 天 / 1000 条）；
- FR-9.2 统计：今日完成任务数、AI 总运行时长、**"今天 AI 等了你 X 分钟"**（量化阻塞成本，戳中痛点）；
- FR-9.3 client overlay 浮卡（右下角胶囊，daily-digest 范式）：历史列表 + 统计 + 设置入口 + 测试按钮。

### FR-10 发散储备（P2，暂不承诺）

- **TTS 语音播报**：Windows SAPI 念"任务完成，耗时 3 分钟"——摸鱼时不用看屏幕（可开关，默认关）；
- **`notify_send` agent 工具**：注册 defineTool，让 AI 在长任务里主动发通知（"跑完这批叫我"）；
- **番茄钟模式**：专注期内强制勿扰，结束统一汇总。

### 2.1 非功能需求

| 项 | 要求 |
|---|---|
| 性能 | 事件→弹窗端到端延迟 < 1.5s（含 PowerShell spawn ~200–500ms）；空闲时零 CPU 占用、零常驻进程 |
| 可靠性 | 通知链路任何异常静默降级，绝不影响 agent 主流程；spawn 有超时与进程清理 |
| 隐私 | 通知内容仅本机展示；推送为唯一外发点且默认关闭；历史记录仅存本地 |
| 跨平台 | Windows 10 1809+（WinRT Toast）、macOS 12+（`osascript` 零依赖路线，注意首次授权）、Linux 桌面环境（notify-daemon 存在时）；不满足条件走 FR-2.6 降级链；无 PowerShell 执行策略依赖（`-ExecutionPolicy Bypass`）；均不依赖 DSH 客户端是否可见 |
| 可观测 | debug 日志开关，落 `debug.log`（feihualing 先例） |
| 运行边界 | 依赖 DSH 宿主进程存活：事件由宿主进程发出，进程退出则通知随之停止（预期行为，不做独立常驻守护）；headless / 无桌面会话自动禁用（FR-2.6） |

### 2.2 边界与限制

- **依赖 DSH 宿主进程运行**：事件源在宿主进程内，进程完全退出则无从通知。本插件不做独立常驻守护（那需要另一个进程模型 + 跨进程事件总线，超出 v1 范围）；
- **系统通知权限**：Windows 需允许应用通知；macOS 首次触发弹系统授权，拒绝后静默失效——插件做权限自检并在日志警告（FR-2.6），README 写明各平台授权方式；
- **headless / 服务器 / WSL 无桌面环境**：自动禁用弹窗与音效，仅保留历史记录；
- **系统通知字符上限**：Windows 对过长的标题/正文会截断 → 预览长度可配（FR-5.5）。

### 2.3 真机测试用例（验收清单）

| 编号 | 用例 | 预期 | 阶段 |
|---|---|---|---|
| T1 | 跑长任务后切走，等其完成 | 弹窗+音效到达，含项目/耗时/摘要 | M1 |
| T2 | 触发权限确认后切走 | 弹窗强调"在等你"（事件若缺失挂 M1.5） | M1 |
| T3 | 制造 agent 请求错误 | 红标弹窗 + 失败音效 | M1 |
| T4 | 调用测试通知路由 | 三态样式各发一条，含音效 | M1 |
| T5 | 修改音量 / 关闭某事件开关 | 热更新立即生效，无需重启 | M1 |
| T6 | 关闭系统通知权限后触发事件 | 插件不崩溃，日志警告，降级链生效 | M1 |
| T7 | WSL / headless 环境运行 | 自动禁用弹窗，无报错 | M1 |
| T8 | 短时间连续多条完成事件 | 防抖合并为一条通知 | M1 |
| T9 | DSH 窗口处于前台时触发事件 | 不弹窗（按配置可仅响音效） | M2 |
| T10 | 全屏视频 / 演示中触发事件 | 静默入队，退出后汇总一条 | M2 |
| T11 | 勿扰时段内触发事件 | 静默，时段结束后汇总 | M2 |
| T12 | 任务运行超过心跳阈值 | 弹一次"仍在运行"，不重复轰炸 | M2 |
| T13 | 输出命中关键词（默认关，开启后） | 弹窗提醒 | M3 |
| T14 | 等待输入事件推送到手机 | Bark / ntfy 收到推送 | M3 |
| T15 | macOS 真机三类事件 | 弹窗+音效可用，首次授权流程顺畅 | M2 |

---

## 3. 技术设计

### 3.1 已校准的 DSH 插件 API 事实（沿用 vault-memory §0.4 校准结论）

- 插件入口：`export const name` / `export const inject = [...]` / `export function apply(ctx, config)`；
- 配置：schemastery `Schema.object({...})`，`settings.register(name, CONFIG_SCHEMA, { applies: "live" })` → `scope.get()` / `scope.watch(cb)`，热更新；
- 事件：`ctx.effect(() => [ctx.on(...), ...])`；已见事件：`agent/request-error`、`agent/session-start`、`session/event`、`jobs.onJobDone`、`tools/post-execute`；
- Web：`webServer.register({ kind: "exact", path, handler })`；
- 数据落盘范式：`<DSH_HOME>/data/<插件名>/` + `.tmp` 写入后 `rename` 原子替换；`DSH_HOME = process.env.DSH_HOME ?? <harness 根>`；
- Client 插件契约（P2 浮卡用）：`package.json` 声明 `dsh.client: { platform: "web" }` + `exports["./client"]`，纯 DOM overlay + fetch 轮询（daily-digest / vault-memory 先例）；
- 代码形态：**A 路线——零构建纯 ESM（`.mjs`），源码即产物**，无 tsdown 构建链（同 vault-memory 最终决策）。

### 3.2 架构总览

```
┌────────────────────────── DSH host（Cordis）───────────────────────────┐
│                                                                        │
│  dsh-plugin-desktop-notice (bundle, 纯 ESM)                            │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │ ① 事件订阅层   ctx.on(session/event / jobs.onJobDone / …)         │  │
│  │      │          归一化为内部 NotificationEvent                    │  │
│  │      ▼                                                            │  │
│  │ ② 过滤器链     前台检测 → 全屏检测 → 勿扰时段 → 节流/合并          │  │
│  │      │          （未通过 → 入勿扰队列，FR-4.6）                    │  │
│  │      ▼                                                            │  │
│  │ ③ 渲染分发器   按配置矩阵分发到各通道（通道间互不阻塞）            │  │
│  │      ├─→ Desktop: spawn PowerShell WinRT Toast                    │  │
│  │      ├─→ Sound:   spawn PowerShell 播 wav（内置/自定义）           │  │
│  │      ├─→ Push:    fetch → Bark / ntfy / webhook（P2）             │  │
│  │      └─→ History: append history.jsonl + 统计累计                 │  │
│  │ ④ 渐进提醒     本地定时器：等待输入 N 分钟未处理 → 强提醒          │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                        │
│  P2: client overlay 浮卡（历史 / 统计 / 设置 / 测试按钮）               │
│      ↕ webServer.register 路由（/desktop-notice/test|history|stats）   │
└────────────────────────────────────────────────────────────────────────┘
```

### 3.2.1 代码结构（零构建纯 ESM，源码即产物）

```
src/
├── index.mjs          # 入口：name / inject / apply(ctx, config)，事件订阅注册
├── pipeline.mjs       # 通知管线：过滤器链（勿扰/节流/合并）+ 渲染分发器 + 渐进提醒定时器
├── adapters/
│   ├── probe.mjs      # 平台探测：命令存在性 / 通知权限 / headless，选定适配器（FR-2.6）
│   ├── win32.mjs      # Toast（PowerShell WinRT）+ SoundPlayer + 前台/全屏检测
│   ├── darwin.mjs     # osascript + afplay + frontmost（M2）
│   └── linux.mjs      # notify-send + paplay（M3，尽力而为）
├── history.mjs        # history.jsonl + 统计累计（P2）
└── types.mjs          # JSDoc 类型（纯 ESM 无编译，无 tsconfig / dist）
```

> 对应参考稿目录结构的修正版：无构建链、无 node-notifier；参考稿 `notifier.ts` 的职责拆入 `pipeline.mjs` + `adapters/`（通知逻辑与平台实现分离）。

### 3.3 事件归一化

**参考稿钩子意图 → DSH 真实事件源映射**（✅ M0 已按宿主 v0.1.2-rc.1 源码校准，payload 细节见 docs/step0-calibration.md）：

| 参考稿意图 | DSH 事件源（已校准） | 归一化用途 |
|---|---|---|
| onModelComplete | `session/event` 的 `turn/end`（reason.kind=`completed`） | FR-1.1 完成通知；耗时 = 事件信封 `time` 差值 |
| onToolFinish | `tool/call` / `tool/result` | **不作通知事件**；耗时统计与心跳数据源 |
| onError | `turn/end`（reason.kind=`error`，含 LlmFailure） | FR-1.3 失败通知（`agent/request-error` 仅记日志） |
| onMessageOutput | `assistant/chunk` / `assistant/message`（含 usage） | FR-1.6 关键词匹配（P2）；摘要行与 token 数 |
| — | `approval/asked` / `approval/decided`、`user-questions/request` | FR-1.2 等待输入 + 渐进提醒复位 |
| — | `agent/session-start` / `session/created` | FR-1.5 历史记录 |

订阅层将宿主事件归一化为统一内部结构，下游只认这个结构：

```ts
interface NoticeEvent {
  kind: "done" | "waiting" | "error" | "heartbeat" | "session-start";
  sessionId: string;
  project?: string;      // 工作目录 basename
  branch?: string;       // git 分支（尽力而为）
  durationMs?: number;   // 任务耗时
  summary?: string;      // AI 最后一条消息截断
  raw?: unknown;         // 原始 payload，调试用
}
```

### 3.4 通知与音效渲染：平台适配层

适配层只暴露两个接口：`Notifier.notify(event, style)` 与 `SoundPlayer.play(file, volume)`，每平台各提供一套实现，全部走 **spawn 系统自带命令**（零第三方依赖，与 A 路线一致）：

| 能力 | Windows（M1） | macOS（M2） | Linux（M2/M3 尽力） |
|---|---|---|---|
| **弹窗** | WinRT Toast（PowerShell 内联，进通知中心） | `osascript -e 'display notification …'`（系统自带，零依赖）；备选 `terminal-notifier`（支持点击动作，需随插件带二进制，评估后定） | `notify-send`（freedesktop 标准方案，多数桌面发行版自带） |
| **音效** | `System.Media.SoundPlayer`（仅 wav） | `afplay`（wav / mp3 都支持） | `paplay`（PulseAudio / PipeWire）或 `canberra-gtk-play` |
| **前台检测**（P1） | `GetForegroundWindow` 对比客户端窗口句柄 | `osascript` 查客户端进程 frontmost（M2 校准） | xdotool / wmctrl（仅 X11；Wayland 下缓行） |
| **全屏/勿扰检测**（P1） | `SHQueryUserNotificationState` | **系统自带专注模式（Focus）会自动抑制通知**，插件该项可默认放宽 | 无统一标准 → 该项默认关闭 |
| **点击聚焦**（P2 探索） | Toast launch 回调 | terminal-notifier 的 activate 动作（依赖 bundled 二进制） | 不可用（不做） |

- **macOS 专项**：`osascript` 发出的通知以宿主 App 身份计，**首次触发会弹系统授权**，用户允许一次即可——README 必须写明；macOS 系统的勿扰/专注模式天然兜底，插件的勿扰功能在该平台做减法；
- **Linux 专项**：无通知守护进程的环境（无头 / WSL）`notify-send` 会失败 → 自动走 FR-2.6 降级链；Linux 不承诺三态样式与点击交互，仅保"标题 + 正文 + 紧急度"（等待输入事件用 `-u critical` 长驻）；
- **spawn 防护跨平台共用**：适配层统一维护 spawn 状态机——超时（默认 5s）kill、同一会话 1s 内去重、连续 3 次失败后熔断（本会话静默 + 记日志）；
- **备选方案**：若多平台 spawn 脚本维护成本超预期，可评估引入 `node-notifier` 统一封装（代价：捆绑 terminal-notifier / snoretoast 第三方二进制，与零依赖原则冲突）——仅在适配层实际腐烂时启用，不预先引入。

### 3.5 防打扰检测（P1）

- 前台检测：Windows 用 PowerShell `GetForegroundWindow` 对比 DSH 客户端窗口句柄；macOS/Linux 方案见 §3.4 表格；
- 全屏检测：Windows 用 `SHQueryUserNotificationState`（`QUNS_BUSY` / `QUNS_RUNNING_APP` 视为勿扰）；macOS 依赖系统专注模式自动抑制，插件该项默认放宽；Linux 该项默认关闭；
- Windows 侧两次检测合并为一次 spawn（同一脚本内完成，控制单次开销 ~150–300ms）；检测结果短 TTL 缓存（默认 10s）避免高频 spawn，该缓存策略跨平台共用。

### 3.6 配置 schema 草案（schemastery）

```ts
Schema.object({
  enabled: Schema.boolean().default(true),
  preset: Schema.union(["quiet", "balanced", "all"]).default("balanced"),
  events: Schema.object({
    done:    eventConfig("success"),   // { desktop, sound, soundCustom, push }
    waiting: eventConfig("notice"),    // 默认 push=false，P2 再放开
    error:   eventConfig("alert"),
    heartbeat: Schema.object({         // 默认关；阈值默认 600s（参考稿 45s 过敏感）
      ...eventDefaults("off"),
      thresholdSeconds: Schema.number().default(600),
      repeatMinutes: Schema.number().default(10),
    }),
  }),
  preview: Schema.object({             // 预览长度：系统通知会截断长文本（FR-5.5）
    titleMax: Schema.number().default(40),
    bodyMax: Schema.number().default(120),
  }),
  keywords: Schema.array(Schema.string()).default([]),  // FR-1.6 命中即弹（P2，空=关闭）
  sound: Schema.object({
    volume: Schema.percent().default(60),
    customDir: Schema.string().role("path"),
  }),
  dnd: Schema.object({
    suppressWhenFocused: Schema.boolean().default(true),  // 前台检测
    fullscreenSilent: Schema.boolean().default(true),
    schedule: Schema.array(timeRange()).default([]),      // 勿扰时段
    escalateWaitingMinutes: Schema.number().default(5),   // 渐进提醒
    mergeWindowSeconds: Schema.number().default(10),      // 防轰炸
  }),
  push: Schema.object({        // P2，默认全关
    provider: Schema.union(["off", "bark", "ntfy", "webhook"]).default("off"),
    endpoint: Schema.string(),
    token: Schema.string().role("secret"),
  }),
  debug: Schema.boolean().default(false),
})
```

### 3.7 数据落盘

```
<DSH_HOME>/data/desktop-notice/
├── history.jsonl      # 通知历史（滚动清理：30 天 / 1000 条）
└── stats.json         # 统计累计（.tmp + rename 原子写）
```

### 3.8 里程碑

| 阶段 | 范围 | 验收标准 |
|---|---|---|
| **M0 校准** | 按 §3.9 清单反查宿主源码，产出 `docs/step0-calibration.md` | ✅ 完成（2026-09-05）：事件形态、payload、注册 API 全部确认，FR-1.2 进 M1 |
| **M1 (P0 MVP，Windows)** | FR-1.1/1.2/1.3 + FR-2 + FR-3 + FR-8（配置 + 热更新 + 测试路由） | ✅ 代码完成（v0.1→v0.2 演进），单测 18/18，Toast/音效/冒烟通过；平台层横幅问题已定位（全局开关/专注助手/身份注册），待重启后 T1–T8 终验 |
| **M2 (P1)** | FR-4 全部 + FR-5 内容增强 + FR-6.1 点击聚焦（探索）+ **macOS 适配器**（`osascript` 路线真机验证） | ✅ 代码完成（前台/全屏/勿扰/汇总/心跳/历史 + darwin 适配器）；FR-6.1 探索结论：WinRT 后台激活需 COM activator，延后，保留通知中心回看；待真机验收 |
| **M3 (P2)** | FR-1.6 关键词监听 + FR-7 多通道推送 + FR-9 历史统计浮卡 + FR-10 按需 + **Linux 适配器**（尽力而为，验证 `notify-send` 路线） | ✅ 代码完成（keywords/bark/ntfy/webhook/stats/浮卡 client.js/linux/TTS/notify_send 工具），单测覆盖；待真机验收 |

### 3.9 开工第 0 步校准清单（勿假设，逐项源码反查）

1. `session/event` 的完整事件形态：是否存在"等待用户输入 / 权限确认"子事件？payload 有哪些字段（会话、目录、消息文本）？——直接决定 FR-1.2 能否进 M1；
2. `jobs.onJobDone` payload：是否含耗时、工作目录、结果摘要？
3. 会话与项目的关联方式：如何从事件拿到项目名 / 工作目录 / git 分支？
4. DSH 客户端形态：web 浏览器还是桌面壳？——决定前台检测比对哪个窗口、P2 浮卡 & 点击聚焦的可行性；
5. `settings.register` / `webServer.register` / `ctx.on` 精确签名（以 vault-memory 真机代码为参考实现核对）；
6. PowerShell WinRT Toast 在目标机器实测（Win10 1809+ 与 Win11 各一台），确认无执行策略/企业策略拦截；
7. 通知内容是否可携带自定义属性行（Toast XML 的第三行文本），定稿正文模板；
8. `session/event` 流式增量 payload 形态（FR-1.6 关键词监听依赖，P2 前校准即可）。

---

## 4. 开放问题（等拍板）

| # | 问题 | 我的建议 |
|---|---|---|
| 1 | 通知主路线：**原生 Toast** vs 自绘浮窗 | ✅ 已拍板：Windows 原生 Toast 为主（不依赖客户端窗口可见，且白得通知中心回看）；macOS 走 `osascript`、Linux 走 `notify-send`（§3.4 适配层）；浮窗仅用于 P2 客户端内面板 |
| 2 | ~~"等待输入"事件若宿主暂无对应形态~~ | ✅ 已解决（M0 校准）：`approval/asked` + `user-questions/request` 均存在，进 M1 |
| 3 | MVP 是否含多通道推送 | 不含，P2 再做（MVP 先把桌面体验做扎实） |
| 4 | TTS 语音播报放哪期 | P2 储备，默认关；先看 M1/M2 反馈 |
| 5 | 历史存储 jsonl vs SQLite | M2 先 jsonl（量小、零依赖）；若 M3 做统计面板查询需求变复杂再评估 SQLite |
| 6 | 插件名 `dsh-plugin-desktop-notice` 是否沿用 | 沿用（与目录一致，风格对齐系列） |
| 7 | macOS / Linux 真机验证环境 | M2 的 mac 验收需要一台真机——确认是否有可用 Mac（以及目标系统版本）；没有则 M2 的 mac 适配器降为"代码交付 + 社区验证"，排期相应后移 |
| 8 | 参考稿取舍确认（§0.5） | 心跳默认阈值 600s（参考稿 45s 过敏感）、关键词监听 P2 默认关、移除 node-notifier / 构建链 / 逐工具通知——如有异议指哪条改哪条 |

---

## 5. 文档导航（规划）

- `DESIGN.md` — 本文：产品需求 + 总设计
- `docs/step0-calibration.md` — ✅ M0 校准记录（已产出：事件源全落定）
- `docs/phase1-interface-spec.md` — ✅ M1 接口规范（已产出：按此开工）
- `docs/phase2-interface-spec.md` — ✅ M2 接口规范（已产出：防打扰引擎 + 内容增强 + macOS）
- `docs/phase3-interface-spec.md` — ✅ M3 接口规范（已产出：关键词 + 推送 + 浮卡 + Linux）
- `README.md` — ✅ 面向用户的安装与使用说明（M1 验收后随实现更新）

---

*作者：moqian · 系列：dsh-plugin 系列 · 状态：v0.2 草案待确认（已合并用户参考稿）*
