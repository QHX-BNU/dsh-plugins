// dsh-agent-factory 客户端插件（浏览器 bundle，__ModuleLoader__ 格式）
// 侧边栏底部注册「Agent 工厂」入口（与"定时任务/插件市场/设置"同级）：
//  - 我的 Agent：浏览模板卡片（新建/编辑/复制/删除/试运行）
//  - 新建 Agent：表单编辑器（名称/描述/系统提示/模型供应商/模型/token 上限/
//    继承上下文/工具限制）
// 试运行 = 以当前会话为父级，真正委派一个 DSH 子智能体执行任务，
// 前台运行直接展示结果，后台运行提交到任务面板（jobId）。
// 注意：React 19 的 jsx(type, props) 中 children 必须放进 props 对象。
window.__ModuleLoader__.load({
  id: "dsh-agent-factory",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var react_jsx_runtime = require("react/jsx-runtime");
    var react = require("react");
    var primitives = require("@deepseek-ai/dsh-client-ui-primitives");
    const { jsx, jsxs, Fragment } = react_jsx_runtime;
    const { useState, useEffect, useRef, useCallback } = react;
    const {
      IconUserOutline16,
      IconCloseOutline16,
      IconSearchOutline16,
      IconPlusOutline16,
      IconPlayOutline16,
      IconEditOutline16,
      IconCopyOutline16,
      IconTrashOutline16,
      IconLoadingOutline16,
    } = primitives;

    const css = `
[class*="_footerActions"]{flex-direction:column !important;align-items:stretch}
.dsh-af-trigger{box-sizing:border-box;cursor:pointer;width:calc(100% + 4px);height:42px;color:var(--dsw-alias-label-primary);background:transparent;border:none;border-radius:12px;flex:none;align-items:center;gap:8px;margin:4px -2px;padding:0 10px 0 8px;font-family:inherit;font-size:14px;line-height:22px;display:flex;overflow:hidden}
.dsh-af-trigger:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-af-trigger[data-rail=true]{border-radius:50%;justify-content:center;gap:0;width:36px;height:36px;margin:8px 0 10px;padding:0}
.dsh-af-trigger-label{white-space:nowrap;overflow:hidden}
.dsh-af-overlay{z-index:1000;justify-content:center;align-items:center;display:flex;position:fixed;inset:0}
.dsh-af-mask{background:var(--dsw-alias-bg-mask-1);backdrop-filter:var(--dsw-mask-blur);position:absolute;inset:0}
.dsh-af-panel{z-index:1;background:var(--dsw-alias-bg-layer-2);width:980px;max-width:calc(100vw - 48px);height:min(860px,100vh - 48px);box-shadow:var(--dsw-shadow-lv3);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);border-radius:24px;display:flex;flex-direction:column;position:relative;overflow:hidden}
.dsh-af-panel-head{box-sizing:border-box;flex:none;justify-content:space-between;align-items:center;gap:8px;height:54px;padding:20px 14px 8px 18px;display:flex}
.dsh-af-panel-title{color:var(--dsw-alias-label-primary);font-size:16px;font-weight:500;line-height:24px}
.dsh-af-panel-close{cursor:pointer;width:28px;height:28px;color:var(--dsw-alias-label-primary);background:transparent;border:none;border-radius:28px;justify-content:center;align-items:center;padding:0;display:inline-flex}
.dsh-af-panel-close:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-af-panel-body{flex:1;min-height:0;padding:4px 24px 24px;overflow-y:auto}
.dsh-af{display:flex;flex-direction:column;gap:14px;padding:4px 0 24px;min-width:0}
.dsh-af *{box-sizing:border-box}
.dsh-af-tabs{display:flex;gap:6px;flex:none;padding:2px;background:var(--dsw-alias-bg-module-platform);border-radius:10px;width:fit-content}
.dsh-af-tab{border:none;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:20px;padding:5px 14px;border-radius:8px;cursor:pointer}
.dsh-af-tab-on{background:var(--dsw-static-neutral-bluish-1000,#1d2b4f);color:#ffffff}
.dsh-af-head{display:flex;flex-direction:column;gap:4px}
.dsh-af-title{font-size:16px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dsh-af-sub{font-size:12px;color:var(--dsw-alias-label-tertiary);line-height:1.6}
.dsh-af-toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.dsh-af-search{flex:1;min-width:180px;position:relative;display:flex;align-items:center}
.dsh-af-search-icon{position:absolute;left:10px;color:var(--dsw-alias-label-tertiary);display:inline-flex;pointer-events:none}
.dsh-af-search input{width:100%;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);height:32px;font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 10px 0 32px;outline:none}
.dsh-af-search input:focus-visible{border-color:var(--dsw-alias-brand-primary)}
.dsh-af-stats{display:flex;flex-wrap:wrap;gap:8px}
.dsh-af-chip{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:2px 10px;font-size:12px;line-height:18px;white-space:nowrap}
.dsh-af-chip-on{border:1px solid var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary);background:transparent}
.dsh-af-chip-fork{border:1px solid var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary);background:transparent}
.dsh-af-chip-err{border:1px solid var(--dsw-alias-label-error);color:var(--dsw-alias-label-error);background:transparent}
.dsh-af-btn{font:inherit;font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;height:30px;padding:0 12px;cursor:pointer;white-space:nowrap}
.dsh-af-btn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary)}
.dsh-af-btn:disabled{opacity:.5;cursor:default}
.dsh-af-btn-primary{background:var(--dsw-static-neutral-bluish-1000,#1d2b4f);border-color:var(--dsw-static-neutral-bluish-1000,#1d2b4f);color:#ffffff}
.dsh-af-btn-danger{color:var(--dsw-alias-label-error);border-color:var(--dsw-alias-label-error)}
.dsh-af-error{color:var(--dsw-alias-label-error);font-size:12px;border:1px solid var(--dsw-alias-label-error);border-radius:8px;padding:8px 12px;word-break:break-word}
.dsh-af-info{color:var(--dsw-alias-state-success-primary);font-size:12px;border:1px solid var(--dsw-alias-state-success-primary);border-radius:8px;padding:8px 12px;word-break:break-word}
.dsh-af-list{display:flex;flex-direction:column;gap:10px}
.dsh-af-card{background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:8px;min-width:0}
.dsh-af-card-head{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.dsh-af-name{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-af-desc{font-size:13px;line-height:1.6;color:var(--dsw-alias-label-secondary);word-break:break-word;min-width:0}
.dsh-af-meta{font-size:11px;color:var(--dsw-alias-label-tertiary);word-break:break-word}
.dsh-af-foot{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap}
.dsh-af-actions{display:flex;gap:6px;flex-wrap:wrap}
.dsh-af-empty{color:var(--dsw-alias-label-tertiary);font-size:13px;text-align:center;padding:24px 0}
.dsh-af-hint{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dsh-af-persona{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-module-platform);border-radius:8px;padding:8px 10px;max-height:120px;overflow-y:auto;white-space:pre-wrap;word-break:break-word}
.dsh-af-form{display:flex;flex-direction:column;gap:10px;background:var(--dsw-alias-bg-module-platform);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:14px}
.dsh-af-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.dsh-af-field{display:flex;flex-direction:column;gap:4px;flex:1;min-width:200px}
.dsh-af-field label{font-size:12px;color:var(--dsw-alias-label-secondary)}
.dsh-af-field input,.dsh-af-field textarea,.dsh-af-field select{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);height:32px;font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 10px;outline:none;width:100%}
.dsh-af-field textarea{height:auto;padding:8px 10px;line-height:1.5;resize:vertical;font-family:inherit}
.dsh-af-field textarea.dsh-af-mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px}
.dsh-af-field input:focus-visible,.dsh-af-field textarea:focus-visible{border-color:var(--dsw-alias-brand-primary)}
.dsh-af-check{display:flex;gap:6px;align-items:center;cursor:pointer;font-size:13px;color:var(--dsw-alias-label-primary)}
.dsh-af-check input{width:auto;height:auto}
.dsh-af-run-task{min-height:120px}
.dsh-af-run-result{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;line-height:1.55;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-module-platform);border-radius:8px;padding:10px 12px;max-height:280px;overflow-y:auto;white-space:pre-wrap;word-break:break-word}
.dsh-af-loading{color:var(--dsw-alias-label-tertiary);font-size:13px;text-align:center;padding:20px 0;display:flex;gap:8px;justify-content:center;align-items:center}
`;

    function ensureCss() {
      const tagId = "dsh-agent-factory/section.css";
      if (typeof document !== "undefined" && document.querySelector('style[data-plugin-css="' + tagId + '"]') === null) {
        const tag = document.createElement("style");
        tag.dataset.plugin = "dsh-agent-factory";
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
        throw new Error("无法连接 Agent 工厂服务：" + (err && err.message ? err.message : String(err)));
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
      try {
        return new Date(ts).toLocaleString();
      } catch {
        return "—";
      }
    }

    function truncate(s, n) {
      if (!s) return "";
      return s.length > n ? s.slice(0, n) + "…" : s;
    }

    /** 模板卡片 */
    function AgentCard(props) {
      const { agent, busy, confirmDelete, onEdit, onRun, onClone, onDelete } = props;
      const route = (agent.provider || agent.model || agent.maxTokens)
        ? [agent.provider || "继承", agent.model || "继承", agent.maxTokens ? "max " + agent.maxTokens : ""].filter(Boolean).join(" · ")
        : "模型路由：继承调用方";
      return jsxs("div", { className: "dsh-af-card", children: [
        jsxs("div", { className: "dsh-af-card-head", children: [
          jsx("span", { className: "dsh-af-name", children: agent.name }),
          jsx("span", { className: "dsh-af-chip", children: agent.id }),
          agent.inheritContext
            ? jsx("span", { className: "dsh-af-chip dsh-af-chip-fork", children: "继承上下文" })
            : jsx("span", { className: "dsh-af-chip", children: "全新上下文" }),
          agent.usageCount > 0
            ? jsx("span", { className: "dsh-af-chip dsh-af-chip-on", children: "已用 " + agent.usageCount + " 次" })
            : null,
        ] }),
        jsx("div", { className: "dsh-af-desc", children: agent.description || "（无描述）" }),
        agent.persona
          ? jsx("div", { className: "dsh-af-persona", children: truncate(agent.persona, 300) })
          : null,
        jsxs("div", { className: "dsh-af-meta", children: [
          jsx("span", { children: route }),
          jsx("span", { children: " · 更新于 " + fmtTime(agent.updatedAt) }),
          agent.lastUsedAt ? jsx("span", { children: " · 最近运行 " + fmtTime(agent.lastUsedAt) }) : null,
        ] }),
        jsxs("div", { className: "dsh-af-foot", children: [
          jsx("span", { className: "dsh-af-hint", children: "对话中让 Agent 用 agent_run 调用它，或在面板中试运行" }),
          confirmDelete
            ? jsxs("span", { className: "dsh-af-actions", children: [
                jsx("span", { className: "dsh-af-meta", children: "确认删除？" }),
                jsx("button", { className: "dsh-af-btn dsh-af-btn-danger", disabled: busy, onClick: onDelete, children: "确认删除" }),
                jsx("button", { className: "dsh-af-btn", disabled: busy, onClick: onClone, children: "取消" }),
              ] })
            : jsxs("span", { className: "dsh-af-actions", children: [
                jsx("button", { className: "dsh-af-btn dsh-af-btn-primary", disabled: busy, onClick: onRun, children: jsxs(Fragment, { children: [jsx(IconPlayOutline16, { size: 13 }), " 运行"] }) }),
                jsx("button", { className: "dsh-af-btn", disabled: busy, onClick: onEdit, children: jsxs(Fragment, { children: [jsx(IconEditOutline16, { size: 13 }), " 编辑"] }) }),
                jsx("button", { className: "dsh-af-btn", disabled: busy, onClick: onClone, children: jsxs(Fragment, { children: [jsx(IconCopyOutline16, { size: 13 }), " 复制"] }) }),
                jsx("button", { className: "dsh-af-btn dsh-af-btn-danger", disabled: busy, onClick: onDelete, children: jsxs(Fragment, { children: [jsx(IconTrashOutline16, { size: 13 }), " 删除"] }) }),
              ] }),
        ] }),
      ] });
    }

    /** 新建/编辑表单 */
    function AgentEditor(props) {
      const { initial, providers, busy, onSave, onCancel } = props;
      const [id, setId] = useState(initial ? initial.id : "");
      const [name, setName] = useState(initial ? initial.name : "");
      const [description, setDescription] = useState(initial ? initial.description : "");
      const [persona, setPersona] = useState(initial ? initial.persona : "");
      const [provider, setProvider] = useState(initial ? initial.provider : "");
      const [model, setModel] = useState(initial ? initial.model : "");
      const [maxTokens, setMaxTokens] = useState(initial && initial.maxTokens ? String(initial.maxTokens) : "");
      const [maxDepth, setMaxDepth] = useState(initial && initial.maxDepth ? String(initial.maxDepth) : "");
      const [inheritContext, setInheritContext] = useState(initial ? !!initial.inheritContext : false);
      const [allowText, setAllowText] = useState(initial && initial.toolFilter && initial.toolFilter.allow ? initial.toolFilter.allow.join(", ") : "");
      const [denyText, setDenyText] = useState(initial && initial.toolFilter && initial.toolFilter.deny ? initial.toolFilter.deny.join(", ") : "");
      const [models, setModels] = useState([]);
      const [error, setError] = useState("");
      const fetchModelsTimer = useRef(null);

      const loadModels = useCallback((prov) => {
        const p = (prov || "").trim();
        if (fetchModelsTimer.current) clearTimeout(fetchModelsTimer.current);
        fetchModelsTimer.current = setTimeout(async () => {
          if (!p) {
            setModels([]);
            return;
          }
          try {
            const data = await apiFetch("/agent-factory/api/models?provider=" + encodeURIComponent(p));
            setModels(Array.isArray(data.models) ? data.models : []);
          } catch {
            setModels([]);
          }
        }, 400);
      }, []);

      useEffect(() => {
        if (initial && initial.provider) loadModels(initial.provider);
        return () => { if (fetchModelsTimer.current) clearTimeout(fetchModelsTimer.current); };
      }, [initial, loadModels]);

      const splitList = (text) => text.split(/[,，\n]/).map((s) => s.trim()).filter(Boolean);

      const submit = async () => {
        setError("");
        const trimmedName = name.trim();
        if (!trimmedName) {
          setError("请填写模板名称");
          return;
        }
        try {
          await onSave({
            id: id.trim(),
            name: trimmedName,
            description: description.trim(),
            persona,
            provider: provider.trim(),
            model: model.trim(),
            maxTokens: parseInt(maxTokens, 10) || 0,
            maxDepth: parseInt(maxDepth, 10) || 0,
            inheritContext,
            toolFilter: { allow: splitList(allowText), deny: splitList(denyText) },
          });
        } catch (err) {
          setError(err && err.message ? err.message : String(err));
        }
      };

      return jsxs("div", { className: "dsh-af-form", children: [
        jsxs("div", { className: "dsh-af-row", children: [
          jsxs("div", { className: "dsh-af-field", children: [
            jsx("label", { children: "模板 id（小写字母/数字/中划线；修改后保存会新建模板）" }),
            jsx("input", {
              value: id,
              onChange: (e) => setId(e.target.value),
              placeholder: initial ? initial.id : "留空自动从名称派生（如 code-reviewer）",
              disabled: !!initial,
            }),
          ] }),
          jsxs("div", { className: "dsh-af-field", children: [
            jsx("label", { children: "名称 *（对话中可用名称调用）" }),
            jsx("input", { value: name, onChange: (e) => setName(e.target.value), placeholder: "如：代码评审员" }),
          ] }),
        ] }),
        jsxs("div", { className: "dsh-af-field", children: [
          jsx("label", { children: "职责描述（一行，展示给模型与面板）" }),
          jsx("input", { value: description, onChange: (e) => setDescription(e.target.value), placeholder: "如：审查代码质量、发现 bug 与安全隐患" }),
        ] }),
        jsxs("div", { className: "dsh-af-field", children: [
          jsx("label", { children: "系统提示（persona）：子智能体的角色设定 / 行为规范 / 输出要求" }),
          jsx("textarea", { className: "dsh-af-mono", rows: 6, value: persona, onChange: (e) => setPersona(e.target.value), placeholder: "你是一位资深的代码评审专家……" }),
        ] }),
        jsxs("div", { className: "dsh-af-row", children: [
          jsxs("div", { className: "dsh-af-field", children: [
            jsx("label", { children: "模型供应商（留空继承调用方）" }),
            jsx("input", {
              value: provider,
              onChange: (e) => { setProvider(e.target.value); loadModels(e.target.value); },
              onBlur: () => loadModels(provider),
              list: "dsh-af-providers",
              placeholder: "如 deepseek / aliyun / openai / anthropic",
            }),
            jsx("datalist", { id: "dsh-af-providers", children: (providers || []).map((p) => jsx("option", { key: p.id, value: p.id }, "opt-" + p.id)) }),
          ] }),
          jsxs("div", { className: "dsh-af-field", children: [
            jsx("label", { children: "模型名（留空继承调用方）" }),
            jsx("input", {
              value: model,
              onChange: (e) => setModel(e.target.value),
              list: "dsh-af-models",
              placeholder: models.length ? "可选：" + models.slice(0, 6).map((m) => m.id).join("、") : "如 deepseek-chat",
            }),
            jsx("datalist", { id: "dsh-af-models", children: models.map((m) => jsx("option", { key: m.id, value: m.id }, "mdl-" + m.id)) }),
          ] }),
        ] }),
        jsxs("div", { className: "dsh-af-row", children: [
          jsxs("div", { className: "dsh-af-field", children: [
            jsx("label", { children: "maxTokens（输出上限，0 继承）" }),
            jsx("input", { value: maxTokens, onChange: (e) => setMaxTokens(e.target.value), placeholder: "如 8192" }),
          ] }),
          jsxs("div", { className: "dsh-af-field", children: [
            jsx("label", { children: "递归委派深度（0 不限制）" }),
            jsx("input", { value: maxDepth, onChange: (e) => setMaxDepth(e.target.value), placeholder: "如 1" }),
          ] }),
          jsxs("div", { className: "dsh-af-field", children: [
            jsx("label", { children: "运行方式" }),
            jsxs("label", { className: "dsh-af-check", children: [
              jsx("input", { type: "checkbox", checked: inheritContext, onChange: (e) => setInheritContext(e.target.checked) }),
              jsx("span", { children: "继承父对话上下文（fork）" }),
            ] }),
          ] }),
        ] }),
        jsxs("div", { className: "dsh-af-row", children: [
          jsxs("div", { className: "dsh-af-field", children: [
            jsx("label", { children: "工具白名单 allow（逗号分隔，留空不限制）" }),
            jsx("input", { value: allowText, onChange: (e) => setAllowText(e.target.value), placeholder: "如 read, grep, glob" }),
          ] }),
          jsxs("div", { className: "dsh-af-field", children: [
            jsx("label", { children: "工具黑名单 deny（逗号分隔）" }),
            jsx("input", { value: denyText, onChange: (e) => setDenyText(e.target.value), placeholder: "如 pwsh, bash" }),
          ] }),
        ] }),
        error ? jsx("div", { className: "dsh-af-error", children: error }) : null,
        jsxs("div", { className: "dsh-af-actions", children: [
          jsx("button", { className: "dsh-af-btn dsh-af-btn-primary", disabled: busy, onClick: submit, children: busy ? "保存中…" : "保存" }),
          jsx("button", { className: "dsh-af-btn", disabled: busy, onClick: onCancel, children: "返回列表" }),
        ] }),
      ] });
    }

    /** 试运行对话框 */
    function RunDialog(props) {
      const { agent, currentSessionId, onClose, onDone } = props;
      const [task, setTask] = useState("");
      const [background, setBackground] = useState(false);
      const [running, setRunning] = useState(false);
      const [error, setError] = useState("");
      const [result, setResult] = useState(null);
      const [jobNotice, setJobNotice] = useState("");

      const run = async () => {
        setError("");
        setResult(null);
        setJobNotice("");
        if (!task.trim()) {
          setError("请填写任务内容");
          return;
        }
        setRunning(true);
        try {
          const data = await apiFetch("/agent-factory/api/run", {
            method: "POST",
            body: {
              id: agent.id,
              task: task.trim(),
              sessionId: currentSessionId ? currentSessionId() : null,
              background,
            },
          });
          if (data.kind === "background") {
            setJobNotice("已提交后台任务 " + data.jobId + "（在任务面板中查看进度与结果）");
          } else {
            setResult(data);
          }
          if (onDone) onDone();
        } catch (err) {
          setError(err && err.message ? err.message : String(err));
        } finally {
          setRunning(false);
        }
      };

      return jsxs("div", { className: "dsh-af-form", children: [
        jsx("div", { className: "dsh-af-hint", children: "运行「" + agent.name + "」（" + agent.id + "）：以当前会话为父级，委派一个" + (agent.inheritContext ? "继承对话上下文的" : "全新上下文的") + "子智能体执行下面的任务。" }),
        jsxs("div", { className: "dsh-af-field", children: [
          jsx("label", { children: "任务内容 *（子智能体看不到当前对话，任务需自包含）" }),
          jsx("textarea", { className: "dsh-af-run-task", rows: 5, value: task, onChange: (e) => setTask(e.target.value), placeholder: "例如：审查 D:\\work\\project\\src 下的代码，找出潜在 bug 与安全隐患……" }),
        ] }),
        jsxs("label", { className: "dsh-af-check", children: [
          jsx("input", { type: "checkbox", checked: background, onChange: (e) => setBackground(e.target.checked) }),
          jsx("span", { children: "后台运行（立即返回，不等待结果）" }),
        ] }),
        error ? jsx("div", { className: "dsh-af-error", children: error }) : null,
        jobNotice ? jsx("div", { className: "dsh-af-info", children: jobNotice }) : null,
        running
          ? jsx("div", { className: "dsh-af-loading", children: [jsx(IconLoadingOutline16, { size: 14 }), "子智能体运行中（可等待或关闭面板中止）…"] })
          : null,
        result
          ? jsxs(Fragment, { children: [
              jsxs("div", { className: "dsh-af-row", children: [
                jsx("span", { className: "dsh-af-chip" + (result.stopReason === "completed" ? " dsh-af-chip-on" : " dsh-af-chip-err"), children: result.stopReasonText || result.stopReason }),
                jsx("span", { className: "dsh-af-hint", children: "该子智能体已作为当前会话的子智能体运行，可在子智能体列表中查看完整过程" }),
              ] }),
              jsx("div", { className: "dsh-af-run-result", children: result.outputText || "（无文本输出）" }),
            ] })
          : null,
        jsxs("div", { className: "dsh-af-actions", children: [
          jsx("button", { className: "dsh-af-btn dsh-af-btn-primary", disabled: running, onClick: run, children: running ? "运行中…" : "运行" }),
          jsx("button", { className: "dsh-af-btn", disabled: running, onClick: onClose, children: "关闭" }),
        ] }),
      ] });
    }

    /** 面板主体 */
    function FactorySection(props) {
      const [data, setData] = useState(null);
      const [tab, setTab] = useState("list");
      const [editing, setEditing] = useState(null);   // null=新建，object=编辑，'__closed__'=返回列表
      const [runTarget, setRunTarget] = useState(null);
      const [query, setQuery] = useState("");
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState("");
      const [notice, setNotice] = useState("");
      const [confirmId, setConfirmId] = useState(null);
      const mountedRef = useRef(true);
      useEffect(() => () => { mountedRef.current = false; }, []);

      const load = useCallback(async () => {
        try {
          const result = await apiFetch("/agent-factory/api/list");
          if (!mountedRef.current) return;
          setData(result);
          setError("");
        } catch (err) {
          if (mountedRef.current) setError(err && err.message ? err.message : String(err));
        }
      }, []);

      useEffect(() => {
        load();
      }, [load]);

      const runAction = async (kind, agent, extra) => {
        setBusy(true);
        setError("");
        setNotice("");
        try {
          let result;
          if (kind === "save") {
            result = await apiFetch("/agent-factory/api/save", { method: "POST", body: extra });
            setNotice("模板「" + result.agent.name + "」已" + (result.created ? "创建" : "更新"));
            setTab("list");
            setEditing(null);
          } else if (kind === "delete") {
            result = await apiFetch("/agent-factory/api/delete", { method: "POST", body: { id: agent.id } });
            setNotice("模板「" + result.id + "」已删除");
            setConfirmId(null);
          } else if (kind === "clone") {
            const clone = {
              ...agent,
              id: "",
              name: agent.name + " 副本",
            };
            delete clone.usageCount;
            delete clone.createdAt;
            delete clone.updatedAt;
            delete clone.lastUsedAt;
            result = await apiFetch("/agent-factory/api/save", { method: "POST", body: clone });
            setNotice("已复制为模板「" + result.agent.name + "」（" + result.agent.id + "）");
          }
          await load();
          return true;
        } catch (err) {
          setError(err && err.message ? err.message : String(err));
          return false;
        } finally {
          setBusy(false);
        }
      };

      const agents = data && Array.isArray(data.agents) ? data.agents : [];
      const providers = data && Array.isArray(data.providers) ? data.providers : [];
      const q = query.trim().toLowerCase();
      const visible = agents.filter((a) => {
        if (!q) return true;
        return a.name.toLowerCase().includes(q)
          || a.id.toLowerCase().includes(q)
          || (a.description || "").toLowerCase().includes(q)
          || (a.provider || "").toLowerCase().includes(q)
          || (a.model || "").toLowerCase().includes(q);
      });

      const showEditor = tab === "editor" || editing !== null;
      const editorInitial = editing && editing !== "__closed__" ? editing : null;

      return jsxs("div", { className: "dsh-af", children: [
        jsxs("div", { className: "dsh-af-head", children: [
          jsx("div", { className: "dsh-af-title", children: "Agent 工厂" }),
          jsx("div", { className: "dsh-af-sub", children: "可复用的 subagent 模板库：为子智能体设定系统提示、模型供应商与模型，随时编辑、随时调用。对话输入框输入 @ 选「Agent 模板」即可引用（如 @vision），主 Agent 会用 agent_run 调用它；也可以直接在这里试运行。" }),
        ] }),
        jsxs("div", { className: "dsh-af-tabs", children: [
          jsx("button", { className: "dsh-af-tab" + (!showEditor ? " dsh-af-tab-on" : ""), onClick: () => { setTab("list"); setEditing(null); }, children: "我的 Agent" }),
          jsx("button", { className: "dsh-af-tab" + (showEditor ? " dsh-af-tab-on" : ""), onClick: () => { setTab("editor"); setEditing(null); }, children: "新建 Agent" }),
        ] }),
        error ? jsx("div", { className: "dsh-af-error", children: error }) : null,
        notice ? jsx("div", { className: "dsh-af-info", children: notice }) : null,
        showEditor
          ? jsx(AgentEditor, {
              key: editorInitial ? "edit-" + editorInitial.id : "new",
              initial: editorInitial,
              providers: providers,
              busy: busy,
              onSave: (payload) => runAction("save", null, payload),
              onCancel: () => { setTab("list"); setEditing(null); },
            })
          : jsxs(Fragment, { children: [
              jsxs("div", { className: "dsh-af-toolbar", children: [
                jsxs("div", { className: "dsh-af-search", children: [
                  jsx("span", { className: "dsh-af-search-icon", children: jsx(IconSearchOutline16, { size: 14 }) }),
                  jsx("input", { value: query, onChange: (e) => setQuery(e.target.value), placeholder: "搜索模板（名称 / id / 描述 / 模型）…" }),
                ] }),
                jsx("button", {
                  className: "dsh-af-btn dsh-af-btn-primary",
                  disabled: busy,
                  onClick: () => { setTab("editor"); setEditing(null); },
                  children: jsxs(Fragment, { children: [jsx(IconPlusOutline16, { size: 13 }), " 新建"] }),
                }),
                jsxs("span", { className: "dsh-af-stats", children: [
                  jsx("span", { className: "dsh-af-chip", children: "共 " + agents.length + " 个模板" }),
                ] }),
              ] }),
              jsx("div", { className: "dsh-af-hint", children: "模板保存在 " + (data ? data.path : "") + "，改动即时生效。" }),
              jsx("div", {
                className: "dsh-af-list",
                children: visible.length === 0
                  ? jsx("div", { className: "dsh-af-empty", children: q ? "没有匹配的模板" : "还没有 Agent 模板，点「新建」创建第一个吧。" })
                  : visible.map((agent) => jsx(AgentCard, {
                      key: agent.id,
                      agent: agent,
                      busy: busy,
                      confirmDelete: confirmId === agent.id,
                      onEdit: () => { setTab("editor"); setEditing(agent); },
                      onRun: () => setRunTarget(agent),
                      onClone: () => {
                        if (confirmId === agent.id) setConfirmId(null);
                        runAction("clone", agent);
                      },
                      onDelete: () => {
                        if (confirmId === agent.id) {
                          runAction("delete", agent);
                          setConfirmId(null);
                        } else {
                          setConfirmId(agent.id);
                        }
                      },
                    })),
              }),
            ] }),
        runTarget
          ? jsxs("div", { className: "dsh-af-overlay", role: "dialog", "aria-label": "运行 Agent", children: [
              jsx("div", { className: "dsh-af-mask", onClick: () => setRunTarget(null) }),
              jsxs("div", { className: "dsh-af-panel", children: [
                jsxs("div", { className: "dsh-af-panel-head", children: [
                  jsx("span", { className: "dsh-af-panel-title", children: "运行「" + runTarget.name + "」" }),
                  jsx("button", { type: "button", className: "dsh-af-panel-close", "aria-label": "关闭", onClick: () => setRunTarget(null), children: jsx(IconCloseOutline16, { size: 14 }) }),
                ] }),
                jsx("div", { className: "dsh-af-panel-body", children: jsx(RunDialog, {
                  agent: runTarget,
                  currentSessionId: props.currentSessionId,
                  onDone: load,
                  onClose: () => setRunTarget(null),
                }) }),
              ] }),
            ] })
          : null,
      ] });
    }

    /** 侧边栏入口 + 独立面板 */
    function AgentFactoryEntry(props) {
      const { wide, currentSessionId } = props;
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
          className: "dsh-af-trigger",
          "data-rail": wide ? undefined : true,
          "aria-haspopup": "dialog",
          "aria-expanded": open,
          title: "Agent 工厂",
          onClick: () => setOpen(true),
          children: [
            jsx(IconUserOutline16, { size: wide ? 16 : 18 }),
            wide ? jsx("span", { className: "dsh-af-trigger-label", children: "Agent 工厂" }) : null,
          ],
        }),
        open
          ? jsxs("div", { className: "dsh-af-overlay", role: "dialog", "aria-label": "Agent 工厂", children: [
              jsx("div", { className: "dsh-af-mask", onClick: close }),
              jsxs("div", { className: "dsh-af-panel", children: [
                jsxs("div", { className: "dsh-af-panel-head", children: [
                  jsx("span", { className: "dsh-af-panel-title", children: "Agent 工厂" }),
                  jsx("button", {
                    type: "button",
                    className: "dsh-af-panel-close",
                    "aria-label": "关闭",
                    onClick: close,
                    children: jsx(IconCloseOutline16, { size: 14 }),
                  }),
                ] }),
                jsx("div", { className: "dsh-af-panel-body", children: jsx(FactorySection, { currentSessionId: currentSessionId }) }),
              ] }),
            ] })
          : null,
      ] });
    }

    const inject = ["slots", "sessions"];

    function apply(ctx) {
      ensureCss();
      const sessions = ctx.get("sessions");
      const currentSessionId = () => {
        try {
          const snap = sessions.list.getSnapshot();
          return snap && snap.current ? String(snap.current) : null;
        } catch {
          return null;
        }
      };
      ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
        name: "sidebar.footer.action",
        id: "dsh-agent-factory",
        order: 25,
        label: () => "Agent 工厂",
        inject: () => ({ currentSessionId }),
      }, AgentFactoryEntry));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
