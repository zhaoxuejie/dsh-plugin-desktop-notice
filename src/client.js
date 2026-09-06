// dsh-plugin-desktop-notice — 浏览器半身（GUI 浮卡：历史 / 统计 / 操作，真 Tab 切换）
// 契约（已真源码校准，daily-digest / vault-memory 同款）：
//   window.__ModuleLoader__.load({ id, factory })；factory 内 module.exports = { name, apply }；
//   apply(ctx) 挂载 DOM 并返回 dispose；宿主 dsh-client-modules 依 package.json dsh.client 声明拾取。
// 零依赖：纯 DOM + fetch（相对路径走宿主 webServer 路由），用户文本一律 textContent 渲染。

window.__ModuleLoader__.load({
  id: "dsh-plugin-desktop-notice",
  factory: () => {
    var module = { exports: {} };
    var exports = module.exports;

    var NAME = "dsh-plugin-desktop-notice";
    var HEALTH_PATH = "/desktop-notice/health";
    var HISTORY_PATH = "/desktop-notice/history";
    var STATS_PATH = "/desktop-notice/stats";
    var TEST_PATH = "/desktop-notice/test";
    var POLL_MS = 30000;
    var OPEN_POLL_MS = 5000;
    var ATTR = "data-dn";

    var CSS = [
      "[" + ATTR + "] * { box-sizing: border-box; }",
      "[" + ATTR + "] .dn-capsule { position: fixed; right: 18px; bottom: 18px; z-index: 2147483000; cursor: pointer; border: 1px solid rgba(255,255,255,.18); background: rgba(30,30,40,.82); color: #fff; border-radius: 999px; padding: 7px 14px; font-size: 12px; box-shadow: 0 6px 18px rgba(0,0,0,.3); backdrop-filter: blur(8px); }",
      "[" + ATTR + "] .dn-panel { position: fixed; right: 18px; bottom: 60px; z-index: 2147483000; width: 360px; max-height: 70vh; overflow: auto; border: 1px solid rgba(255,255,255,.16); background: rgba(24,24,32,.94); color: #eee; border-radius: 12px; padding: 12px; box-shadow: 0 10px 30px rgba(0,0,0,.4); font-size: 12px; }",
      "[" + ATTR + "] .dn-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; font-weight: 700; }",
      "[" + ATTR + "] .dn-tabs { display: flex; gap: 4px; border-bottom: 1px solid rgba(255,255,255,.1); margin-bottom: 8px; }",
      "[" + ATTR + "] .dn-tab { cursor: pointer; padding: 5px 12px; opacity: .55; border-radius: 8px 8px 0 0; }",
      "[" + ATTR + "] .dn-tab.dn-on { opacity: 1; background: rgba(255,255,255,.1); }",
      "[" + ATTR + "] .dn-btn { cursor: pointer; border: 1px solid rgba(255,255,255,.16); background: rgba(255,255,255,.08); color: inherit; border-radius: 8px; padding: 5px 10px; font-size: 12px; margin-right: 6px; }",
      "[" + ATTR + "] .dn-btn:hover { background: rgba(255,255,255,.18); }",
      "[" + ATTR + "] .dn-item { padding: 5px 0; border-bottom: 1px dashed rgba(255,255,255,.08); word-break: break-all; line-height: 1.5; }",
      "[" + ATTR + "] .dn-time { opacity: .5; font-size: 11px; margin-right: 6px; }",
      "[" + ATTR + "] .dn-sup { opacity: .55; font-size: 11px; }",
      "[" + ATTR + "] .dn-muted { opacity: .55; }",
      "[" + ATTR + "] .dn-row { display: flex; gap: 2px; margin: 8px 0; }",
      "[" + ATTR + "] .dn-big { display: inline-block; text-align: center; flex: 1; font-size: 20px; font-weight: 700; }",
      "[" + ATTR + "] .dn-big span { font-size: 11px; font-weight: 400; opacity: .7; display: block; }",
      "[" + ATTR + "] .dn-pane[hidden] { display: none; }",
    ].join("\n");

    function el(tag, props, children) {
      var node = document.createElement(tag);
      if (props) for (var k in props) node.setAttribute(k, props[k]);
      (children || []).forEach(function (c) {
        if (typeof c === "string") node.appendChild(document.createTextNode(c));
        else if (c) node.appendChild(c);
      });
      return node;
    }

    function fetchJson(path) {
      return fetch(path, { cache: "no-store" }).then(function (r) { return r.json(); });
    }

    function fmtTime(t) {
      try { return new Date(t).toLocaleTimeString(); } catch (e) { return ""; }
    }

    function apply(ctx) {
      var style = document.createElement("style");
      style.textContent = CSS;
      document.head.appendChild(style);

      var root = el("div", { [ATTR]: "1" });
      var panel = el("div", { class: "dn-panel", style: "display:none" });
      var capsule = el("div", { class: "dn-capsule", title: "桌面通知（点击展开）" }, ["🔔 通知"]);

      var open = false;
      var timer = null;

      // --- 三个 pane：历史 / 统计 / 操作 ---
      var historyList = el("div", { class: "dn-muted" }, ["加载中…"]);
      var statsBox = el("div", { class: "dn-muted" }, ["加载中…"]);
      var healthLine = el("div", { class: "dn-muted" }, [""]);
      var opsPane = el("div", null, [
        el("div", { style: "margin-bottom:8px; opacity:.75" }, ["发送一条测试通知，验证桌面弹窗与音效："]),
        el("button", { class: "dn-btn" }, ["✅ 完成测试"]),
        el("button", { class: "dn-btn" }, ["⏸ 等待测试"]),
        el("button", { class: "dn-btn" }, ["❌ 失败测试"]),
      ]);

      var panes = { history: historyList, stats: statsBox, ops: opsPane };
      var tabDefs = [["history", "历史"], ["stats", "统计"], ["ops", "操作"]];
      var tabBar = el("div", { class: "dn-tabs" });
      var paneBox = el("div");
      Object.keys(panes).forEach(function (k) { paneBox.appendChild(panes[k]); panes[k].hidden = k !== "history"; });

      tabDefs.forEach(function (def) {
        var tab = el("span", { class: "dn-tab" + (def[0] === "history" ? " dn-on" : "") }, [def[1]]);
        tab.addEventListener("click", function () {
          Array.prototype.forEach.call(tabBar.children, function (t) { t.classList.remove("dn-on"); });
          tab.classList.add("dn-on");
          Object.keys(panes).forEach(function (k) { panes[k].hidden = k !== def[0]; });
          if (def[0] === "history") fetchHistory();
          if (def[0] === "stats") fetchStats();
        });
        tabBar.appendChild(tab);
      });

      function renderHistory(items) {
        historyList.textContent = "";
        if (!Array.isArray(items) || items.length === 0) {
          historyList.appendChild(el("div", { class: "dn-muted" }, ["暂无通知记录"]));
          return;
        }
        items.forEach(function (it) {
          var reason = it.suppressed ? "（被抑制：" + it.suppressed + "）" : "";
          historyList.appendChild(el("div", { class: "dn-item" }, [
            el("span", { class: "dn-time" }, [fmtTime(it.time)]),
            it.title || it.kind,
            reason ? el("span", { class: "dn-sup" }, [reason]) : null,
          ]));
        });
      }

      function renderStats(s) {
        statsBox.textContent = "";
        if (!s || !s.day) {
          statsBox.appendChild(el("div", { class: "dn-muted" }, ["暂无统计数据"]));
          return;
        }
        var row = el("div", { class: "dn-row" });
        row.appendChild(el("span", { class: "dn-big" }, [String(s.done || 0), el("span", null, ["完成"])]));
        row.appendChild(el("span", { class: "dn-big" }, [String(s.waiting || 0), el("span", null, ["等待"])]));
        row.appendChild(el("span", { class: "dn-big" }, [String(s.error || 0), el("span", null, ["失败"])]));
        statsBox.appendChild(row);
        statsBox.appendChild(el("div", { class: "dn-item" }, ["AI 运行：" + (s.aiRunMinutes || 0) + " 分钟"]));
        statsBox.appendChild(el("div", { class: "dn-item" }, ["今天 AI 等了你 " + (s.waitedMinutes || 0) + " 分钟"]));
      }

      function fetchHistory() {
        // 注意：history API 返回 { items: [...] } 包装对象；非数组时按空处理（防静默吞错）
        fetchJson(HISTORY_PATH + "?limit=30").then(function (r) {
          renderHistory(Array.isArray(r && r.items) ? r.items : []);
        }).catch(function () {});
      }
      function fetchStats() { fetchJson(STATS_PATH).then(renderStats).catch(function () {}); }

      function fetchHealth() {
        fetchJson(HEALTH_PATH).then(function (h) {
          healthLine.textContent = "适配器 " + (h.adapter || "?") +
            " · 弹窗 " + (h.capabilities && h.capabilities.toast) +
            " · 声音 " + (h.capabilities && h.capabilities.sound) +
            (h.degraded && h.degraded.length ? " · 降级: " + h.degraded.join("; ") : "");
        }).catch(function () {});
      }

      function toggle() {
        open = !open;
        panel.style.display = open ? "" : "none";
        if (open) {
          fetchHistory();
          fetchHealth();
          timer = setInterval(function () {
            if (panes.history.hidden === false) fetchHistory();
            if (panes.stats.hidden === false) fetchStats();
          }, OPEN_POLL_MS);
        } else if (timer) {
          clearInterval(timer);
          timer = null;
        }
      }

      capsule.addEventListener("click", toggle);

      panel.appendChild(el("div", { class: "dn-head" }, ["🔔 桌面通知"]));
      panel.appendChild(tabBar);
      paneBox.appendChild(el("div", { class: "dn-item dn-muted" }, [healthLine]));
      panel.appendChild(paneBox);

      Array.prototype.forEach.call(opsPane.querySelectorAll("button"), function (b, i) {
        b.addEventListener("click", function () {
          fetch(TEST_PATH + "?kind=" + ["done", "waiting", "error"][i]).catch(function () {});
        });
      });

      root.appendChild(panel);
      root.appendChild(capsule);
      document.body.appendChild(root);

      var slowPoll = setInterval(fetchHealth, POLL_MS);

      return function dispose() {
        if (timer) clearInterval(timer);
        clearInterval(slowPoll);
        root.remove();
        style.remove();
      };
    }

    module.exports = { name: NAME, apply: apply };
    return module.exports;
  },
});
