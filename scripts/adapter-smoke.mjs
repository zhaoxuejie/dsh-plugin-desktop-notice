// dsh-plugin-desktop-notice — 真机冒烟（手动运行：npm run smoke）
// 弹出一条真实 Windows Toast（done 样式）+ 播放 notice 音效。
// 这是 spec 任务 2「Toast 先通，真机单发成功」的验收动作；同时也是 T4 的雏形。

import path from "node:path";
import url from "node:url";
import { probe } from "../src/adapters/probe.mjs";
import { buildContent } from "../src/content.mjs";
import { DEFAULT_CONFIG } from "../src/config.mjs";
import { createLogger } from "../src/log.mjs";

const assetsDir = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..", "assets");
const log = createLogger({ debug: true });

const p = probe({ assetsDir, log });
console.log(`[smoke] adapter=${p.id} capabilities=${JSON.stringify(p.capabilities)} headless=${p.headless}`);
if (p.degraded.length) console.log(`[smoke] degraded: ${p.degraded.join("; ")}`);

const kind = process.argv[2] ?? "done"; // npm run smoke -- waiting → 长驻场景，便于人工确认
const notice = {
  project: "demo-project",
  branch: "main",
  durationMs: 252000,
  tokens: 3200,
  summary: "桌面通知插件真机冒烟：看到这条 Toast 并听到提示音，说明链路已通！",
  detail: kind === "waiting" ? "bash · 需要运行 npm test 验证改动（长驻测试）" : undefined,
};
const content = buildContent(kind, notice, { preview: DEFAULT_CONFIG.preview });
console.log(`[smoke] title: ${content.title}`);
console.log(`[smoke] body : ${JSON.stringify(content.body)}`);

const toast = await p.adapter.notify({ ...content, scenario: kind === "waiting" ? "reminder" : "default", sessionKey: "smoke" });
console.log(`[smoke] toast → ${JSON.stringify(toast)}`);

await new Promise((r) => setTimeout(r, 600));
const sound = await p.adapter.play("notice", DEFAULT_CONFIG.volume);
console.log(`[smoke] sound → ${JSON.stringify(sound)}`);

console.log(`[smoke] toastConfirmed=${p.adapter.toastConfirmed}`);
