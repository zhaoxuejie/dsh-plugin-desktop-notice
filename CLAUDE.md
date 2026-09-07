# CLAUDE.md

本文件用于在本仓库中工作时为 Claude Code（claude.ai/code）提供指导。

## 这是什么

一个 DSH（DeepSeek-Harness）bundle 插件，为三类宿主事件推送桌面通知（Windows Toast / macOS 通知 / Linux notify-send）：任务完成、等待输入、任务出错。零构建的纯 ESM（`.mjs`）——源码即交付产物，无打包器、无 TypeScript 编译步骤。所有外部交互都通过 `spawn` 调用操作系统原生命令完成（Windows 上为 PowerShell WinRT，macOS 上为 `osascript`/`afplay`，Linux 上为 `notify-send`）——不依赖任何第三方通知二进制程序。

## 命令

```bash
npm test              # node --test test/  （18 个单元测试，纯逻辑——无宿主、无 OS 调用）
npm run smoke         # scripts/adapter-smoke.mjs —— 触发一次真实的 Windows Toast + 声音（手动，本地运行）
npm run notify:test -- [done|waiting|error]  # 命中正在运行的 DSH 实例的 /desktop-notice/test 路由（需要 DSH 正在运行）
npm run diagnose:win  # scripts/notify-diagnose.mjs —— Windows Toast 横幅诊断（无需 DSH 运行，直接探测系统层）
npm run gen:wav       # tools/gen-wav.mjs —— 重新生成 assets/*.wav
```

运行单个测试文件：`node --test test/plugin.test.mjs` 或 `node --test test/m2m3.test.mjs`。

没有配置 lint/typecheck 脚本——`types.mjs` 中的 JSDoc 类型仅作为文档，不做编译器校验。

## 架构

### 插件契约（Cordis/DSH 宿主）

入口 `src/index.mjs` 导出 `name`、`inject = ["settings", "tools"]`、`Config`（schemastery schema）以及 `apply(ctx, entryConfig)`。这与兄弟插件 `dsh-plugin-vault-memory`（已通过宿主验证）遵循相同契约——参见 `docs/step0-calibration.md` 了解对宿主事件精确形态的源码级校准。

**铁律**：`apply()` 内部的任何内容都不得从 `apply()` 向外抛出异常。每个子系统初始化（probe、settings 注册、tool 注册、route 注册）都包裹在 try/catch 中，并以「降级为 noop」作为兜底，因为插件异常绝不能破坏宿主的主 agent 循环。任何新子系统都要保留这一模式。

### 事件流（source → normalize → pipeline → adapters）

```
ctx.on("session/event", ...)   [events.mjs]
  turn/start, approval/asked, approval/decided, turn/end, assistant/message,
  assistant/chunk, user/message
        │  将宿主事件规范化为 NoticeEvent { kind, sessionId, sessionKey, project, ... }
        ▼
pipeline.admit(kind, notice)   [pipeline.mjs]
  filter 链：F1 enabled → F2 每事件通道 → F5 前台 → F6 全屏
  → F7 免打扰时间表 → F3 合并/节流窗口 → F4 升级/心跳
  → dispatch
        ▼
dispatch(kind, notice)          扇出到 toast / sound（或 TTS）/ push —— 相互之间非阻塞
        ├─→ adapter.notify()   [adapters/win32|darwin|linux.mjs，经由 probe.mjs]
        ├─→ adapter.play()
        ├─→ push.sendFor()     [push.mjs]（bark/ntfy/webhook，仅当 kind 在 cfg.push.kinds 中）
        └─→ sideEffects.onDelivered/onSuppressed → history.mjs + stats.mjs
```

关键不变量：`kind: "waiting"`（agent 阻塞在用户审批/提问上）默认免于前台/全屏/免打扰抑制（`dnd.exemptWaiting`）——产品论点是「阻塞时间是最昂贵的，因此等待输入的通知始终要送达」。在该豁免上游添加过滤器之前，请先查看 `DESIGN.md` §0.2。

故意不接通知的事件（见 `events.mjs` 中的注释和 `DESIGN.md` §0.5）：每次工具调用完成（`tools/post-execute`——每个任务会触发数十条通知，仅用作内部计时/心跳数据源），以及 `agent/request-error`（重试/瀑布语义——仅记录日志，不上浮，以避免误报的错误 toast；真正的终止失败信号是 `turn/end` 且 `reason.kind === "error"`）。

### 平台适配器层

`src/adapters/probe.mjs` 在启动时运行一次，恰好选取一个适配器（`win32.mjs` → `darwin.mjs` → `linux.mjs` → `noop.mjs`，按此平台检测顺序），并将结果缓存在 `runtime.probe` 上。每个适配器暴露相同的双方法接口：`notify(content, scenario, sessionKey)` 和 `play(sound, volume)`。可选的 `focusQuery` 为前台/全屏检测提供能力（仅 win32 和 darwin；linux 没有，因此免打扰的前台/全屏检查默认为「未检测到 → 不抑制」——系统刻意偏向于多通知而非静默丢弃）。

