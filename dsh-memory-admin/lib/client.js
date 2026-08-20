// dsh-memory-admin 客户端插件（浏览器 bundle，__ModuleLoader__ 格式）
// 在设置面板中注册"记忆管理"section：可视化查看/搜索/编辑/删除/新增记忆。
// 注意：React 19 的 jsx(type, props) 中 children 必须放进 props 对象
//（第三个位置参数是 key 而非 children）。
window.__ModuleLoader__.load({
  id: "dsh-memory-admin",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var react_jsx_runtime = require("react/jsx-runtime");
    var react = require("react");
    const { jsx, jsxs } = react_jsx_runtime;
    const { useState, useEffect, useRef, useCallback } = react;

    const CATEGORIES = ["anchor", "structure", "knowledge", "situation", "self"];
    const CATEGORY_LABELS = {
      anchor: "锚点层",
      structure: "结构层",
      knowledge: "知识层",
      situation: "情境层",
      self: "自我层",
    };

    const SCOPES = ["global", "workspace", "session"];
    const SCOPE_LABELS = {
      global: "全局",
      workspace: "工作区",
      session: "会话",
    };
    const SCOPE_HINTS = {
      global: "所有对话都会加载（适合用户偏好、长期事实）",
      workspace: "仅该工作区下的会话会加载",
      session: "仅该会话会加载（默认层级）",
    };

    function shortId(id) {
      if (!id) return "";
      const s = String(id);
      return s.length > 12 ? s.slice(0, 12) + "…" : s;
    }

    function scopeChipText(m) {
      if (m.scope === "workspace") return `工作区 · ${shortId(m.workspaceId) || "未绑定"}`;
      if (m.scope === "session") return m.sessionId ? `会话 · ${shortId(m.sessionId)}` : "会话 · 未绑定";
      return "全局";
    }

    const css = `
.dsh-mem-admin{display:flex;flex-direction:column;gap:14px;padding:4px 0 24px;min-width:0}
.dsh-mem-admin *{box-sizing:border-box}
.dsh-mem-head{display:flex;flex-direction:column;gap:4px}
.dsh-mem-title{font-size:16px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dsh-mem-sub{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dsh-mem-stats{display:flex;flex-wrap:wrap;gap:8px}
.dsh-mem-chip{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:2px 10px;font-size:12px;line-height:18px;white-space:nowrap}
.dsh-mem-chip-scope{border:1px solid var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary);background:transparent}
.dsh-mem-toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.dsh-mem-input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);height:34px;font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 12px;outline:none}
.dsh-mem-input:focus-visible{border-color:var(--dsw-alias-brand-primary)}
.dsh-mem-input-inline{height:30px;padding:0 8px;font-size:12px}
.dsh-mem-select{appearance:auto}
.dsh-mem-btn{font:inherit;font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;height:30px;padding:0 12px;cursor:pointer}
.dsh-mem-btn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary)}
.dsh-mem-btn:disabled{opacity:.5;cursor:default}
.dsh-mem-btn-primary{background:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}
.dsh-mem-btn-danger{color:var(--dsw-alias-label-error);border-color:var(--dsw-alias-label-error)}
.dsh-mem-error{color:var(--dsw-alias-label-error);font-size:12px;border:1px solid var(--dsw-alias-label-error);border-radius:8px;padding:8px 12px}
.dsh-mem-list{display:flex;flex-direction:column;gap:10px}
.dsh-mem-card{background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:8px;min-width:0}
.dsh-mem-card-head{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.dsh-mem-id{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dsh-mem-content{font-size:13px;line-height:1.6;color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word;min-width:0}
.dsh-mem-foot{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap}
.dsh-mem-meta{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dsh-mem-actions{display:flex;gap:6px}
.dsh-mem-form{display:flex;flex-direction:column;gap:8px}
.dsh-mem-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.dsh-mem-field{display:flex;flex-direction:column;gap:2px;flex:1;min-width:160px}
.dsh-mem-label{font-size:11px;color:var(--dsw-alias-label-secondary)}
.dsh-mem-textarea{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);border-radius:8px;padding:8px 10px;min-height:64px;resize:vertical;outline:none;width:100%}
.dsh-mem-textarea:focus-visible{border-color:var(--dsw-alias-brand-primary)}
.dsh-mem-empty{color:var(--dsw-alias-label-tertiary);font-size:13px;text-align:center;padding:24px 0}
.dsh-mem-grow{flex:1;min-width:120px}
`;

    function ensureCss() {
      const tagId = "dsh-memory-admin/memory-section.css";
      if (typeof document !== "undefined" && document.querySelector('style[data-plugin-css="' + tagId + '"]') === null) {
        const tag = document.createElement("style");
        tag.dataset.plugin = "dsh-memory-admin";
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
        throw new Error("无法连接记忆服务：" + (err && err.message ? err.message : String(err)));
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

    function fmtTime(ts) {
      if (!ts) return "—";
      const d = new Date(ts);
      return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0") + " " + String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
    }

    /** 记忆卡片：只读态 / 编辑态 */
    function MemoryCard(props) {
      const { memory, editing, draft, onStartEdit, onDraftChange, onSave, onCancelEdit, onAskDelete, confirmDelete, onConfirmDelete, onCancelDelete, busy } = props;
      if (editing) {
        return jsx("div", { className: "dsh-mem-card", children: jsxs("div", { className: "dsh-mem-form", children: [
          jsxs("div", { className: "dsh-mem-card-head", children: [
            jsx("span", { className: "dsh-mem-id", children: "编辑记忆 #" + memory.id }),
            jsx("span", { className: "dsh-mem-chip", children: CATEGORY_LABELS[memory.category] || memory.category }),
          ] }),
          jsx("textarea", {
            className: "dsh-mem-textarea",
            value: draft.content,
            onChange: (e) => onDraftChange({ ...draft, content: e.target.value }),
            placeholder: "记忆内容",
          }),
          jsxs("div", { className: "dsh-mem-row", children: [
            jsxs("div", { className: "dsh-mem-field", children: [
              jsx("span", { className: "dsh-mem-label", children: "分类（模块）" }),
              jsx("select", {
                className: "dsh-mem-input dsh-mem-input-inline dsh-mem-select",
                value: draft.category,
                onChange: (e) => onDraftChange({ ...draft, category: e.target.value }),
                children: CATEGORIES.map((c) => jsx("option", { key: c, value: c, children: CATEGORY_LABELS[c] })),
              }),
            ] }),
            jsxs("div", { className: "dsh-mem-field", children: [
              jsx("span", { className: "dsh-mem-label", children: "重要度（0~1）" }),
              jsx("input", {
                className: "dsh-mem-input dsh-mem-input-inline",
                type: "number",
                min: 0,
                max: 1,
                step: 0.1,
                value: draft.importance,
                onChange: (e) => onDraftChange({ ...draft, importance: e.target.value }),
              }),
            ] }),
            jsxs("div", { className: "dsh-mem-field", children: [
              jsx("span", { className: "dsh-mem-label", children: "标签（逗号分隔）" }),
              jsx("input", {
                className: "dsh-mem-input dsh-mem-input-inline",
                value: draft.tagsText,
                onChange: (e) => onDraftChange({ ...draft, tagsText: e.target.value }),
                placeholder: "如：项目, 偏好",
              }),
            ] }),
          ] }),
          jsxs("div", { className: "dsh-mem-row", children: [
            jsxs("div", { className: "dsh-mem-field", children: [
              jsx("span", { className: "dsh-mem-label", children: "作用域（哪些会话会加载）" }),
              jsx("select", {
                className: "dsh-mem-input dsh-mem-input-inline dsh-mem-select",
                value: draft.scope,
                onChange: (e) => onDraftChange({ ...draft, scope: e.target.value, scopeId: "" }),
                children: SCOPES.map((s) => jsx("option", { key: s, value: s, children: SCOPE_LABELS[s] })),
              }),
            ] }),
            draft.scope !== "global"
              ? jsxs("div", { className: "dsh-mem-field", children: [
                  jsx("span", { className: "dsh-mem-label", children: draft.scope === "workspace" ? "工作区 ID" : "会话 ID" }),
                  jsx("input", {
                    className: "dsh-mem-input dsh-mem-input-inline",
                    value: draft.scopeId,
                    list: draft.scope === "workspace" ? "dsh-mem-ws-list" : "dsh-mem-sess-list",
                    onChange: (e) => onDraftChange({ ...draft, scopeId: e.target.value }),
                    placeholder: draft.scope === "workspace" ? "工作区 id（必填，可下拉选择）" : "会话 id（留空 = 未绑定）",
                  }),
                ] })
              : null,
            jsx("span", { className: "dsh-mem-meta", children: SCOPE_HINTS[draft.scope] }),
          ] }),
          jsxs("div", { className: "dsh-mem-actions", children: [
            jsx("button", { className: "dsh-mem-btn dsh-mem-btn-primary", disabled: busy || !draft.content.trim() || (draft.scope === "workspace" && !draft.scopeId.trim()), onClick: onSave, children: busy ? "保存中…" : "保存" }),
            jsx("button", { className: "dsh-mem-btn", disabled: busy, onClick: onCancelEdit, children: "取消" }),
          ] }),
        ] }) });
      }
      return jsx("div", { className: "dsh-mem-card", children: [
        jsxs("div", { className: "dsh-mem-card-head", children: [
          jsx("span", { className: "dsh-mem-id", children: "#" + memory.id }),
          jsx("span", { className: "dsh-mem-chip dsh-mem-chip-scope", children: scopeChipText(memory) }),
          jsx("span", { className: "dsh-mem-chip", children: CATEGORY_LABELS[memory.category] || memory.category }),
          jsx("span", { className: "dsh-mem-chip", children: "重要度 " + memory.importance }),
          ...(memory.tags && memory.tags.length > 0 ? memory.tags.map((t) => jsx("span", { key: t, className: "dsh-mem-chip", children: t })) : []),
          jsx("span", { className: "dsh-mem-chip", children: "被加载 " + memory.accessCount + " 次" }),
        ] }),
        jsx("div", { className: "dsh-mem-content", children: memory.content }),
        jsxs("div", { className: "dsh-mem-foot", children: [
          jsx("span", { className: "dsh-mem-meta", children: "创建 " + fmtTime(memory.createdAt) + " · 更新 " + fmtTime(memory.updatedAt) }),
          confirmDelete
            ? jsxs("span", { className: "dsh-mem-actions", children: [
                jsx("span", { className: "dsh-mem-meta", children: "确认删除？" }),
                jsx("button", { className: "dsh-mem-btn dsh-mem-btn-danger", disabled: busy, onClick: onConfirmDelete, children: "确认删除" }),
                jsx("button", { className: "dsh-mem-btn", disabled: busy, onClick: onCancelDelete, children: "取消" }),
              ] })
            : jsxs("span", { className: "dsh-mem-actions", children: [
                jsx("button", { className: "dsh-mem-btn", onClick: onStartEdit, children: "编辑" }),
                jsx("button", { className: "dsh-mem-btn dsh-mem-btn-danger", onClick: onAskDelete, children: "删除" }),
              ] }),
        ] }),
      ] });
    }

    function MemorySection(props) {
      const [memories, setMemories] = useState([]);
      const [stats, setStats] = useState(null);
      const [category, setCategory] = useState("");
      const [scopeFilter, setScopeFilter] = useState("");
      const [keyword, setKeyword] = useState("");
      // 关键词输入防抖（250ms），避免每次击键都触发一次列表请求
      const [debouncedKeyword, setDebouncedKeyword] = useState("");
      useEffect(() => {
        const timer = setTimeout(() => setDebouncedKeyword(keyword), 250);
        return () => clearTimeout(timer);
      }, [keyword]);
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState("");
      const [editingId, setEditingId] = useState(null);
      const [draft, setDraft] = useState(null);
      const [showAdd, setShowAdd] = useState(false);
      const [newDraft, setNewDraft] = useState(null);
      const [confirmId, setConfirmId] = useState(null);
      const [reloadTick, setReloadTick] = useState(0);
      const mountedRef = useRef(true);
      useEffect(() => () => { mountedRef.current = false; }, []);

      // 宿主提供的工作区/会话列表（用于作用域选择下拉提示与默认归属）
      const { useSessions, useWorkspaces } = props;
      const hostSessions = useSessions ? useSessions((s) => s) : null;
      const hostWorkspaces = useWorkspaces ? useWorkspaces((s) => s) : null;
      const currentSessionId = hostSessions && hostSessions.current ? String(hostSessions.current) : "";
      const workspaceItems = hostWorkspaces && Array.isArray(hostWorkspaces.items) ? hostWorkspaces.items : [];
      const currentWorkspaceId = (() => {
        if (!currentSessionId) return "";
        const ws = workspaceItems.find(
          (w) => w && Array.isArray(w.sessionIds) && w.sessionIds.some((id) => String(id) === currentSessionId),
        );
        return ws ? String(ws.workspaceId ?? ws.id ?? "") : "";
      })();
      const workspaceOptions = workspaceItems.map((w) => ({
        id: String(w.workspaceId ?? w.id ?? ""),
        label: String(w.title ?? w.path ?? w.workspaceId ?? w.id ?? ""),
      })).filter((o) => o.id);
      const sessionOptions = Object.entries((hostSessions && hostSessions.byId) || {}).map(([id, s]) => ({
        id,
        label: String((s && (s.displayTitle ?? s.title)) || id),
      }));
      const scopeDefaultId = (scope) => (scope === "workspace" ? currentWorkspaceId : scope === "session" ? currentSessionId : "");

      const load = useCallback(async () => {
        setBusy(true);
        setError("");
        try {
          const params = new URLSearchParams();
          if (category) params.set("category", category);
          if (scopeFilter) params.set("scope", scopeFilter);
          if (debouncedKeyword.trim()) params.set("keyword", debouncedKeyword.trim());
          params.set("limit", "200");
          const qs = params.toString();
          const data = await apiFetch("/memory-admin/api/list" + (qs ? "?" + qs : ""));
          if (mountedRef.current) setMemories(data.memories || []);
        } catch (err) {
          if (mountedRef.current) setError(err.message);
        } finally {
          if (mountedRef.current) setBusy(false);
        }
      }, [category, debouncedKeyword, scopeFilter, reloadTick]);

      const loadStats = useCallback(async () => {
        try {
          const data = await apiFetch("/memory-admin/api/stats");
          if (mountedRef.current) setStats(data.stats || null);
        } catch {
          /* 统计失败不阻塞页面 */
        }
      }, [reloadTick]);

      useEffect(() => { load(); }, [load]);
      useEffect(() => { loadStats(); }, [loadStats]);

      const refresh = () => setReloadTick((n) => n + 1);

      const startEdit = (m) => {
        setEditingId(m.id);
        setConfirmId(null);
        setShowAdd(false);
        setDraft({
          content: m.content,
          category: m.category,
          importance: String(m.importance),
          tagsText: (m.tags || []).join(", "),
          scope: SCOPES.includes(m.scope) ? m.scope : "session",
          scopeId: m.scope === "workspace" ? (m.workspaceId || "") : m.scope === "session" ? (m.sessionId || "") : "",
        });
      };

      const cancelEdit = () => { setEditingId(null); setDraft(null); };

      const saveEdit = async () => {
        if (!draft || !draft.content.trim()) return;
        if (draft.scope === "workspace" && !draft.scopeId.trim()) return;
        setBusy(true);
        setError("");
        try {
          await apiFetch("/memory-admin/api/edit", {
            method: "POST",
            body: {
              id: editingId,
              content: draft.content.trim(),
              category: draft.category,
              importance: Number(draft.importance),
              tags: draft.tagsText.split(/[,，;；\s]+/).filter(Boolean),
              scope: draft.scope,
              workspaceId: draft.scope === "workspace" ? draft.scopeId.trim() : undefined,
              sessionId: draft.scope === "session" ? (draft.scopeId.trim() || undefined) : undefined,
            },
          });
          cancelEdit();
          refresh();
        } catch (err) {
          setError(err.message);
        } finally {
          setBusy(false);
        }
      };

      const startAdd = () => {
        setShowAdd(true);
        setEditingId(null);
        setConfirmId(null);
        setNewDraft({
          content: "",
          category: "knowledge",
          importance: "0.6",
          tagsText: "",
          scope: "session",
          scopeId: currentSessionId,
        });
      };

      const saveAdd = async () => {
        if (!newDraft || !newDraft.content.trim()) return;
        if (newDraft.scope === "workspace" && !newDraft.scopeId.trim()) return;
        setBusy(true);
        setError("");
        try {
          await apiFetch("/memory-admin/api/add", {
            method: "POST",
            body: {
              content: newDraft.content.trim(),
              category: newDraft.category,
              importance: Number(newDraft.importance),
              tags: newDraft.tagsText.split(/[,，;；\s]+/).filter(Boolean),
              scope: newDraft.scope,
              workspaceId: newDraft.scope === "workspace" ? newDraft.scopeId.trim() : undefined,
              sessionId: newDraft.scope === "session" ? (newDraft.scopeId.trim() || undefined) : undefined,
            },
          });
          setShowAdd(false);
          setNewDraft(null);
          refresh();
        } catch (err) {
          setError(err.message);
        } finally {
          setBusy(false);
        }
      };

      const doDelete = async (id) => {
        setBusy(true);
        setError("");
        try {
          await apiFetch("/memory-admin/api/delete", { method: "POST", body: { id } });
          setConfirmId(null);
          refresh();
        } catch (err) {
          setError(err.message);
        } finally {
          setBusy(false);
        }
      };

      const total = stats ? stats.total : memories.length;
      const catCounts = stats ? stats.byCategory : null;
      const scopeCounts = stats ? stats.byScope : null;

      return jsx("div", { className: "dsh-mem-admin", children: [
        jsxs("div", { className: "dsh-mem-head", children: [
          jsx("div", { className: "dsh-mem-title", children: "记忆管理" }),
          jsx("div", { className: "dsh-mem-sub", children: "三层作用域：全局（所有会话加载，适合用户偏好）· 工作区（仅该工作区下的会话）· 会话（仅当前会话，默认）。新记忆默认会话级；其他层级需显式指定。" }),
        ] }),
        jsx("div", { className: "dsh-mem-stats", children: [
          jsx("span", { className: "dsh-mem-chip", children: "共 " + total + " 条记忆" }),
          ...(scopeCounts ? SCOPES.map((s) => jsx("span", { key: "s-" + s, className: "dsh-mem-chip dsh-mem-chip-scope", children: SCOPE_LABELS[s] + " " + (scopeCounts[s] || 0) })) : []),
          ...(catCounts ? CATEGORIES.map((c) => jsx("span", { key: c, className: "dsh-mem-chip", children: (CATEGORY_LABELS[c] || c) + " " + (catCounts[c] || 0) })) : []),
        ] }),
        jsxs("div", { className: "dsh-mem-toolbar", children: [
          jsx("input", {
            className: "dsh-mem-input dsh-mem-grow",
            placeholder: "搜索记忆内容…",
            value: keyword,
            onChange: (e) => setKeyword(e.target.value),
          }),
          jsx("select", {
            className: "dsh-mem-input dsh-mem-select",
            value: scopeFilter,
            onChange: (e) => setScopeFilter(e.target.value),
            children: [
              jsx("option", { key: "", value: "", children: "全部作用域" }),
              ...SCOPES.map((s) => jsx("option", { key: s, value: s, children: SCOPE_LABELS[s] })),
            ],
          }),
          jsx("select", {
            className: "dsh-mem-input dsh-mem-select",
            value: category,
            onChange: (e) => setCategory(e.target.value),
            children: [
              jsx("option", { key: "", value: "", children: "全部分类" }),
              ...CATEGORIES.map((c) => jsx("option", { key: c, value: c, children: CATEGORY_LABELS[c] })),
            ],
          }),
          jsx("button", { className: "dsh-mem-btn", disabled: busy, onClick: refresh, children: "刷新" }),
          jsx("button", { className: "dsh-mem-btn dsh-mem-btn-primary", onClick: startAdd, children: "＋ 新增记忆" }),
        ] }),
        jsx("datalist", {
          id: "dsh-mem-ws-list",
          children: workspaceOptions.map((w) => jsx("option", { key: w.id, value: w.id, label: w.label })),
        }),
        jsx("datalist", {
          id: "dsh-mem-sess-list",
          children: sessionOptions.map((s) => jsx("option", { key: s.id, value: s.id, label: s.label })),
        }),
        error ? jsx("div", { className: "dsh-mem-error", children: error }) : null,
        showAdd
          ? jsx("div", { className: "dsh-mem-card", children: jsxs("div", { className: "dsh-mem-form", children: [
              jsxs("div", { className: "dsh-mem-card-head", children: [
                jsx("span", { className: "dsh-mem-chip", children: "新增记忆" }),
                jsx("span", { className: "dsh-mem-chip", children: "默认会话级；全局/工作区请手动选择" }),
              ] }),
              jsx("textarea", {
                className: "dsh-mem-textarea",
                placeholder: "记忆内容（要长期记住的事实/偏好/事件…）",
                value: newDraft ? newDraft.content : "",
                onChange: (e) => setNewDraft({ ...(newDraft || {}), content: e.target.value }),
              }),
              jsxs("div", { className: "dsh-mem-row", children: [
                jsxs("div", { className: "dsh-mem-field", children: [
                  jsx("span", { className: "dsh-mem-label", children: "分类（模块）" }),
                  jsx("select", {
                    className: "dsh-mem-input dsh-mem-input-inline dsh-mem-select",
                    value: newDraft ? newDraft.category : "knowledge",
                    onChange: (e) => setNewDraft({ ...(newDraft || {}), category: e.target.value }),
                    children: CATEGORIES.map((c) => jsx("option", { key: c, value: c, children: CATEGORY_LABELS[c] })),
                  }),
                ] }),
                jsxs("div", { className: "dsh-mem-field", children: [
                  jsx("span", { className: "dsh-mem-label", children: "重要度（0~1）" }),
                  jsx("input", {
                    className: "dsh-mem-input dsh-mem-input-inline",
                    type: "number",
                    min: 0,
                    max: 1,
                    step: 0.1,
                    value: newDraft ? newDraft.importance : "0.6",
                    onChange: (e) => setNewDraft({ ...(newDraft || {}), importance: e.target.value }),
                  }),
                ] }),
                jsxs("div", { className: "dsh-mem-field", children: [
                  jsx("span", { className: "dsh-mem-label", children: "标签（逗号分隔）" }),
                  jsx("input", {
                    className: "dsh-mem-input dsh-mem-input-inline",
                    placeholder: "如：项目, 偏好",
                    value: newDraft ? newDraft.tagsText : "",
                    onChange: (e) => setNewDraft({ ...(newDraft || {}), tagsText: e.target.value }),
                  }),
                ] }),
              ] }),
              jsxs("div", { className: "dsh-mem-row", children: [
                jsxs("div", { className: "dsh-mem-field", children: [
                  jsx("span", { className: "dsh-mem-label", children: "作用域（哪些会话会加载）" }),
                  jsx("select", {
                    className: "dsh-mem-input dsh-mem-input-inline dsh-mem-select",
                    value: newDraft ? newDraft.scope : "session",
                    onChange: (e) => setNewDraft({ ...(newDraft || {}), scope: e.target.value, scopeId: scopeDefaultId(e.target.value) }),
                    children: SCOPES.map((s) => jsx("option", { key: s, value: s, children: SCOPE_LABELS[s] })),
                  }),
                ] }),
                newDraft && newDraft.scope !== "global"
                  ? jsxs("div", { className: "dsh-mem-field", children: [
                      jsx("span", { className: "dsh-mem-label", children: newDraft.scope === "workspace" ? "工作区 ID" : "会话 ID" }),
                      jsx("input", {
                        className: "dsh-mem-input dsh-mem-input-inline",
                        list: newDraft.scope === "workspace" ? "dsh-mem-ws-list" : "dsh-mem-sess-list",
                        value: newDraft.scopeId,
                        onChange: (e) => setNewDraft({ ...newDraft, scopeId: e.target.value }),
                        placeholder: newDraft.scope === "workspace" ? "工作区 id（必填，可下拉选择）" : "会话 id（默认当前会话）",
                      }),
                    ] })
                  : null,
                jsx("span", { className: "dsh-mem-meta", children: SCOPE_HINTS[newDraft ? newDraft.scope : "session"] }),
              ] }),
              jsxs("div", { className: "dsh-mem-actions", children: [
                jsx("button", { className: "dsh-mem-btn dsh-mem-btn-primary", disabled: busy || !newDraft || !newDraft.content.trim() || (newDraft.scope === "workspace" && !newDraft.scopeId.trim()), onClick: saveAdd, children: busy ? "添加中…" : "添加" }),
                jsx("button", { className: "dsh-mem-btn", disabled: busy, onClick: () => { setShowAdd(false); setNewDraft(null); }, children: "取消" }),
              ] }),
            ] }) })
          : null,
        jsx("div", {
          className: "dsh-mem-list",
          children: memories.length === 0 && !busy
            ? jsx("div", { className: "dsh-mem-empty", children: "记忆库还是空的。点击「新增记忆」，或直接在对话里让 AI 用 memory_add 工具添加。" })
            : memories.map((m) => jsx(MemoryCard, {
                key: m.id,
                memory: m,
                editing: editingId === m.id,
                draft: editingId === m.id ? draft : null,
                onStartEdit: () => startEdit(m),
                onDraftChange: setDraft,
                onSave: saveEdit,
                onCancelEdit: cancelEdit,
                onAskDelete: () => { setConfirmId(m.id); setEditingId(null); },
                confirmDelete: confirmId === m.id,
                onConfirmDelete: () => doDelete(m.id),
                onCancelDelete: () => setConfirmId(null),
                busy,
              })),
        }),
      ] });
    }

    const inject = ["slots"];

    function apply(ctx) {
      ensureCss();
      ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section",
        id: "memory-admin",
        order: 30,
        label: () => "记忆管理",
        inject: () => ({}),
      }, MemorySection));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
