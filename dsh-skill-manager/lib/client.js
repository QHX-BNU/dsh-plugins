// dsh-skill-manager 客户端插件（浏览器 bundle，__ModuleLoader__ 格式）
// 1) 在侧边栏底部注册"Skill 管理"入口（与"定时任务/插件市场/设置"同级），
//    打开独立面板：浏览已安装 skills（启用/禁用/删除/刷新），
//    从 GitHub 市场仓库扫描并下载 skills；
// 2) 注册 @ 输入触发源（两级路由菜单）：
//    - 第一级「选择」：输入框输入 @ 弹出「技能 / 工作区文件」两个分类；
//    - 点击分类后进入第二级（宿主 launcher 打开单分组菜单）：
//      「技能」按名称/描述搜索 skills，「工作区文件」搜索当前会话工作区文件
//      （依赖 dsh-code-panel 的 /code-panel/api/search）；
//    - 选中技能或文件均以结构引用（occurrence chip）插入输入框——chip 带
//      背景色边框，label 为「技能 · 名称」/「文件 · 相对路径」，一眼可辨；
//      发送时经各自 codec 序列化为 `/skill-name`（服务端 SKILL_GESTURE 识别）
//      或 `@相对路径`（模型可据此读取工作区文件）。
// 注意：React 19 的 jsx(type, props) 中 children 必须放进 props 对象。
window.__ModuleLoader__.load({
  id: "dsh-skill-manager",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var react_jsx_runtime = require("react/jsx-runtime");
    var react = require("react");
    var primitives = require("@deepseek-ai/dsh-client-ui-primitives");
    const { jsx, jsxs, Fragment } = react_jsx_runtime;
    const { useState, useEffect, useRef, useCallback } = react;
    const { IconSkillOutline16, IconCloseOutline16, IconSearchOutline16 } = primitives;

    const FEATURED_REPOS = [
      "xu-jin-cs/dsh-skills",
      "xiaohui5206/01-context-window",
      "xiaohui5206/02-reasoning-efforts",
      "xiaohui5206/03-vision-input",
      "Kenerlee/dsh-moments-aieo",
    ];

    const css = `
[class*="_footerActions"]{flex-direction:column !important;align-items:stretch}
.dsh-sm-trigger{box-sizing:border-box;cursor:pointer;width:calc(100% + 4px);height:42px;color:var(--dsw-alias-label-primary);background:transparent;border:none;border-radius:12px;flex:none;align-items:center;gap:8px;margin:4px -2px;padding:0 10px 0 8px;font-family:inherit;font-size:14px;line-height:22px;display:flex;overflow:hidden}
.dsh-sm-trigger:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-sm-trigger[data-rail=true]{border-radius:50%;justify-content:center;gap:0;width:36px;height:36px;margin:8px 0 10px;padding:0}
.dsh-sm-trigger-label{white-space:nowrap;overflow:hidden}
.dsh-sm-overlay{z-index:1000;justify-content:center;align-items:center;display:flex;position:fixed;inset:0}
.dsh-sm-mask{background:var(--dsw-alias-bg-mask-1);backdrop-filter:var(--dsw-mask-blur);position:absolute;inset:0}
.dsh-sm-panel{z-index:1;background:var(--dsw-alias-bg-layer-2);width:920px;max-width:calc(100vw - 48px);height:min(840px,100vh - 48px);box-shadow:var(--dsw-shadow-lv3);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);border-radius:24px;display:flex;flex-direction:column;position:relative;overflow:hidden}
.dsh-sm-panel-head{box-sizing:border-box;flex:none;justify-content:space-between;align-items:center;gap:8px;height:54px;padding:20px 14px 8px 18px;display:flex}
.dsh-sm-panel-title{color:var(--dsw-alias-label-primary);font-size:16px;font-weight:500;line-height:24px}
.dsh-sm-panel-close{cursor:pointer;width:28px;height:28px;color:var(--dsw-alias-label-primary);background:transparent;border:none;border-radius:28px;justify-content:center;align-items:center;padding:0;display:inline-flex}
.dsh-sm-panel-close:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-sm-panel-body{flex:1;min-height:0;padding:4px 24px 24px;overflow-y:auto}
.dsh-sm{display:flex;flex-direction:column;gap:14px;padding:4px 0 24px;min-width:0}
.dsh-sm *{box-sizing:border-box}
.dsh-sm-tabs{display:flex;gap:6px;flex:none;padding:2px;background:var(--dsw-alias-bg-module-platform);border-radius:10px;width:fit-content}
.dsh-sm-tab{border:none;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:20px;padding:5px 14px;border-radius:8px;cursor:pointer}
.dsh-sm-tab-on{background:var(--dsw-static-neutral-bluish-1000,#1d2b4f);color:#ffffff}
.dsh-sm-head{display:flex;flex-direction:column;gap:4px}
.dsh-sm-title{font-size:16px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dsh-sm-sub{font-size:12px;color:var(--dsw-alias-label-tertiary);line-height:1.6}
.dsh-sm-toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.dsh-sm-search{flex:1;min-width:180px;position:relative;display:flex;align-items:center}
.dsh-sm-search-icon{position:absolute;left:10px;color:var(--dsw-alias-label-tertiary);display:inline-flex;pointer-events:none}
.dsh-sm-search input{width:100%;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);height:32px;font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 10px 0 32px;outline:none}
.dsh-sm-search input:focus-visible{border-color:var(--dsw-alias-brand-primary)}
.dsh-sm-stats{display:flex;flex-wrap:wrap;gap:8px}
.dsh-sm-chip{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:2px 10px;font-size:12px;line-height:18px;white-space:nowrap}
.dsh-sm-chip-on{border:1px solid var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary);background:transparent}
.dsh-sm-chip-off{color:var(--dsw-alias-label-tertiary)}
.dsh-sm-chip-sys{border:1px solid var(--dsw-alias-label-caption);color:var(--dsw-alias-label-tertiary);background:transparent}
.dsh-sm-chip-err{border:1px solid var(--dsw-alias-label-error);color:var(--dsw-alias-label-error);background:transparent}
.dsh-sm-btn{font:inherit;font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;height:30px;padding:0 12px;cursor:pointer;white-space:nowrap}
.dsh-sm-btn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary)}
.dsh-sm-btn:disabled{opacity:.5;cursor:default}
.dsh-sm-btn-primary{background:var(--dsw-static-neutral-bluish-1000,#1d2b4f);border-color:var(--dsw-static-neutral-bluish-1000,#1d2b4f);color:#ffffff}
.dsh-sm-btn-danger{color:var(--dsw-alias-label-error);border-color:var(--dsw-alias-label-error)}
.dsh-sm-error{color:var(--dsw-alias-label-error);font-size:12px;border:1px solid var(--dsw-alias-label-error);border-radius:8px;padding:8px 12px;word-break:break-word}
.dsh-sm-info{color:var(--dsw-alias-state-success-primary);font-size:12px;border:1px solid var(--dsw-alias-state-success-primary);border-radius:8px;padding:8px 12px;word-break:break-word}
.dsh-sm-list{display:flex;flex-direction:column;gap:10px}
.dsh-sm-card{background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:8px;min-width:0}
.dsh-sm-card-head{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.dsh-sm-name{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-sm-desc{font-size:13px;line-height:1.6;color:var(--dsw-alias-label-secondary);word-break:break-word;min-width:0}
.dsh-sm-meta{font-size:11px;color:var(--dsw-alias-label-tertiary);word-break:break-word}
.dsh-sm-foot{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap}
.dsh-sm-actions{display:flex;gap:6px;flex-wrap:wrap}
.dsh-sm-empty{color:var(--dsw-alias-label-tertiary);font-size:13px;text-align:center;padding:24px 0}
.dsh-sm-repo{display:flex;gap:8px;flex-wrap:wrap}
.dsh-sm-repo input{flex:1;min-width:200px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);height:32px;font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 10px;outline:none}
.dsh-sm-repo input:focus-visible{border-color:var(--dsw-alias-brand-primary)}
.dsh-sm-featured{display:flex;flex-wrap:wrap;gap:6px}
.dsh-sm-feat{font:inherit;font-size:12px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-module-platform);border:1px solid transparent;border-radius:999px;padding:3px 12px;cursor:pointer}
.dsh-sm-feat:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary)}
.dsh-sm-hint{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dsh-sm-skill-path{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;color:var(--dsw-alias-label-secondary);word-break:break-all}
.dsh-sm-loading{color:var(--dsw-alias-label-tertiary);font-size:13px;text-align:center;padding:20px 0}
`;

    function ensureCss() {
      const tagId = "dsh-skill-manager/section.css";
      if (typeof document !== "undefined" && document.querySelector('style[data-plugin-css="' + tagId + '"]') === null) {
        const tag = document.createElement("style");
        tag.dataset.plugin = "dsh-skill-manager";
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
        throw new Error("无法连接 Skill 管理服务：" + (err && err.message ? err.message : String(err)));
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

    function truncate(s, n) {
      if (!s) return "";
      return s.length > n ? s.slice(0, n) + "…" : s;
    }

    function fmtTime(ts) {
      if (!ts) return "—";
      try {
        return new Date(ts).toLocaleString();
      } catch {
        return "—";
      }
    }

    /** 已安装列表卡片（managed：位于 <dshHome>/skills，可管理；system：其他来源只读） */
    function SkillCard(props) {
      const { item, installed, onToggle, onRemove, onRefresh, confirmRemove, busy } = props;
      const record = installed && installed[item.name] ? installed[item.name] : null;
      const sys = item.system;
      return jsxs("div", { className: "dsh-sm-card", children: [
        jsxs("div", { className: "dsh-sm-card-head", children: [
          jsx("span", { className: "dsh-sm-name", children: item.name }),
          sys
            ? jsx("span", { className: "dsh-sm-chip dsh-sm-chip-sys", children: "系统" })
            : jsx("span", {
                className: "dsh-sm-chip" + (item.parseError ? " dsh-sm-chip-err" : item.enabled ? " dsh-sm-chip-on" : " dsh-sm-chip-off"),
                children: item.parseError ? "解析失败" : item.enabled ? "已启用" : "已禁用",
              }),
          item.system ? null : jsx("span", { className: "dsh-sm-chip", children: item.kind === "flat" ? "单文件" : "目录" }),
          item.userInvocable === false ? jsx("span", { className: "dsh-sm-chip", children: "仅模型" }) : null,
          item.modelInvocable === false ? jsx("span", { className: "dsh-sm-chip", children: "仅用户" }) : null,
        ] }),
        jsx("div", { className: "dsh-sm-desc", children: item.description || "（无描述）" }),
        jsxs("div", { className: "dsh-sm-meta", children: [
          sys
            ? jsx("span", { children: "来源：" + (item.source || item.provider || "系统") })
            : jsx(Fragment, { children: [
                jsx("span", { children: "类型：" + (item.kind === "flat" ? "单文件 <name>.md" : "目录 <name>/SKILL.md") }),
                record ? jsx("span", { children: " · 来源仓库：" + record.repo + "（" + record.skillPath + "）" }) : null,
                record ? jsx("span", { children: " · 安装于 " + fmtTime(record.installedAt) }) : null,
              ] }),
        ] }),
        jsxs("div", { className: "dsh-sm-foot", children: [
          jsx("span", { className: "dsh-sm-meta", children: item.path ? truncate(item.path, 80) : "" }),
          sys
            ? null
            : confirmRemove
              ? jsxs("span", { className: "dsh-sm-actions", children: [
                  jsx("span", { className: "dsh-sm-meta", children: "确认删除？" }),
                  jsx("button", { className: "dsh-sm-btn dsh-sm-btn-danger", disabled: busy, onClick: onRemove, children: "确认删除" }),
                  jsx("button", { className: "dsh-sm-btn", disabled: busy, onClick: onRefresh, children: "取消" }),
                ] })
              : jsxs("span", { className: "dsh-sm-actions", children: [
                  record ? jsx("button", { className: "dsh-sm-btn", disabled: busy, onClick: onRefresh, children: "刷新" }) : null,
                  jsx("button", {
                    className: "dsh-sm-btn" + (item.enabled ? "" : " dsh-sm-btn-primary"),
                    disabled: busy,
                    onClick: onToggle,
                    children: item.enabled ? "禁用" : "启用",
                  }),
                  jsx("button", { className: "dsh-sm-btn dsh-sm-btn-danger", disabled: busy, onClick: onRemove, children: "删除" }),
                ] }),
        ] }),
      ] });
    }

    /** 已安装 tab */
    function InstalledTab(props) {
      const { data, busy, onAction } = props;
      const [query, setQuery] = useState("");
      const [confirmName, setConfirmName] = useState(null);
      const managed = data && Array.isArray(data.managed) ? data.managed : [];
      const sessionSkills = data && Array.isArray(data.sessionSkills) ? data.sessionSkills : [];
      const installed = (data && data.installed) || {};

      // 系统分组 = 会话级 catalog 中不在本地 managed 的（与 @ 菜单同一数据源）
      const managedNames = new Set(managed.map((m) => m.name));
      const system = sessionSkills
        .filter((c) => !managedNames.has(c.name))
        .map((c) => ({ ...c, system: true, enabled: false, kind: "other", description: c.description || "" }));

      const q = query.trim().toLowerCase();
      const visible = [...managed, ...system].filter((item) => {
        if (!q) return true;
        return item.name.toLowerCase().includes(q) || (item.description || "").toLowerCase().includes(q);
      });

      const enabledCount = managed.filter((m) => m.enabled && !m.parseError).length;
      const disabledCount = managed.filter((m) => !m.enabled && !m.parseError).length;

      return jsxs(Fragment, { children: [
        jsxs("div", { className: "dsh-sm-toolbar", children: [
          jsxs("div", { className: "dsh-sm-search", children: [
            jsx("span", { className: "dsh-sm-search-icon", children: jsx(IconSearchOutline16, { size: 14 }) }),
            jsx("input", {
              value: query,
              onChange: (e) => setQuery(e.target.value),
              placeholder: "搜索已安装的 skills…",
            }),
          ] }),
          jsxs("span", { className: "dsh-sm-stats", children: [
            jsx("span", { className: "dsh-sm-chip", children: "本地 " + managed.length + " 个" }),
            jsx("span", { className: "dsh-sm-chip dsh-sm-chip-on", children: "启用 " + enabledCount }),
            jsx("span", { className: "dsh-sm-chip dsh-sm-chip-off", children: "禁用 " + disabledCount }),
            jsx("span", { className: "dsh-sm-chip dsh-sm-chip-sys", children: "系统 " + system.length }),
          ] }),
        ] }),
        jsx("div", { className: "dsh-sm-hint", children: "本地 skills 位于 " + (data ? data.skillsDir : "") + "，改动即时生效。" }),
        jsx("div", {
          className: "dsh-sm-list",
          children: visible.length === 0
            ? jsx("div", { className: "dsh-sm-empty", children: q ? "没有匹配的 skill" : "还没有安装 skills，去「市场」下载吧。" })
            : visible.map((item) => jsx(SkillCard, {
                key: (item.system ? "sys:" : "mgr:") + item.name,
                item: item,
                installed: installed,
                busy: busy,
                confirmRemove: confirmName === item.name && !item.system,
                onToggle: () => onAction("toggle", item),
                onRemove: () => {
                  if (confirmName === item.name) {
                    onAction("remove", item);
                    setConfirmName(null);
                  } else {
                    setConfirmName(item.name);
                  }
                },
                onRefresh: () => onAction("refresh", item),
              })),
        }),
      ] });
    }

    /** 市场 tab */
    function MarketTab(props) {
      const { data, busy, onAction } = props;
      const [repo, setRepo] = useState("");
      const [scanning, setScanning] = useState(false);
      const [scanned, setScanned] = useState(null);
      const [scanError, setScanError] = useState("");
      const managed = data && Array.isArray(data.managed) ? data.managed : [];
      const installedNames = new Set(managed.map((m) => m.name));

      const scan = async (target) => {
        const value = (target !== undefined ? target : repo).trim();
        if (!value) return;
        setRepo(value);
        setScanning(true);
        setScanError("");
        setScanned(null);
        try {
          const result = await apiFetch("/skill-manager/api/market?repo=" + encodeURIComponent(value));
          setScanned(result);
        } catch (err) {
          setScanError(err && err.message ? err.message : String(err));
        } finally {
          setScanning(false);
        }
      };

      return jsxs(Fragment, { children: [
        jsxs("div", { className: "dsh-sm-repo", children: [
          jsx("input", {
            value: repo,
            onChange: (e) => setRepo(e.target.value),
            onKeyDown: (e) => { if (e.key === "Enter") scan(); },
            placeholder: "输入 GitHub 仓库 owner/repo，如 xu-jin-cs/dsh-skills",
          }),
          jsx("button", { className: "dsh-sm-btn dsh-sm-btn-primary", disabled: busy || scanning, onClick: () => scan(), children: scanning ? "扫描中…" : "扫描仓库" }),
        ] }),
        jsxs("div", { className: "dsh-sm-featured", children: [
          jsx("span", { className: "dsh-sm-hint", children: "精选仓库：" }),
          ...FEATURED_REPOS.map((r) => jsx("button", {
            key: r,
            type: "button",
            className: "dsh-sm-feat",
            disabled: busy || scanning,
            onClick: () => scan(r),
            children: r,
          })),
        ] }),
        jsx("div", { className: "dsh-sm-hint", children: "下载会写入本地 skills 目录（bundle 格式 <name>/SKILL.md），安装后默认启用。" }),
        scanError ? jsx("div", { className: "dsh-sm-error", children: scanError }) : null,
        scanning ? jsx("div", { className: "dsh-sm-loading", children: "正在扫描仓库…" }) : null,
        scanned && Array.isArray(scanned.skills)
          ? jsx("div", { className: "dsh-sm-list", children: [
              jsxs("div", { className: "dsh-sm-toolbar", children: [
                jsxs("span", { className: "dsh-sm-stats", children: [
                  jsx("span", { className: "dsh-sm-chip", children: scanned.repo }),
                  jsx("span", { className: "dsh-sm-chip", children: "发现 " + scanned.skills.length + " 个 skill" }),
                ] }),
              ] }),
              scanned.skills.length === 0
                ? jsx("div", { className: "dsh-sm-empty", children: "该仓库中没有找到 SKILL.md 文件" })
                : scanned.skills.map((s, i) => {
                    const already = s.name && installedNames.has(s.name);
                    return jsxs("div", { className: "dsh-sm-card", children: [
                      jsxs("div", { className: "dsh-sm-card-head", children: [
                        jsx("span", { className: "dsh-sm-name", children: s.name || "（frontmatter 缺失）" }),
                        already ? jsx("span", { className: "dsh-sm-chip dsh-sm-chip-on", children: "已安装" }) : null,
                      ] }),
                      jsx("div", { className: "dsh-sm-desc", children: s.description || (s.error ? "⚠ " + s.error : "") }),
                      jsx("div", { className: "dsh-sm-skill-path", children: s.path }),
                      jsxs("div", { className: "dsh-sm-foot", children: [
                        jsx("span", { className: "dsh-sm-meta", children: s.error && s.name ? "解析警告：" + s.error : "" }),
                        jsx("button", {
                          className: "dsh-sm-btn dsh-sm-btn-primary",
                          disabled: busy || scanning || (s.name && installedNames.has(s.name)) || !s.name,
                          onClick: () => onAction("import", { repo: scanned.repo, skillPath: s.path, name: s.name }),
                          children: s.name && installedNames.has(s.name) ? "已安装" : "安装",
                        }),
                      ] }),
                    ] }, "mkt-" + i);
                  }),
            ] })
          : null,
      ] });
    }

    /** 管理面板主体 */
    function ManagerSection(props) {
      const [data, setData] = useState(null);
      const [tab, setTab] = useState("installed");
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState("");
      const [notice, setNotice] = useState("");
      const mountedRef = useRef(true);
      useEffect(() => () => { mountedRef.current = false; }, []);

      const load = useCallback(async () => {
        try {
          const result = await apiFetch("/skill-manager/api/list");
          let sessionSkills = [];
          try {
            const sessionId = props.currentSessionId ? props.currentSessionId() : null;
            if (sessionId && props.fetchSessionSkills) {
              sessionSkills = await props.fetchSessionSkills(sessionId);
            }
          } catch (err) {
            console.error("[skill-manager] session catalog failed:", err);
          }
          if (!mountedRef.current) return;
          setData({ ...result, sessionSkills: Array.isArray(sessionSkills) ? sessionSkills : [] });
          setError("");
        } catch (err) {
          if (mountedRef.current) setError(err && err.message ? err.message : String(err));
        }
      }, [props.currentSessionId, props.fetchSessionSkills]);

      useEffect(() => {
        load();
      }, [load]);

      const runAction = async (kind, item) => {
        setBusy(true);
        setError("");
        setNotice("");
        try {
          let result;
          if (kind === "toggle") {
            result = await apiFetch("/skill-manager/api/set-enabled", { method: "POST", body: { name: item.name, enabled: !item.enabled } });
            setNotice("skill「" + result.name + "」已" + (result.enabled ? "启用" : "禁用"));
          } else if (kind === "remove") {
            result = await apiFetch("/skill-manager/api/remove", { method: "POST", body: { name: item.name } });
            setNotice("skill「" + result.name + "」已删除");
          } else if (kind === "refresh") {
            result = await apiFetch("/skill-manager/api/refresh", { method: "POST", body: { name: item.name } });
            setNotice("skill「" + result.name + "」已从来源重新安装");
          } else if (kind === "import") {
            result = await apiFetch("/skill-manager/api/import", { method: "POST", body: { repo: item.repo, skillPath: item.skillPath } });
            setNotice("已安装 skill「" + result.name + "」（默认启用）");
          }
          await load();
          if (props.onCatalogChanged) props.onCatalogChanged();
        } catch (err) {
          setError(err && err.message ? err.message : String(err));
        } finally {
          setBusy(false);
        }
      };

      return jsxs("div", { className: "dsh-sm", children: [
        jsxs("div", { className: "dsh-sm-head", children: [
          jsx("div", { className: "dsh-sm-title", children: "Skill 管理" }),
          jsx("div", { className: "dsh-sm-sub", children: "下载、启用/禁用和管理 DSH skills。对话输入框输入 @ 先选择「技能」或「工作区文件」，再搜索并引用（技能/文件会以带背景色的引用框插入输入框）。" }),
        ] }),
        jsxs("div", { className: "dsh-sm-tabs", children: [
          jsx("button", { className: "dsh-sm-tab" + (tab === "installed" ? " dsh-sm-tab-on" : ""), onClick: () => setTab("installed"), children: "已安装" }),
          jsx("button", { className: "dsh-sm-tab" + (tab === "market" ? " dsh-sm-tab-on" : ""), onClick: () => setTab("market"), children: "市场" }),
        ] }),
        error ? jsx("div", { className: "dsh-sm-error", children: error }) : null,
        notice ? jsx("div", { className: "dsh-sm-info", children: notice }) : null,
        tab === "installed"
          ? jsx(InstalledTab, { data: data, busy: busy, onAction: runAction })
          : jsx(MarketTab, { data: data, busy: busy, onAction: runAction }),
      ] });
    }

    /** 侧边栏入口 + 独立面板（与"定时任务/插件市场/设置"同级） */
    function SkillManagerEntry(props) {
      const { wide, onCatalogChanged, fetchSessionSkills, currentSessionId } = props;
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
          className: "dsh-sm-trigger",
          "data-rail": wide ? undefined : true,
          "aria-haspopup": "dialog",
          "aria-expanded": open,
          title: "Skill 管理",
          onClick: () => setOpen(true),
          children: [
            jsx(IconSkillOutline16, { size: wide ? 16 : 18 }),
            wide ? jsx("span", { className: "dsh-sm-trigger-label", children: "Skill 管理" }) : null,
          ],
        }),
        open
          ? jsxs("div", { className: "dsh-sm-overlay", role: "dialog", "aria-label": "Skill 管理", children: [
              jsx("div", { className: "dsh-sm-mask", onClick: close }),
              jsxs("div", { className: "dsh-sm-panel", children: [
                jsxs("div", { className: "dsh-sm-panel-head", children: [
                  jsx("span", { className: "dsh-sm-panel-title", children: "Skill 管理" }),
                  jsx("button", {
                    type: "button",
                    className: "dsh-sm-panel-close",
                    "aria-label": "关闭",
                    onClick: close,
                    children: jsx(IconCloseOutline16, { size: 14 }),
                  }),
                ] }),
                jsx("div", { className: "dsh-sm-panel-body", children: jsx(ManagerSection, { onCatalogChanged: onCatalogChanged, fetchSessionSkills: fetchSessionSkills, currentSessionId: currentSessionId }) }),
              ] }),
            ] })
          : null,
      ] });
    }

    const inject = ["slots", "inputTriggers", "connection", "sessions", "remote"];

    function apply(ctx) {
      ensureCss();
      const skillsApi = ctx.get("connection").api.skills;
      const sessions = ctx.get("sessions");
      // catalog 缓存：@ 菜单与 lexicon 共用；显式失效 + 10 秒 TTL
      const fetches = new Map();
      const lexiconListeners = new Map();
      const notifyLexicon = (sessionId) => {
        for (const listener of [...(lexiconListeners.get(sessionId) || [])]) {
          try { listener(); } catch (err) { console.error("[skill-manager] lexicon listener failed:", err); }
        }
      };
      const fetchCatalog = (sessionId) => {
        if (sessions.subagentAddress && sessions.subagentAddress(sessionId) !== void 0) return Promise.resolve([]);
        const existing = fetches.get(sessionId);
        if (existing !== void 0) {
          if (Date.now() - existing.at < 10000) return existing.promise;
          existing.abort.abort();
          fetches.delete(sessionId);
        }
        const abort = new AbortController();
        const promise = (async () => {
          const { result } = await skillsApi.list({ sessionId }, abort.signal);
          if (!result.ok) throw new Error("skill.list failed: " + result.error.code + ": " + result.error.message);
          return result.value.skills;
        })();
        const entry = { promise, abort, at: Date.now() };
        fetches.set(sessionId, entry);
        promise.then((skills) => {
          entry.settled = skills;
          notifyLexicon(sessionId);
        }, () => {
          if (fetches.get(sessionId) === entry) fetches.delete(sessionId);
        });
        return promise;
      };
      const clearAll = () => {
        for (const key of [...fetches.keys()]) {
          const entry = fetches.get(key);
          fetches.delete(key);
          entry.abort.abort();
          notifyLexicon(key);
        }
      };
      const currentSessionId = () => {
        const snap = sessions.list.getSnapshot();
        return snap && snap.current ? String(snap.current) : null;
      };

      // ---------------------------------------------------------------- @ 文件选择（工作区文件）

      /** 取会话工作区根目录（sessions 投影里的 cwd）。 */
      const workspaceRootOf = (sessionId) => {
        try {
          const snap = sessions.list.getSnapshot();
          if (!snap || !snap.byId) return null;
          const entry = snap.byId[sessionId];
          return entry && entry.cwd ? String(entry.cwd) : null;
        } catch {
          return null;
        }
      };

      /** 探测 dsh-code-panel 是否已安装（其客户端监听 probe 事件并同步应答）。 */
      function codePanelAvailable() {
        try {
          const detail = { available: false };
          window.dispatchEvent(new CustomEvent("dsh-code-panel:probe", { detail }));
          return detail.available === true;
        } catch {
          return false;
        }
      }

      /** 调用代码面板搜索接口（携带 abort signal；被中断时抛出 AbortError）。 */
      async function fetchFileSearch(root, query, signal) {
        const params = new URLSearchParams({ root, limit: "50" });
        if (query) params.set("query", query);
        let res;
        try {
          res = await fetch("/code-panel/api/search?" + params.toString(), { signal });
        } catch (err) {
          if (err && err.name === "AbortError") throw err;
          throw new Error("无法连接代码面板服务：" + (err && err.message ? err.message : String(err)));
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

      /** 文件条目的图标（与代码面板的扩展名图标风格一致）。 */
      const FILE_ICONS = {
        js: "🟨", mjs: "🟨", cjs: "🟨", jsx: "🟨", ts: "🟦", tsx: "🟦",
        json: "🧾", css: "🎨", html: "🌐", md: "📝", py: "🐍", sql: "🗄️",
        ps1: "🟦", sh: "⚙️", yaml: "⚙️", yml: "⚙️", go: "🔵", rs: "🦀",
        java: "☕", c: "©️", cpp: "©️", cs: "🟣", rb: "💎", php: "🐘",
        png: "🖼️", jpg: "🖼️", jpeg: "🖼️", gif: "🖼️", webp: "🖼️", svg: "🖼️",
      };
      function fileIconOf(name, image) {
        if (image) return "🖼️";
        const dot = name.lastIndexOf(".");
        const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
        return FILE_ICONS[ext] || "📄";
      }
      function fmtSize(n) {
        if (n == null || n <= 0) return "";
        if (n < 1024) return n + " B";
        if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
        return (n / (1024 * 1024)).toFixed(1) + " MB";
      }

      // ---------------------------------------------------------------- @ 两级菜单（路由）

      /**
       * @ 菜单分两级：先选「技能 / 工作区文件」，再显示对应分组的内容。
       * 实现：三个 @ 源（选择/技能/工作区文件）始终注册，各自按当前阶段
       * (stages) 返回候选——非当前阶段返回空数组，空分组在菜单中不渲染，
       * 因此任意时刻菜单只显示当前阶段的分组；点击分类后通过宿主 launcher
       * (controller.toggleSource) 打开只含该分类分组的菜单，@ 后已输入的
       * 查询词随切换延续。
       */
      const stages = new Map();      // sessionId -> "category" | "skill" | "工作区文件"
      const pendingCat = new Map();  // sessionId -> 分类切换在途标记（防菜单关闭回调误重置）
      const menuWatches = new Map(); // sessionId -> { controller, off }

      const stageOf = (sessionId) => stages.get(sessionId) || "category";

      /** 取会话的输入触发控制器（与宿主 ui-input-trigger 同一实例）。 */
      function controllerOf(sessionId) {
        try {
          const actx = sessions.scope(sessionId);
          if (!actx) return null;
          return inputTriggers.sessionOf(actx);
        } catch {
          return null;
        }
      }

      /**
       * 订阅会话菜单的关闭事件：菜单关闭（选中/Esc/点击外部/删除 @）且没有
       * 分类切换在途时，把阶段重置回「选择」，保证下一次 @ 从分类层开始。
       * 随会话作用域销毁自动释放订阅。
       */
      function ensureMenuWatch(sessionId) {
        if (menuWatches.has(sessionId)) return menuWatches.get(sessionId);
        const controller = controllerOf(sessionId);
        if (!controller) return null;
        const off = controller.menu.subscribe((state) => {
          if (state.open) return;
          if (!pendingCat.has(sessionId)) stages.set(sessionId, "category");
        });
        const watch = { controller, off };
        menuWatches.set(sessionId, watch);
        try {
          const actx = sessions.scope(sessionId);
          if (actx && typeof actx.effect === "function") {
            actx.effect(() => () => {
              off();
              if (menuWatches.get(sessionId) === watch) menuWatches.delete(sessionId);
            }, "skill-manager: @ 菜单阶段 watch");
          }
        } catch {
          /* 作用域清理失败不影响主流程 */
        }
        return watch;
      }

      /** 通过 launcher 打开只含一个分类分组的菜单（查询词与 @ 占位 span 延续）。 */
      function openCategoryMenu(sessionId, cat, query, position, span) {
        const watch = ensureMenuWatch(sessionId);
        const controller = watch ? watch.controller : controllerOf(sessionId);
        if (!controller) return false;
        controller.toggleSource(cat, {
          trigger: "@",
          query: query || "",
          position: position || "leading",
          span,
        });
        return controller.menu.getSnapshot().open;
      }

      /**
       * @ 路由源（第一级）：候选为「技能 / 工作区文件」两个分类。
       * 点击分类后切换阶段，并延迟用 launcher 打开对应分组菜单
       * （pick 内部会无条件关闭菜单，必须在 pick 完成后的微任务里重开，
       * 避免菜单闪断；span 保持原 @ 占位，供最终选中时 CAS 替换）。
       */
      const routerSource = {
        trigger: "@",
        name: "选择",
        order: 10,
        async candidates(session, { query }) {
          if (stageOf(session.sessionId) !== "category") return [];
          const q = (query || "").toLowerCase();
          const items = [
            { name: "技能", description: "从已安装的 skills 中选择并引用", icon: "⚡", category: "skill" },
            { name: "工作区文件", description: "引用当前工作区的文件", icon: "📁", category: "工作区文件" },
          ];
          if (!q) return items;
          const hit = items.filter((i) => i.name.toLowerCase().includes(q));
          if (hit.length === 0) {
            return [{ name: "无匹配：\u201C" + query + "\u201D", description: "可选「技能」或「工作区文件」", noMatch: true }];
          }
          return hit;
        },
        onPick({ candidate, session, position, span }) {
          if (!candidate || candidate.noMatch || !candidate.category) return void 0;
          const sid = session.sessionId;
          const cat = candidate.category;
          const controller = controllerOf(sid);
          if (!controller) return void 0;
          ensureMenuWatch(sid);
          const hit = controller.menu.getSnapshot().hit;
          const query = hit && hit.query ? hit.query : "";
          stages.set(sid, cat);
          pendingCat.set(sid, cat);
          Promise.resolve().then(() => {
            if (pendingCat.get(sid) !== cat) return; // 期间已关闭并被重置
            const opened = openCategoryMenu(sid, cat, query, position, span);
            pendingCat.delete(sid);
            if (!opened) stages.set(sid, "category"); // 打开失败则回退到分类层
          });
          return "handled";
        },
      };

      /**
       * @ 文件选择源（第二级）：阶段为「工作区文件」时展示当前会话工作区文件。
       * 候选来自 dsh-code-panel 的 /code-panel/api/search（未安装时显示提示占位）；
       * 选中后以结构引用（occurrence chip）插入输入框——chip 带背景色边框、
       * label 为「文件 · 相对路径」，一眼可辨；发送时经 codec 序列化为
       * `@相对路径`（与宿主 subagent 引用 `@name` 的惯例一致，模型可据此
       * 读取工作区文件）。注：分组标题由输入触发菜单按 source.name 查 locale，
       * 未知键原样返回，因此直接使用中文名即可显示"工作区文件"。
       */
      const fileSource = {
        trigger: "@",
        name: "工作区文件",
        order: 30,
        async candidates(session, { query, signal }) {
          if (stageOf(session.sessionId) !== "工作区文件") return [];
          if (!codePanelAvailable()) {
            return [{ name: "未安装代码面板（dsh-code-panel）", description: "安装后才能在 @ 菜单浏览工作区文件", noMatch: true }];
          }
          const cwd = workspaceRootOf(session.sessionId);
          if (!cwd) {
            return [{ name: "当前会话没有工作区", description: "新建会话并选择工作区后可用", noMatch: true }];
          }
          try {
            const data = await fetchFileSearch(cwd, query, signal);
            if (signal && signal.aborted) return [];
            const q = (query || "").toLowerCase();
            const items = (data.files || []).map((f) => ({
              name: f.name,
              description: (fmtSize(f.size) ? fmtSize(f.size) + " · " : "") + f.rel,
              icon: fileIconOf(f.name, f.image),
              file: { root: data.root || cwd, rel: f.rel, name: f.name },
            }));
            if (q && items.length === 0) {
              // 无匹配占位：让用户知道搜索已生效（onPick 空操作）
              return [{ name: "无匹配：\u201C" + query + "\u201D", description: "试试文件名或路径中的关键词", noMatch: true }];
            }
            return items;
          } catch (err) {
            if (err && err.name === "AbortError") return [];
            console.error("[skill-manager] @ 文件搜索失败:", err && err.message ? err.message : String(err));
            return [];
          }
        },
        onPick({ candidate }) {
          if (!candidate || candidate.noMatch || !candidate.file) return void 0;
          // 结构引用：输入框显示为带背景色的 chip（「文件 · 相对路径」），
          // 发送时由 codec.serialize 展开为 @相对路径
          return {
            insert: {
              source: "工作区文件",
              ref: candidate.file.rel,
              label: "文件 · " + candidate.file.rel,
              clipboardText: candidate.file.rel,
            },
          };
        },
        codec: {
          clipboardText: (ref) => ref,
          serialize: (ref) => Promise.resolve("@" + ref),
        },
      };

      // @ 技能选择源（第二级）：阶段为「skill」时展示 skills（与"子智能体/命令"分组并列）
      const source = {
        trigger: "@",
        name: "skill",
        order: 20,
        async candidates(session, { query, signal }) {
          if (stageOf(session.sessionId) !== "skill") return [];
          let skills = [];
          try {
            skills = await fetchCatalog(session.sessionId);
          } catch (err) {
            console.error("[skill-manager] @ catalog fetch failed:", err);
            return [];
          }
          if (signal && signal.aborted) return [];
          const q = (query || "").toLowerCase();
          const toItem = (skill) => ({
            name: skill.name,
            description: skill.modelInvocable ? skill.description : "仅用户 · " + skill.description,
          });
          if (skills.length === 0) {
            return [{ name: "没有可用的技能", description: "到「Skill 管理」面板下载安装", noMatch: true }];
          }
          if (!q) {
            return skills.map(toItem);
          }
          const prefix = [];
          const rest = [];
          for (const skill of skills) {
            const name = skill.name.toLowerCase();
            if (name.startsWith(q)) prefix.push(skill);
            else if (name.includes(q)
              || (skill.description || "").toLowerCase().includes(q)
              || (skill.whenToUse || "").toLowerCase().includes(q)) rest.push(skill);
          }
          if (prefix.length === 0 && rest.length === 0) {
            // 无匹配占位：让用户知道搜索已生效（onPick 空操作）
            return [{ name: "无匹配：\u201C" + query + "\u201D", description: "试试 skill 名称或描述中的关键词", noMatch: true }];
          }
          return [...prefix, ...rest].slice(0, 100).map(toItem);
        },
        warm(session) {
          fetchCatalog(session.sessionId).catch(() => {});
        },
        lexicon(session) {
          return fetches.get(session.sessionId) && fetches.get(session.sessionId).settled
            ? fetches.get(session.sessionId).settled.map((skill) => skill.name)
            : void 0;
        },
        subscribeLexicon(session, listener) {
          const key = session.sessionId;
          const listeners = lexiconListeners.get(key) || new Set();
          listeners.add(listener);
          lexiconListeners.set(key, listeners);
          return () => {
            listeners.delete(listener);
            if (listeners.size === 0) lexiconListeners.delete(key);
          };
        },
        onPick({ candidate }) {
          if (candidate && candidate.noMatch) return void 0; // 占位条目：不插入
          // 结构引用：输入框显示为带背景色的 chip（「技能 · 名称」），
          // 发送时由 codec.serialize 展开为 `/skill-name` 用户显式调用手势
          // （服务端 SKILL_GESTURE 识别，等价于直接输入 /skill-name）
          return {
            insert: {
              source: "skill",
              ref: candidate.name,
              label: "技能 · " + candidate.name,
              clipboardText: "/" + candidate.name,
            },
          };
        },
        codec: {
          clipboardText: (ref) => "/" + ref,
          serialize: (ref) => Promise.resolve("/" + ref),
        },
      };
      const inputTriggers = ctx.get("inputTriggers");
      // @ 两级菜单：路由源（选择分类）+ 技能源 + 工作区文件源
      ctx.effect(() => {
        const offs = [
          inputTriggers.registerSource(routerSource),
          inputTriggers.registerSource(source),
          inputTriggers.registerSource(fileSource),
        ];
        return () => {
          for (const off of offs) off();
          clearAll();
        };
      }, "skill-manager: @ sources");

      ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
        name: "sidebar.footer.action",
        id: "skill-manager",
        order: 20,
        label: () => "Skill 管理",
        inject: () => ({
          onCatalogChanged: clearAll,
          fetchSessionSkills: fetchCatalog,
          currentSessionId,
        }),
      }, SkillManagerEntry));

      ctx.on("connection/reset", () => {
        clearAll();
        stages.clear();
        pendingCat.clear();
      });
      if (ctx.remote && ctx.remote.$on) {
        ctx.remote.$on("agent-preset/selected", clearAll);
      }
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
