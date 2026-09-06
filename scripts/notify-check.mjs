// dsh-plugin-desktop-notice — 测试路由客户端（Windows 友好，无需 curl）
// 用法：npm run notify:test -- [kind] [--port 3080] [--host 127.0.0.1]
//   kind 省略时轮流发三态（done → waiting → error）；也可直接浏览器打开
//   http://127.0.0.1:3080/desktop-notice/test?kind=waiting
// 流程：先打 health 确认插件在线，再触发 test；每一步失败都给可读的排查提示。
// 注意：文件名不能含 "test-"（会被 node --test 的默认发现规则当成测试执行）。

const argv = process.argv.slice(2);
let kind = null;
let host = "127.0.0.1";
let port = process.env.DSH_WEB_PORT ?? 3080;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--port") port = Number(argv[++i]);
  else if (argv[i] === "--host") host = argv[++i];
  else if (kind === null) kind = argv[i];
}

const base = `http://${host}:${port}`;
const KINDS = ["done", "waiting", "error"];
if (kind !== null && !KINDS.includes(kind)) {
  console.error(`[notify] kind 必须是 ${KINDS.join(" / ")}，收到：${kind}`);
  process.exit(1);
}

/** fetch + JSON 解析，把常见网络/路由错误翻译成人话。 */
async function getJson(url) {
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    const code = e?.cause?.code ?? "";
    if (code === "ECONNREFUSED") throw new Error(`连不上 ${base} —— DSH web 未启动，或端口不对（用 --port 指定）`);
    throw new Error(`网络错误：${code || (e?.message ?? e)}`);
  }
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`HTTP ${res.status} 非 JSON 响应 —— /desktop-notice/* 路由不存在，插件可能未安装或未重启生效`);
  }
}

try {
  const health = await getJson(`${base}/desktop-notice/health`);
  console.log(`[notify] 插件在线：adapter=${health.adapter} capabilities=${JSON.stringify(health.capabilities)}`);
  if (health.degraded?.length) console.log(`[notify] 降级：${health.degraded.join("; ")}`);

  const body = await getJson(`${base}/desktop-notice/test${kind ? `?kind=${kind}` : ""}`);
  if (body.error) throw new Error(body.error);
  console.log(`[notify] 测试通知已发出（${body.kind}）：toast=${JSON.stringify(body.toast)} sound=${JSON.stringify(body.sound)}`);
  console.log(`[notify] 若没看到右下角横幅，按 Win+N 打开通知中心（横幅可能被系统通知设置/专注助手拦截）`);
} catch (e) {
  console.error(`[notify] 失败：${e?.message ?? e}`);
  process.exit(1);
}
