// dsh-scheduled-tasks 客户端插件（浏览器 bundle，__ModuleLoader__ 格式）
// 在侧边栏底部注册"定时任务"入口（与"设置"同级），点击打开独立面板：
// 创建/编辑/启停/删除任务，查看下次执行时间与执行历史。
// 注意：React 19 的 jsx(type, props) 中 children 必须放进 props 对象
//（第三个位置参数是 key 而非 children）。
window.__ModuleLoader__.load({
  id: "dsh-scheduled-tasks",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var react_jsx_runtime = require("react/jsx-runtime");
    var react = require("react");
    var primitives = require("@deepseek-ai/dsh-client-ui-primitives");
    const { jsx, jsxs } = react_jsx_runtime;
    const { useState, useEffect, useRef, useCallback, Fragment } = react;
    const { IconGoalOutline16, IconCloseOutline16 } = primitives;

    const MODES = ["once", "daily", "weekly", "interval"];
    const MODE_LABELS = {
      once: "一次性",
      daily: "每天",
      weekly: "每周",
      interval: "间隔",
    };
    const ACTIONS = ["session", "command"];
    const ACTION_LABELS = {
      session: "发消息到会话",
      command: "执行命令",
    };
    const WEEKDAY_LABELS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

    const css = `
/* 侧边栏底部操作区改为纵向一列（内置样式为横向 flex，两个按钮会横排溢出）：
   插件市场 / 定时任务 / 设置 三个入口同列竖排 */
[class*="_footerActions"]{flex-direction:column !important;align-items:stretch}
.dsh-st-trigger{box-sizing:border-box;cursor:pointer;width:calc(100% + 4px);height:42px;color:var(--dsw-alias-label-primary);background:transparent;border:none;border-radius:12px;flex:none;align-items:center;gap:8px;margin:4px -2px;padding:0 10px 0 8px;font-family:inherit;font-size:14px;line-height:22px;display:flex;overflow:hidden}
.dsh-st-trigger:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-st-trigger[data-rail=true]{border-radius:50%;justify-content:center;gap:0;width:36px;height:36px;margin:8px 0 10px;padding:0}
.dsh-st-trigger-label{white-space:nowrap;overflow:hidden}
.dsh-st-overlay{z-index:1000;justify-content:center;align-items:center;display:flex;position:fixed;inset:0}
.dsh-st-mask{background:var(--dsw-alias-bg-mask-1);backdrop-filter:var(--dsw-mask-blur);position:absolute;inset:0}
.dsh-st-panel{z-index:1;background:var(--dsw-alias-bg-layer-2);width:860px;max-width:calc(100vw - 48px);height:min(820px,100vh - 48px);box-shadow:var(--dsw-shadow-lv3);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);border-radius:24px;display:flex;flex-direction:column;position:relative;overflow:hidden}
.dsh-st-panel-head{box-sizing:border-box;flex:none;justify-content:space-between;align-items:center;gap:8px;height:54px;padding:20px 14px 8px 18px;display:flex}
.dsh-st-panel-title{color:var(--dsw-alias-label-primary);font-size:16px;font-weight:500;line-height:24px}
.dsh-st-panel-close{cursor:pointer;width:28px;height:28px;color:var(--dsw-alias-label-primary);background:transparent;border:none;border-radius:28px;justify-content:center;align-items:center;padding:0;display:inline-flex}
.dsh-st-panel-close:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-st-panel-body{flex:1;min-height:0;padding:4px 24px 24px;overflow-y:auto}
.dsh-st{display:flex;flex-direction:column;gap:14px;padding:4px 0 24px;min-width:0}
.dsh-st *{box-sizing:border-box}
.dsh-st-head{display:flex;flex-direction:column;gap:4px}
.dsh-st-title{font-size:16px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dsh-st-sub{font-size:12px;color:var(--dsw-alias-label-tertiary);line-height:1.6}
.dsh-st-toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.dsh-st-stats{display:flex;flex-wrap:wrap;gap:8px}
.dsh-st-chip{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:2px 10px;font-size:12px;line-height:18px;white-space:nowrap}
.dsh-st-chip-on{border:1px solid var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary);background:transparent}
.dsh-st-chip-off{color:var(--dsw-alias-label-tertiary)}
.dsh-st-chip-err{border:1px solid var(--dsw-alias-label-error);color:var(--dsw-alias-label-error);background:transparent}
.dsh-st-btn{font:inherit;font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;height:30px;padding:0 12px;cursor:pointer;white-space:nowrap}
.dsh-st-btn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary)}
.dsh-st-btn:disabled{opacity:.5;cursor:default}
.dsh-st-btn-primary{background:var(--dsw-static-neutral-bluish-1000,#1d2b4f);border-color:var(--dsw-static-neutral-bluish-1000,#1d2b4f);color:#ffffff}
.dsh-st-btn-danger{color:var(--dsw-alias-label-error);border-color:var(--dsw-alias-label-error)}
.dsh-st-error{color:var(--dsw-alias-label-error);font-size:12px;border:1px solid var(--dsw-alias-label-error);border-radius:8px;padding:8px 12px}
.dsh-st-info{color:var(--dsw-alias-state-success-primary);font-size:12px;border:1px solid var(--dsw-alias-state-success-primary);border-radius:8px;padding:8px 12px}
.dsh-st-list{display:flex;flex-direction:column;gap:10px}
.dsh-st-card{background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:8px;min-width:0}
.dsh-st-card-head{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.dsh-st-name{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-st-desc{font-size:13px;line-height:1.6;color:var(--dsw-alias-label-secondary);word-break:break-word;min-width:0}
.dsh-st-content{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-module-platform);border-radius:8px;padding:8px 10px;white-space:pre-wrap;word-break:break-word;min-width:0;max-height:120px;overflow-y:auto}
.dsh-st-foot{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap}
.dsh-st-meta{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dsh-st-actions{display:flex;gap:6px;flex-wrap:wrap}
.dsh-st-history{display:flex;flex-direction:column;gap:4px;padding:6px 8px;border-radius:8px;background:var(--dsw-alias-bg-module-platform)}
.dsh-st-hitem{font-size:11px;color:var(--dsw-alias-label-tertiary);line-height:1.5;word-break:break-word}
.dsh-st-form{display:flex;flex-direction:column;gap:8px;background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:12px}
.dsh-st-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.dsh-st-field{display:flex;flex-direction:column;gap:2px;flex:1;min-width:160px}
.dsh-st-field-sm{flex:0 1 auto}
.dsh-st-label{font-size:11px;color:var(--dsw-alias-label-secondary)}
.dsh-st-input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);height:32px;font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 10px;outline:none;min-width:0}
.dsh-st-input:focus-visible{border-color:var(--dsw-alias-brand-primary)}
.dsh-st-select{appearance:auto}
.dsh-st-textarea{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);border-radius:8px;padding:8px 10px;min-height:72px;resize:vertical;outline:none;width:100%}
.dsh-st-textarea:focus-visible{border-color:var(--dsw-alias-brand-primary)}
.dsh-st-weekdays{display:flex;gap:6px;flex-wrap:wrap}
.dsh-st-wd{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);border-radius:999px;height:28px;padding:0 10px;font:inherit;font-size:12px;cursor:pointer}
.dsh-st-wd-on{border-color:var(--dsw-static-neutral-bluish-1000,#1d2b4f);background:var(--dsw-static-neutral-bluish-1000,#1d2b4f);color:#ffffff}
.dsh-st-empty{color:var(--dsw-alias-label-tertiary);font-size:13px;text-align:center;padding:24px 0}
.dsh-st-hint{font-size:11px;color:var(--dsw-alias-label-tertiary)}
`;

    function ensureCss() {
      const tagId = "dsh-scheduled-tasks/section.css";
      if (typeof document !== "undefined" && document.querySelector('style[data-plugin-css="' + tagId + '"]') === null) {
        const tag = document.createElement("style");
        tag.dataset.plugin = "dsh-scheduled-tasks";
        tag.dataset.pluginCss = tagId;
        tag.textContent = css;
        document.head.appendChild(tag);
      }
    }

    async function apiFetch(path, options) {
      const init = { method: options && options.method ? options.method : "GET" };
      if (options && options.body !== undefined) {
        init.headers = { "content-type": "application/json" };
        init.body = JSON.stringify(options.body);
      }
      let res;
      try {
        res = await fetch(path, init);
      } catch (err) {
        throw new Error("无法连接定时任务服务：" + (err && err.message ? err.message : String(err)));
      }
      let data = {};
      try {
        data = await res.json();
      } catch {
        /* 非 JSON 响应 */
      }
      if (!res.ok || data.ok === false) {
        throw new Error(data && data.error ? data.error : "请求失败（HTTP " + res.status + "）");
      }
      return data;
    }

    function fmtDateTime(ts) {
      if (!ts) return "—";
      try {
        return new Date(ts).toLocaleString();
      } catch {
        return "—";
      }
    }

    function fmtRelative(ts, now) {
      if (!ts) return "—";
      const diff = Number(ts) - Number(now || Date.now());
      if (diff < -60000) return "已过期";
      if (diff < 60000) return "即将执行";
      if (diff < 3600000) return Math.max(1, Math.round(diff / 60000)) + " 分钟后";
      if (diff < 86400000) return Math.round(diff / 3600000) + " 小时后";
      return Math.round(diff / 86400000) + " 天后";
    }

    function modeText(task) {
      if (!task) return "";
      if (task.mode === "once") return "一次性 · " + fmtDateTime(task.at);
      if (task.mode === "daily") return "每天 " + task.time;
      if (task.mode === "weekly") {
        const days = (task.weekdays || []).map((d) => WEEKDAY_LABELS[d]).join("、");
        return "每周 " + days + " " + task.time;
      }
      return "每 " + task.intervalMinutes + " 分钟";
    }

    function truncate(s, n) {
      if (!s) return "";
      return s.length > n ? s.slice(0, n) + "…" : s;
    }

    /** 服务端任务 → 表单草稿（datetime-local 本地值） */
    function taskToDraft(task) {
      const d = new Date();
      const pad = (x) => String(x).padStart(2, "0");
      const localInput = (date) =>
        date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) +
        "T" + pad(date.getHours()) + ":" + pad(date.getMinutes());
      let at = "";
      if (task && task.at) {
        try { at = localInput(new Date(task.at)); } catch { at = ""; }
      }
      return {
        name: task ? task.name : "",
        enabled: task ? task.enabled !== false : true,
        mode: task ? task.mode : "once",
        at: at || localInput(new Date(d.getTime() + 3600000)),
        time: task && task.time ? task.time : "09:00",
        weekdays: task && Array.isArray(task.weekdays) ? task.weekdays.slice() : [1, 2, 3, 4, 5],
        intervalMinutes: task && task.intervalMinutes ? String(task.intervalMinutes) : "60",
        startDate: task && task.startDate ? task.startDate : "",
        endDate: task && task.endDate ? task.endDate : "",
        action: task ? task.action : "session",
        sessionId: task && task.sessionId ? task.sessionId : "",
        content: task ? task.content : "",
        timeZone: (typeof Intl !== "undefined" && Intl.DateTimeFormat().resolvedOptions().timeZone) || "UTC",
      };
    }

    /** 表单草稿 → 提交负载 */
    function draftToPayload(draft) {
      const payload = {
        name: draft.name,
        enabled: draft.enabled,
        mode: draft.mode,
        timeZone: draft.timeZone,
        action: draft.action,
        content: draft.content,
      };
      if (draft.mode === "once") {
        const date = new Date(draft.at);
        payload.at = Number.isNaN(date.getTime()) ? "" : date.toISOString();
      } else if (draft.mode === "daily" || draft.mode === "weekly") {
        payload.time = draft.time;
        if (draft.mode === "weekly") payload.weekdays = draft.weekdays.slice().sort((a, b) => a - b);
        payload.startDate = draft.startDate || null;
        payload.endDate = draft.endDate || null;
      } else {
        payload.intervalMinutes = Number(draft.intervalMinutes);
        payload.startDate = draft.startDate || null;
        payload.endDate = draft.endDate || null;
      }
      if (draft.action === "session") payload.sessionId = draft.sessionId;
      return payload;
    }

    /** 新增/编辑表单卡片 */
    function TaskForm(props) {
      const { draft, setDraft, onSave, onCancel, busy, sessions, currentSessionId } = props;
      const set = (patch) => setDraft({ ...draft, ...patch });
      const sessionOptions = Object.entries(sessions || {}).map(([id, s]) => ({
        id,
        label: String((s && (s.displayTitle || s.title)) || id),
      }));
      return jsxs("div", { className: "dsh-st-form", children: [
        jsxs("div", { className: "dsh-st-row", children: [
          jsxs("div", { className: "dsh-st-field", children: [
            jsx("span", { className: "dsh-st-label", children: "任务名称" }),
            jsx("input", {
              className: "dsh-st-input",
              value: draft.name,
              onChange: (e) => set({ name: e.target.value }),
              placeholder: "如：早上提醒写日报",
            }),
          ] }),
          jsxs("div", { className: "dsh-st-field dsh-st-field-sm", children: [
            jsx("span", { className: "dsh-st-label", children: "执行模式" }),
            jsx("select", {
              className: "dsh-st-input dsh-st-select",
              value: draft.mode,
              onChange: (e) => set({ mode: e.target.value }),
              children: MODES.map((m) => jsx("option", { key: m, value: m, children: MODE_LABELS[m] })),
            }),
          ] }),
          jsxs("div", { className: "dsh-st-field dsh-st-field-sm", children: [
            jsx("span", { className: "dsh-st-label", children: "启用" }),
            jsx("input", {
              type: "checkbox",
              checked: draft.enabled,
              onChange: (e) => set({ enabled: e.target.checked }),
            }),
          ] }),
        ] }),
        jsxs("div", { className: "dsh-st-row", children: [
          draft.mode === "once"
            ? jsxs("div", { className: "dsh-st-field", children: [
                jsx("span", { className: "dsh-st-label", children: "执行时间（本地时区 " + draft.timeZone + "）" }),
                jsx("input", {
                  className: "dsh-st-input",
                  type: "datetime-local",
                  step: 60,
                  value: draft.at,
                  onChange: (e) => set({ at: e.target.value }),
                }),
              ] })
            : null,
          (draft.mode === "daily" || draft.mode === "weekly")
            ? jsxs("div", { className: "dsh-st-field dsh-st-field-sm", children: [
                jsx("span", { className: "dsh-st-label", children: "时刻" }),
                jsx("input", {
                  className: "dsh-st-input",
                  type: "time",
                  value: draft.time,
                  onChange: (e) => set({ time: e.target.value }),
                }),
              ] })
            : null,
          draft.mode === "weekly"
            ? jsxs("div", { className: "dsh-st-field", children: [
                jsx("span", { className: "dsh-st-label", children: "星期" }),
                jsx("div", {
                  className: "dsh-st-weekdays",
                  children: WEEKDAY_LABELS.map((label, d) => {
                    const on = draft.weekdays.includes(d);
                    return jsx("button", {
                      key: d,
                      type: "button",
                      className: "dsh-st-wd" + (on ? " dsh-st-wd-on" : ""),
                      onClick: () => set({
                        weekdays: on ? draft.weekdays.filter((x) => x !== d) : [...draft.weekdays, d],
                      }),
                      children: label,
                    });
                  }),
                }),
              ] })
            : null,
          draft.mode === "interval"
            ? jsxs("div", { className: "dsh-st-field dsh-st-field-sm", children: [
                jsx("span", { className: "dsh-st-label", children: "间隔（分钟）" }),
                jsx("input", {
                  className: "dsh-st-input",
                  type: "number",
                  min: 1,
                  max: 10080,
                  step: 1,
                  value: draft.intervalMinutes,
                  onChange: (e) => set({ intervalMinutes: e.target.value }),
                }),
              ] })
            : null,
        ] }),
        draft.mode !== "once"
          ? jsxs("div", { className: "dsh-st-row", children: [
              jsxs("div", { className: "dsh-st-field dsh-st-field-sm", children: [
                jsx("span", { className: "dsh-st-label", children: "开始日期（可选）" }),
                jsx("input", {
                  className: "dsh-st-input",
                  type: "date",
                  value: draft.startDate,
                  onChange: (e) => set({ startDate: e.target.value }),
                }),
              ] }),
              jsxs("div", { className: "dsh-st-field dsh-st-field-sm", children: [
                jsx("span", { className: "dsh-st-label", children: "结束日期（可选）" }),
                jsx("input", {
                  className: "dsh-st-input",
                  type: "date",
                  value: draft.endDate,
                  onChange: (e) => set({ endDate: e.target.value }),
                }),
              ] }),
              jsx("span", { className: "dsh-st-hint", children: "不填则长期有效；到达结束日期后任务自动停用" }),
            ] })
          : null,
        jsxs("div", { className: "dsh-st-row", children: [
          jsxs("div", { className: "dsh-st-field dsh-st-field-sm", children: [
            jsx("span", { className: "dsh-st-label", children: "动作" }),
            jsx("select", {
              className: "dsh-st-input dsh-st-select",
              value: draft.action,
              onChange: (e) => set({ action: e.target.value }),
              children: ACTIONS.map((a) => jsx("option", { key: a, value: a, children: ACTION_LABELS[a] })),
            }),
          ] }),
          draft.action === "session"
            ? jsxs("div", { className: "dsh-st-field", children: [
                jsx("span", { className: "dsh-st-label", children: "目标会话（到点后向该会话发送消息并唤醒 Agent）" }),
                jsx("select", {
                  className: "dsh-st-input dsh-st-select",
                  value: draft.sessionId,
                  onChange: (e) => set({ sessionId: e.target.value }),
                  children: [
                    jsx("option", { key: "", value: "", children: "— 请选择会话 —" }),
                    ...sessionOptions.map((s) => jsx("option", { key: s.id, value: s.id, children: s.label })),
                  ],
                }),
                jsx("span", { className: "dsh-st-hint", children: "仅当前打开（已加载）的会话可选；当前会话：" + (currentSessionId ? truncate(currentSessionId, 12) : "无") }),
              ] })
            : jsxs("div", { className: "dsh-st-field", children: [
                jsx("span", { className: "dsh-st-label", children: "执行命令（通过系统 shell 运行）" }),
                jsx("span", { className: "dsh-st-hint", children: "输出会记录在任务历史中（最多 2000 字符）" }),
              ] }),
        ] }),
        jsxs("div", { className: "dsh-st-field", children: [
          jsx("span", { className: "dsh-st-label", children: draft.action === "session" ? "消息内容（作为用户消息发送给该会话的 Agent）" : "命令内容" }),
          jsx("textarea", {
            className: "dsh-st-textarea",
            value: draft.content,
            onChange: (e) => set({ content: e.target.value }),
            placeholder: draft.action === "session"
              ? "例：现在是早上 9 点，请提醒我今天的工作安排，并帮我整理今天的待办事项。"
              : "例：echo hello",
          }),
        ] }),
        jsxs("div", { className: "dsh-st-actions", children: [
          jsx("button", {
            className: "dsh-st-btn dsh-st-btn-primary",
            disabled: busy,
            onClick: onSave,
            children: busy ? "保存中…" : "保存任务",
          }),
          jsx("button", { className: "dsh-st-btn", disabled: busy, onClick: onCancel, children: "取消" }),
        ] }),
      ] });
    }

    /** 任务卡片 */
    function TaskCard(props) {
      const { task, now, sessions, onEdit, onToggle, onRunNow, onAskDelete, confirmDelete, onConfirmDelete, onCancelDelete, busy } = props;
      const sessionLabel = task.sessionId
        ? (sessions && sessions[task.sessionId] && (sessions[task.sessionId].displayTitle || sessions[task.sessionId].title)) || truncate(task.sessionId, 12)
        : "";
      const lastHistory = task.history && task.history.length > 0 ? task.history[0] : null;
      return jsxs("div", { className: "dsh-st-card", children: [
        jsxs("div", { className: "dsh-st-card-head", children: [
          jsx("span", { className: "dsh-st-name", children: task.name }),
          jsx("span", {
            className: "dsh-st-chip" + (task.completedAt ? " dsh-st-chip-err" : task.enabled ? " dsh-st-chip-on" : " dsh-st-chip-off"),
            children: task.completedAt ? "已结束" : task.enabled ? "启用" : "已暂停",
          }),
          jsx("span", { className: "dsh-st-chip", children: MODE_LABELS[task.mode] || task.mode }),
          jsx("span", { className: "dsh-st-chip", children: ACTION_LABELS[task.action] || task.action }),
          task.missed > 0 ? jsx("span", { className: "dsh-st-chip dsh-st-chip-err", children: "错过 " + task.missed + " 次" }) : null,
        ] }),
        jsxs("div", { className: "dsh-st-desc", children: [
          jsx("span", { children: modeText(task) }),
          task.startDate || task.endDate
            ? jsx("span", { children: "（" + (task.startDate ? task.startDate : "不限") + " ~ " + (task.endDate ? task.endDate : "长期") + "）" })
            : null,
          task.action === "session"
            ? jsx("span", { children: " → " + ACTION_LABELS.session + "「" + (sessionLabel || truncate(task.sessionId, 12)) + "」" })
            : null,
        ] }),
        task.content ? jsx("div", { className: "dsh-st-content", children: truncate(task.content, 300) }) : null,
        jsxs("div", { className: "dsh-st-foot", children: [
          jsxs("span", { className: "dsh-st-meta", children: [
            jsx("span", { children: "下次：" + fmtDateTime(task.nextRunAt) + "（" + fmtRelative(task.nextRunAt, now) + "）" }),
            task.lastRunAt ? jsx("span", { children: " · 上次：" + fmtDateTime(task.lastRunAt) + (lastHistory ? " · " + (lastHistory.status === "ok" ? "成功" : "失败") : "") }) : null,
            jsx("span", { children: " · 已执行 " + (task.runCount || 0) + " 次" }),
          ] }),
          confirmDelete
            ? jsxs("span", { className: "dsh-st-actions", children: [
                jsx("span", { className: "dsh-st-meta", children: "确认删除？" }),
                jsx("button", { className: "dsh-st-btn dsh-st-btn-danger", disabled: busy, onClick: onConfirmDelete, children: "确认删除" }),
                jsx("button", { className: "dsh-st-btn", disabled: busy, onClick: onCancelDelete, children: "取消" }),
              ] })
            : jsxs("span", { className: "dsh-st-actions", children: [
                jsx("button", { className: "dsh-st-btn", disabled: busy, onClick: onRunNow, children: "立即执行" }),
                jsx("button", { className: "dsh-st-btn", disabled: busy, onClick: onEdit, children: "编辑" }),
                jsx("button", { className: "dsh-st-btn", disabled: busy, onClick: onToggle, children: task.enabled ? "暂停" : "启用" }),
                jsx("button", { className: "dsh-st-btn dsh-st-btn-danger", disabled: busy, onClick: onAskDelete, children: "删除" }),
              ] }),
        ] }),
        lastHistory ? jsxs("div", { className: "dsh-st-history", children: [
          jsx("span", { className: "dsh-st-hitem", children: "最近执行：" + fmtDateTime(lastHistory.at) + " · " + (lastHistory.status === "ok" ? "成功" : "失败") }),
          lastHistory.detail ? jsx("span", { className: "dsh-st-hitem", children: truncate(lastHistory.detail, 200) }) : null,
        ] }) : null,
      ] });
    }

    /** 定时任务面板主体（列表 + 表单 + 操作） */
    function TasksSection(props) {
      const [tasks, setTasks] = useState([]);
      const [now, setNow] = useState(Date.now());
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState("");
      const [notice, setNotice] = useState("");
      const [showAdd, setShowAdd] = useState(false);
      const [editingId, setEditingId] = useState(null);
      const [draft, setDraft] = useState(null);
      const [confirmId, setConfirmId] = useState(null);
      const mountedRef = useRef(true);
      useEffect(() => () => { mountedRef.current = false; }, []);

      const { useSessions } = props;
      const hostSessions = useSessions ? useSessions((s) => s) : null;
      const sessions = (hostSessions && hostSessions.byId) || {};
      const currentSessionId = hostSessions && hostSessions.current ? String(hostSessions.current) : "";

      const load = useCallback(async () => {
        try {
          const data = await apiFetch("/scheduled-tasks/api/list");
          if (!mountedRef.current) return;
          setTasks(Array.isArray(data.tasks) ? data.tasks : []);
          setNow(data.now || Date.now());
          setError("");
        } catch (err) {
          if (mountedRef.current) setError(err && err.message ? err.message : String(err));
        }
      }, []);

      useEffect(() => {
        load();
        const timer = setInterval(load, 30000);
        const onVisible = () => { if (document.visibilityState === "visible") load(); };
        document.addEventListener("visibilitychange", onVisible);
        return () => {
          clearInterval(timer);
          document.removeEventListener("visibilitychange", onVisible);
        };
      }, [load]);

      const runAction = async (fn, successText) => {
        setBusy(true);
        setError("");
        setNotice("");
        try {
          await fn();
          await load();
          if (successText) setNotice(successText);
        } catch (err) {
          setError(err && err.message ? err.message : String(err));
        } finally {
          setBusy(false);
        }
      };

      const saveTask = () => {
        const payload = draftToPayload(draft);
        runAction(
          () => apiFetch("/scheduled-tasks/api/save", { method: "POST", body: { id: editingId || undefined, task: payload } }),
          editingId ? "任务已更新" : "任务已创建",
        ).then(() => {
          setShowAdd(false);
          setEditingId(null);
          setDraft(null);
        });
      };

      const toggleTask = (task) => {
        runAction(
          () => apiFetch("/scheduled-tasks/api/toggle", { method: "POST", body: { id: task.id, enabled: !task.enabled } }),
          task.enabled ? "任务已暂停" : "任务已启用",
        );
      };

      const runNow = (task) => {
        runAction(
          async () => {
            const data = await apiFetch("/scheduled-tasks/api/run-now", { method: "POST", body: { id: task.id } });
            setNotice("立即执行：" + (data.status === "ok" ? "成功" : "失败") + (data.detail ? "（" + truncate(data.detail, 120) + "）" : ""));
          },
          null,
        );
      };

      const deleteTask = (id) => {
        runAction(
          () => apiFetch("/scheduled-tasks/api/delete", { method: "POST", body: { id } }),
          "任务已删除",
        ).then(() => setConfirmId(null));
      };

      const startEdit = (task) => {
        setEditingId(task.id);
        setDraft(taskToDraft(task));
        setShowAdd(false);
      };

      const startAdd = () => {
        setEditingId(null);
        setDraft(taskToDraft(null));
        setShowAdd(true);
      };

      const enabledCount = tasks.filter((t) => t.enabled).length;

      return jsxs("div", { className: "dsh-st", children: [
        jsxs("div", { className: "dsh-st-head", children: [
          jsx("div", { className: "dsh-st-title", children: "定时任务" }),
          jsx("div", { className: "dsh-st-sub", children: "设置任务的执行时间与内容：到点后自动向指定会话发送消息并唤醒 Agent，或执行系统命令。任务在应用重启后自动恢复调度。" }),
        ] }),
        jsxs("div", { className: "dsh-st-toolbar", children: [
          jsx("button", {
            className: "dsh-st-btn dsh-st-btn-primary",
            disabled: busy || showAdd || editingId !== null,
            onClick: startAdd,
            children: "＋ 新建任务",
          }),
          jsx("button", { className: "dsh-st-btn", disabled: busy, onClick: load, children: "刷新" }),
          jsxs("span", { className: "dsh-st-stats", children: [
            jsx("span", { className: "dsh-st-chip", children: "共 " + tasks.length + " 个任务" }),
            jsx("span", { className: "dsh-st-chip", children: "启用 " + enabledCount + " 个" }),
            jsx("span", { className: "dsh-st-chip", children: "执行 " + tasks.reduce((n, t) => n + (t.runCount || 0), 0) + " 次" }),
          ] }),
        ] }),
        error ? jsx("div", { className: "dsh-st-error", children: error }) : null,
        notice ? jsx("div", { className: "dsh-st-info", children: notice }) : null,
        showAdd || editingId !== null
          ? jsx(TaskForm, {
              draft: draft,
              setDraft: setDraft,
              onSave: saveTask,
              onCancel: () => { setShowAdd(false); setEditingId(null); setDraft(null); },
              busy: busy,
              sessions: sessions,
              currentSessionId: currentSessionId,
            })
          : null,
        jsx("div", {
          className: "dsh-st-list",
          children: tasks.length === 0 && !busy
            ? jsx("div", { className: "dsh-st-empty", children: "还没有定时任务。点击「＋ 新建任务」创建第一个任务。" })
            : tasks.map((t) => jsx(TaskCard, {
                key: t.id,
                task: t,
                now: now,
                sessions: sessions,
                onEdit: () => startEdit(t),
                onToggle: () => toggleTask(t),
                onRunNow: () => runNow(t),
                onAskDelete: () => { setConfirmId(t.id); setEditingId(null); setShowAdd(false); },
                confirmDelete: confirmId === t.id,
                onConfirmDelete: () => deleteTask(t.id),
                onCancelDelete: () => setConfirmId(null),
                busy: busy,
              })),
        }),
      ] });
    }

    /** 侧边栏入口 + 独立面板（与"设置"同级） */
    function ScheduledTasksEntry(props) {
      const { wide, useSessions } = props;
      const [open, setOpen] = useState(false);
      const close = useCallback(() => setOpen(false), []);
      useEffect(() => {
        if (!open) return;
        const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
      }, [open]);
      return jsxs(Fragment, { children: [
        jsx("button", {
          type: "button",
          className: "dsh-st-trigger",
          "data-rail": wide ? undefined : true,
          "aria-haspopup": "dialog",
          "aria-expanded": open,
          title: "定时任务",
          onClick: () => setOpen(true),
          children: [
            jsx(IconGoalOutline16, { size: wide ? 16 : 18 }),
            wide ? jsx("span", { className: "dsh-st-trigger-label", children: "定时任务" }) : null,
          ],
        }),
        open
          ? jsxs("div", { className: "dsh-st-overlay", role: "dialog", "aria-label": "定时任务", children: [
              jsx("div", { className: "dsh-st-mask", onClick: close }),
              jsxs("div", { className: "dsh-st-panel", children: [
                jsxs("div", { className: "dsh-st-panel-head", children: [
                  jsx("span", { className: "dsh-st-panel-title", children: "定时任务" }),
                  jsx("button", {
                    type: "button",
                    className: "dsh-st-panel-close",
                    "aria-label": "关闭",
                    onClick: close,
                    children: jsx(IconCloseOutline16, { size: 14 }),
                  }),
                ] }),
                jsx("div", { className: "dsh-st-panel-body", children: jsx(TasksSection, { useSessions: useSessions }) }),
              ] }),
            ] })
          : null,
      ] });
    }

    const inject = ["slots"];

    function apply(ctx) {
      ensureCss();
      ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
        name: "sidebar.footer.action",
        id: "scheduled-tasks",
        order: 10,
        label: () => "定时任务",
        inject: () => ({}),
      }, ScheduledTasksEntry));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