Windows 细节（`win32.mjs` + `win32-*.ps1` PowerShell 脚本）：
- 载荷写入临时 JSON 文件，通过 `-PayloadPath` 传入，而非命令行参数——避免任意标题/正文文本的引号/注入问题。
- Spawn 防护：1s 内同会话去重、5s spawn 超时 + kill、连续 3 次失败后的熔断器（静默跳过后续尝试，仅记录一次日志）。
- 插件自注册一个 Windows AUMID（`DSH.DesktopNotice`，经由 `win32-register-aumid.ps1`），使通知以自己的应用身份出现而非借用 PowerShell 的——这是横幅显示所必需的，注册失败时回退到 PowerShell AUMID。
- `win32-focus.ps1`（P/Invoke `GetForegroundWindow`）已知会偶尔崩溃；`filters/attention.mjs` 用相同的「3 次失败 → 5 分钟退避」熔断器模式对其包装。

添加一项平台能力 = 在 `src/adapters/` 下添加/编辑一个文件；pipeline 和 filters 从不直接与 OS 交互。

### 配置

`src/config.mjs` 是（除它自身之外）唯一导入 `schemastery` 的模块。`configSchema` 通过 `settings.register(name, Config, { applies: "live" })` 注册，以实现宿主侧热重载；`DEFAULT_CONFIG` + `resolveConfig()` 提供一套不依赖 schema 的两层深合并兜底，在 `ctx.get("settings")` 不可用（仅入口配置）时使用。添加配置字段时，要同时更新 schema（校验）和 `DEFAULT_CONFIG`（运行时兜底）——它们被有意保持为两个独立的事实来源，而非互相派生。

### 磁盘数据

`<DSH_HOME>/data/desktop-notice/`（或 `~/.dsh/data/desktop-notice/`，当 `DSH_HOME` 未设置时）：`notice.log`（仅错误，除非 `debug: true`）、`history.jsonl`（滚动：keepDays/maxLines）、`stats.json`（原子 `.tmp` + 重命名）。此处任何磁盘 I/O 失败都会被吞掉——日志/历史/统计绝不能破坏通知送达。

### 测试方法

所有 pipeline/filter 测试都注入假时钟（`fakeClock()`——同步、按步进驱动的 `schedule`/`cancel`）和 mock 适配器，而非使用真实定时器或 spawn 进程——参见 `test/plugin.test.mjs` 和 `test/m2m3.test.mjs`。`createPipeline({ now, schedule, cancel, focus, ... })` 将这些作为构造器依赖接受，正是为了让测试不与真实的 `setTimeout` 竞争。任何新的基于时间的行为（新的升级/心跳逻辑等）都遵循这一模式，而不是在测试中动用真实定时器。

真实 OS 验证（Toast 真正渲染、声音真正播放）*不*由 `npm test` 覆盖——那是 `npm run smoke` 和 `npm run notify:test` 的职责，它们需要在真实机器上手动进行视觉/听觉确认。

### Web 路由 / 客户端浮层

`src/server.mjs` 通过 `ctx.get("webServer")` 注册 `/desktop-notice/{health,test,history,stats}`（路由注册是尽力而为——缺少 `webServer` 服务时只是静默跳过）。`src/client.js` 是一个独立的、非 ESM 的浏览器端 bundle（通过 `window.__ModuleLoader__.load(...)` 加载，在 `package.json` 的 `exports["./client"]` + `dsh.client.platform: "web"` 中声明），提供一个浮动胶囊 UI（历史/统计/手动测试标签页），轮询上述相同的路由。保持 `client.js` 无框架（原生 DOM，无构建步骤）——它原样发布到浏览器。

## 已知问题（完整细节见 README.md「已知问题」）

- Windows Toast 横幅不渲染（已修复 2026-09-07）：根因是 `win32-register-aumid.ps1` 写 AUMID 属性时把 `PKEY_AppUserModel_ID`（pid=5）误写成 `PKEY_AppUserModel_StartPinOption`（pid=12），快捷方式建成了但 `System.AppUserModel.ID` 始终为空 → 通知进中心但横幅不弹（「只有声音、没横幅」）。已改 pid=5，并加「已存在快捷方式则校验 AUMID、不匹配则重写」的幂等修复。`npm run diagnose:win` 可一键复核（`AumidMatches` 应为 YES）。
- `win32-focus.ps1` 的 P/Invoke 偶尔发生段错误；熔断器能缓解，但根因尚未修复。
- `win32-focus.ps1` 的 P/Invoke 偶尔发生段错误；熔断器能缓解，但根因尚未修复。

## 文档地图

- `DESIGN.md` —— 完整产品设计：痛点 → 需求 → 里程碑（M0–M3）、配置 schema 理由、平台能力矩阵（§3.4）、开放决策日志（§0.5、§4）。
- `docs/step0-calibration.md` —— 对本插件所依赖的精确宿主事件名/载荷进行源码级验证。
- `docs/phase{1,2,3}-interface-spec.md` —— 各里程碑的接口规范（M1 事件/toast/声音/配置，M2 防打扰/内容/macOS，M3 关键词/push/历史统计/Linux）。
