// dsh-tool-manager 客户端插件（浏览器 bundle，__ModuleLoader__ 格式）
// 侧边栏底部注册「工具管理」入口（与"Agent 工厂/定时任务/设置"同级）：
//  - 工具列表：显示全部已注册工具（名称/描述/参数/来源/状态），
//    系统工具可禁用/启用，自定义工具可编辑/试运行/删除/禁用；
//  - 新建/编辑工具：表单定义名称/描述/参数 schema/执行代码，
//    提供模板一键插入，保存后立即注册为主 Agent 可用工具；
//  - 试运行：填参数 JSON 直接执行工具代码，查看结果与日志。
// 注意：React 19 的 jsx(type, props) 中 children 必须放进 props 对象。
window.__ModuleLoader__.load({
  id: "dsh-tool-manager",
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
      IconSettingsOutline16,
      IconCloseOutline16,
      IconSearchOutline16,
      IconPlusOutline16,
      IconPlayOutline16,
      IconEditOutline16,
      IconTrashOutline16,
      IconLoadingOutline16,
      IconCheckOutline16,
      IconWarningOutline16,
      IconCodeOutline16,
    } = primitives;

    const css = `
[class*="_footerActions"]{flex-direction:column !important;align-items:stretch}
.dsh-tm-trigger{box-sizing:border-box;cursor:pointer;width:calc(100% + 4px);height:42px;color:var(--dsw-alias-label-primary);background:transparent;border:none;border-radius:12px;flex:none;align-items:center;gap:8px;margin:4px -2px;padding:0 10px 0 8px;font-family:inherit;font-size:14px;line-height:22px;display:flex;overflow:hidden}
.dsh-tm-trigger:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-tm-trigger[data-rail=true]{border-radius:50%;justify-content:center;gap:0;width:36px;height:36px;margin:8px 0 10px;padding:0}
.dsh-tm-trigger-label{white-space:nowrap;overflow:hidden}
.dsh-tm-overlay{z-index:1000;justify-content:center;align-items:center;display:flex;position:fixed;inset:0}
.dsh-tm-mask{background:var(--dsw-alias-bg-mask-1);backdrop-filter:var(--dsw-mask-blur);position:absolute;inset:0}
.dsh-tm-panel{z-index:1;background:var(--dsw-alias-bg-layer-2);width:1080px;max-width:calc(100vw - 48px);height:min(880px,100vh - 48px);box-shadow:var(--dsw-shadow-lv3);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);border-radius:24px;display:flex;flex-direction:column;position:relative;overflow:hidden}
.dsh-tm-panel-head{box-sizing:border-box;flex:none;justify-content:space-between;align-items:center;gap:8px;height:54px;padding:20px 14px 8px 18px;display:flex}
.dsh-tm-panel-title{color:var(--dsw-alias-label-primary);font-size:16px;font-weight:500;line-height:24px}
.dsh-tm-panel-close{cursor:pointer;width:28px;height:28px;color:var(--dsw-alias-label-primary);background:transparent;border:none;border-radius:28px;justify-content:center;align-items:center;padding:0;display:inline-flex}
.dsh-tm-panel-close:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-tm-panel-body{flex:1;min-height:0;padding:4px 24px 24px;overflow-y:auto}
.dsh-tm{display:flex;flex-direction:column;gap:14px;padding:4px 0 24px;min-width:0}
.dsh-tm *{box-sizing:border-box}
.dsh-tm-tabs{display:flex;gap:6px;flex:none;padding:2px;background:var(--dsw-alias-bg-module-platform);border-radius:10px;width:fit-content;flex-wrap:wrap}
.dsh-tm-tab{border:none;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:20px;padding:5px 14px;border-radius:8px;cursor:pointer}
.dsh-tm-tab-on{background:var(--dsw-static-neutral-bluish-1000,#1d2b4f);color:#ffffff}
.dsh-tm-head{display:flex;flex-direction:column;gap:4px}
.dsh-tm-title{font-size:16px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dsh-tm-sub{font-size:12px;color:var(--dsw-alias-label-tertiary);line-height:1.6}
.dsh-tm-toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.dsh-tm-search{flex:1;min-width:180px;position:relative;display:flex;align-items:center}
.dsh-tm-search-icon{position:absolute;left:10px;color:var(--dsw-alias-label-tertiary);display:inline-flex;pointer-events:none}
.dsh-tm-search input{width:100%;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);height:32px;font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 10px 0 32px;outline:none}
.dsh-tm-search input:focus-visible{border-color:var(--dsw-alias-brand-primary)}
.dsh-tm-stats{display:flex;flex-wrap:wrap;gap:8px}
.dsh-tm-chip{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:2px 10px;font-size:12px;line-height:18px;white-space:nowrap}
.dsh-tm-chip-on{border:1px solid var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary);background:transparent}
.dsh-tm-chip-off{border:1px solid var(--dsw-alias-label-error);color:var(--dsw-alias-label-error);background:transparent}
.dsh-tm-chip-custom{border:1px solid var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary);background:transparent}
.dsh-tm-btn{font:inherit;font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;height:30px;padding:0 12px;cursor:pointer;white-space:nowrap;display:inline-flex;align-items:center;gap:5px}
.dsh-tm-btn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary)}
.dsh-tm-btn:disabled{opacity:.5;cursor:default}
.dsh-tm-btn-primary{background:var(--dsw-static-neutral-bluish-1000,#1d2b4f);border-color:var(--dsw-static-neutral-bluish-1000,#1d2b4f);color:#ffffff}
.dsh-tm-btn-danger{color:var(--dsw-alias-label-error);border-color:var(--dsw-alias-label-error)}
.dsh-tm-btn-danger:hover:not(:disabled){border-color:var(--dsw-alias-label-error);background:var(--dsw-alias-label-error);color:#ffffff}
.dsh-tm-error{color:var(--dsw-alias-label-error);font-size:12px;border:1px solid var(--dsw-alias-label-error);border-radius:8px;padding:8px 12px;word-break:break-word}
.dsh-tm-info{color:var(--dsw-alias-state-success-primary);font-size:12px;border:1px solid var(--dsw-alias-state-success-primary);border-radius:8px;padding:8px 12px;word-break:break-word}
.dsh-tm-warn{color:var(--dsw-alias-label-warning);font-size:12px;border:1px solid var(--dsw-alias-label-warning);border-radius:8px;padding:8px 12px;word-break:break-word}
.dsh-tm-list{display:flex;flex-direction:column;gap:10px}
.dsh-tm-card{background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:8px;min-width:0}
.dsh-tm-card-off{opacity:.72}
.dsh-tm-card-head{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.dsh-tm-name{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
.dsh-tm-desc{font-size:13px;line-height:1.6;color:var(--dsw-alias-label-secondary);word-break:break-word;min-width:0}
.dsh-tm-meta{font-size:11px;color:var(--dsw-alias-label-tertiary);word-break:break-word}
.dsh-tm-foot{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap}
.dsh-tm-actions{display:flex;gap:6px;flex-wrap:wrap}
.dsh-tm-empty{color:var(--dsw-alias-label-tertiary);font-size:13px;text-align:center;padding:24px 0}
.dsh-tm-hint{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dsh-tm-form{display:flex;flex-direction:column;gap:10px;background:var(--dsw-alias-bg-module-platform);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:14px}
.dsh-tm-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.dsh-tm-field{display:flex;flex-direction:column;gap:4px;flex:1;min-width:200px}
.dsh-tm-field label{font-size:12px;color:var(--dsw-alias-label-secondary)}
.dsh-tm-field input,.dsh-tm-field textarea,.dsh-tm-field select{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);height:32px;font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 10px;outline:none;width:100%}
.dsh-tm-field textarea{height:auto;padding:8px 10px;line-height:1.5;resize:vertical;font-family:inherit}
.dsh-tm-field textarea.dsh-tm-mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;line-height:1.5}
.dsh-tm-field input:focus-visible,.dsh-tm-field textarea:focus-visible{border-color:var(--dsw-alias-brand-primary)}
.dsh-tm-check{display:flex;gap:6px;align-items:center;cursor:pointer;font-size:13px;color:var(--dsw-alias-label-primary)}
.dsh-tm-check input{width:auto;height:auto}
.dsh-tm-run-args{min-height:80px}
.dsh-tm-run-result{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;line-height:1.55;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-module-platform);border-radius:8px;padding:10px 12px;max-height:300px;overflow-y:auto;white-space:pre-wrap;word-break:break-word}
.dsh-tm-loading{color:var(--dsw-alias-label-tertiary);font-size:13px;text-align:center;padding:20px 0;display:flex;gap:8px;justify-content:center;align-items:center}
.dsh-tm-params-preview{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-module-platform);border-radius:6px;padding:6px 8px;max-height:90px;overflow-y:auto;white-space:pre-wrap;word-break:break-word}
.dsh-tm-param-list{display:flex;flex-direction:column;gap:3px;margin-top:2px}
.dsh-tm-param-row{display:flex;gap:6px;align-items:baseline;font-size:12px;line-height:1.6;flex-wrap:wrap;min-width:0}
.dsh-tm-param-name{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-weight:600;color:var(--dsw-alias-label-primary)}
.dsh-tm-param-type{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:10px;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-module-platform);border-radius:4px;padding:0 6px;line-height:16px;flex:none}
.dsh-tm-param-req{font-size:10px;color:var(--dsw-alias-label-error);border:1px solid var(--dsw-alias-label-error);border-radius:4px;padding:0 5px;line-height:16px;flex:none}
.dsh-tm-param-desc{color:var(--dsw-alias-label-secondary);min-width:0;flex:1;word-break:break-word}
.dsh-tm-param-none{font-size:12px;color:var(--dsw-alias-label-tertiary);font-style:italic}
.dsh-tm-detail{display:flex;flex-direction:column;gap:10px;border-top:1px solid var(--dsw-alias-border-l2);padding-top:10px;margin-top:2px}
.dsh-tm-section-label{font-size:11px;font-weight:600;color:var(--dsw-alias-label-tertiary);letter-spacing:.05em}
.dsh-tm-code-block{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11.5px;line-height:1.55;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-module-platform);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px 10px;max-height:200px;overflow:auto;white-space:pre-wrap;word-break:break-word}
.dsh-tm-detail-meta{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dsh-tm-chevron{display:inline-flex;transition:transform .15s ease}
.dsh-tm-chevron-open{transform:rotate(180deg)}
`;

    function ensureCss() {
      const tagId = "dsh-tool-manager/section.css";
      if (typeof document !== "undefined" && document.querySelector('style[data-plugin-css="' + tagId + '"]') === null) {
        const tag = document.createElement("style");
        tag.dataset.plugin = "dsh-tool-manager";
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
        throw new Error("无法连接工具管理服务：" + (err && err.message ? err.message : String(err)));
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

    /** 工具卡片：结构化展示 + 可展开详情（参数 schema / 执行代码 / 元数据） */
    function ToolCard(props) {
      const { tool, busy, confirmDelete, protectedNames, onEdit, onToggle, onTest, onDelete } = props;
      const [expanded, setExpanded] = useState(false);
      const isCustom = tool.source === "custom";
      const isProtected = protectedNames && protectedNames.includes(tool.name);
      const canDisable = !tool.scoped;
      const params = tool.parameters && typeof tool.parameters === "object" ? tool.parameters : {};
      const propsDef = params.properties && typeof params.properties === "object" ? params.properties : {};
      const req = Array.isArray(params.required) ? params.required : [];
      const paramNames = Object.keys(propsDef);
      return jsxs("div", { className: "dsh-tm-card" + (tool.disabled ? " dsh-tm-card-off" : ""), children: [
        jsxs("div", { className: "dsh-tm-card-head", children: [
          jsx("span", { className: "dsh-tm-name", children: tool.name }),
          isCustom
            ? jsx("span", { className: "dsh-tm-chip dsh-tm-chip-custom", children: "自定义" })
            : jsx("span", { className: "dsh-tm-chip", children: "系统" }),
          tool.scoped ? jsx("span", { className: "dsh-tm-chip", children: "局部" }) : null,
          tool.registered === false
            ? jsx("span", { className: "dsh-tm-chip dsh-tm-chip-off", children: "未注册" })
            : tool.disabled
              ? jsx("span", { className: "dsh-tm-chip dsh-tm-chip-off", children: "已禁用" })
              : jsx("span", { className: "dsh-tm-chip dsh-tm-chip-on", children: "已启用" }),
          isProtected ? jsx("span", { className: "dsh-tm-chip", children: "受保护" }) : null,
        ] }),
        tool.description ? jsx("div", { className: "dsh-tm-desc", children: tool.description }) : null,
        paramNames.length > 0
          ? jsxs("div", { className: "dsh-tm-param-list", children: paramNames.map((n) => {
              const d = propsDef[n] || {};
              return jsxs("div", { className: "dsh-tm-param-row", key: n, children: [
                jsx("span", { className: "dsh-tm-param-name", children: n }),
                d.type ? jsx("span", { className: "dsh-tm-param-type", children: d.type }) : null,
                req.includes(n) ? jsx("span", { className: "dsh-tm-param-req", children: "必填" }) : null,
                d.description ? jsx("span", { className: "dsh-tm-param-desc", children: d.description }) : null,
              ] });
            }) })
          : jsx("div", { className: "dsh-tm-param-none", children: "无参数" }),
        jsxs("div", { className: "dsh-tm-foot", children: [
          jsx("div", { className: "dsh-tm-hint", children: tool.scoped ? "Agent 局部注册的工具，无法全局禁用" : (isProtected ? "工具管理器自身的工具，不可禁用/删除" : "") }),
          jsxs("div", { className: "dsh-tm-actions", children: [
            jsx("button", {
              type: "button",
              className: "dsh-tm-btn" + (expanded ? " dsh-tm-btn-primary" : ""),
              disabled: busy,
              onClick: () => setExpanded(!expanded),
              children: jsxs(Fragment, { children: [
                jsx("span", { className: "dsh-tm-chevron" + (expanded ? " dsh-tm-chevron-open" : ""), children: "▾" }),
                expanded ? " 收起" : " 详情",
              ] }),
            }),
            isCustom && tool.registered !== false
              ? jsx("button", { type: "button", className: "dsh-tm-btn", disabled: busy, onClick: () => onTest(tool), children: jsxs(Fragment, { children: [jsx(IconPlayOutline16, { size: 12 }), " 试运行"] }) })
              : null,
            isCustom
              ? jsx("button", { type: "button", className: "dsh-tm-btn", disabled: busy, onClick: () => onEdit(tool), children: jsxs(Fragment, { children: [jsx(IconEditOutline16, { size: 12 }), " 编辑"] }) })
              : null,
            !isProtected && canDisable
              ? jsx("button", {
                  type: "button",
                  className: "dsh-tm-btn" + (tool.disabled ? " dsh-tm-btn-primary" : ""),
                  disabled: busy,
                  onClick: () => onToggle(tool),
                  children: tool.disabled ? "启用" : "禁用",
                })
              : null,
            isCustom
              ? jsx("button", {
                  type: "button",
                  className: "dsh-tm-btn dsh-tm-btn-danger",
                  disabled: busy,
                  onClick: () => {
                    if (confirmDelete === tool.customId) {
                      onDelete(tool);
                    } else {
                      // 触发父级确认
                      props.onAskDelete(tool);
                    }
                  },
                  children: confirmDelete === tool.customId ? "确认删除？" : "删除",
                })
              : null,
          ] }),
        ] }),
        expanded
          ? jsxs("div", { className: "dsh-tm-detail", children: [
              jsxs("div", { children: [
                jsx("div", { className: "dsh-tm-section-label", children: "参数定义（schema）" }),
                jsx("div", { className: "dsh-tm-code-block", children: JSON.stringify(params, null, 2) }),
              ] }),
              isCustom && tool.code
                ? jsxs("div", { children: [
                    jsx("div", { className: "dsh-tm-section-label", children: "执行代码" }),
                    jsx("div", { className: "dsh-tm-code-block", children: tool.code }),
                  ] })
                : null,
              jsxs("div", { className: "dsh-tm-detail-meta", children: [
                jsx("span", { children: "来源：" + (isCustom ? "自定义" : "系统") }),
                jsx("span", { children: "注册状态：" + (tool.registered === false ? "未注册" : "已注册") }),
                isCustom ? jsx("span", { children: "使用次数：" + (tool.usageCount || 0) }) : null,
                isCustom ? jsx("span", { children: "创建：" + fmtTime(tool.createdAt) }) : null,
                isCustom ? jsx("span", { children: "更新：" + fmtTime(tool.updatedAt) }) : null,
              ] }),
            ] })
          : null,
      ] });
    }

    /** 代码模板（插入编辑器）。 */
    const TEMPLATES = [
      {
        label: "计算/转换（处理参数并返回）",
        code: "// args 是调用方传入的参数对象\nconst a = Number(args.a || 0);\nconst b = Number(args.b || 0);\nreturn { sum: a + b, product: a * b };",
        params: {
          a: { type: "number", required: true, description: "第一个数" },
          b: { type: "number", required: true, description: "第二个数" },
        },
      },
      {
        label: "执行系统命令（PowerShell）",
        code: "const { execSync } = helpers.require('node:child_process');\nconst out = execSync(args.command, { encoding: 'utf8', timeout: 15000 });\nreturn { stdout: String(out).trim() };",
        params: {
          command: { type: "string", required: true, description: "要执行的 PowerShell 命令" },
        },
      },
      {
        label: "读取本地文件",
        code: "const { readFile } = helpers.require('node:fs/promises');\nconst content = await readFile(args.path, 'utf8');\nreturn { content };",
        params: {
          path: { type: "string", required: true, description: "文件绝对路径" },
        },
      },
      {
        label: "调用 HTTP API",
        code: "const res = await helpers.fetch(args.url);\nconst data = await res.json();\nreturn { status: res.status, data };",
        params: {
          url: { type: "string", required: true, description: "接口地址" },
        },
      },
    ];

    /** 工具编辑器（新建/编辑） */
    function ToolEditor(props) {
      const { initial, busy, onSave, onTest, onCancel } = props;
      const [name, setName] = useState(initial ? initial.name : "");
      const [description, setDescription] = useState(initial ? initial.description : "");
      const [paramsText, setParamsText] = useState(initial && initial.parameters
        ? JSON.stringify(initial.parameters, null, 2)
        : "");
      const [code, setCode] = useState(initial ? initial.code : "");
      const [enabled, setEnabled] = useState(initial ? initial.registered !== false : true);
      const [parseError, setParseError] = useState("");

      const parseParams = () => {
        const text = paramsText.trim();
        if (!text) return {};
        try {
          const parsed = JSON.parse(text);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("参数定义必须是 JSON 对象");
          }
          setParseError("");
          return parsed;
        } catch (err) {
          setParseError("参数 JSON 解析失败：" + (err && err.message ? err.message : String(err)));
          return undefined;
        }
      };

      const handleSave = () => {
        if (!name.trim()) { setParseError("请填写工具名称"); return; }
        if (!code.trim()) { setParseError("请填写执行代码"); return; }
        const parameters = parseParams();
        if (parameters === undefined) return;
        onSave({
          id: initial ? initial.customId : undefined,
          name: name.trim(),
          description: description.trim(),
          parameters,
          code,
          enabled,
        });
      };

      const handleTest = () => {
        if (!code.trim()) { setParseError("请填写执行代码"); return; }
        const parameters = parseParams();
        if (parameters === undefined) return;
        onTest({
          id: initial ? initial.customId : undefined,
          name: name.trim(),
          code,
          parameters,
        });
      };

      const applyTemplate = (tpl) => {
        setName((prev) => prev || tpl.label.split("（")[0].replace(/[^a-zA-Z0-9\u4e00-\u9fa5]+/g, "_").toLowerCase() || "custom_tool");
        setParamsText(JSON.stringify(tpl.params, null, 2));
        setCode(tpl.code);
        setParseError("");
      };

      return jsxs("div", { className: "dsh-tm-form", children: [
        jsxs("div", { className: "dsh-tm-row", children: [
          jsxs("div", { className: "dsh-tm-field", children: [
            jsx("label", { children: "工具名（小写字母/数字/下划线，以字母开头）" }),
            jsx("input", { value: name, onChange: (e) => setName(e.target.value), placeholder: "如 translate_text" }),
          ] }),
          jsxs("div", { className: "dsh-tm-field", children: [
            jsx("label", { children: "描述（展示给模型的一句话）" }),
            jsx("input", { value: description, onChange: (e) => setDescription(e.target.value), placeholder: "如：把中文文本翻译成英文" }),
          ] }),
        ] }),
        jsxs("div", { className: "dsh-tm-row", children: [
          jsxs("div", { className: "dsh-tm-field", children: [
            jsx("label", { children: "参数定义（DSH 值 schema JSON，可留空）" }),
            jsx("textarea", {
              className: "dsh-tm-mono",
              rows: 6,
              value: paramsText,
              onChange: (e) => setParamsText(e.target.value),
              placeholder: '{\n  "query": { "type": "string", "required": true, "description": "搜索关键词" }\n}',
            }),
            jsx("div", { className: "dsh-tm-hint", children: "格式：{ 参数名: { type: string/number/integer/boolean/array/object/json, required: true, description } }" }),
          ] }),
        ] }),
        jsxs("div", { className: "dsh-tm-field", children: [
          jsx("label", { children: "执行代码（async (args, helpers) => { ...; return value; } 的函数体）" }),
          jsxs("div", { className: "dsh-tm-row", children: [
            jsx("select", { value: "", onChange: (e) => { const t = TEMPLATES.find((x) => x.label === e.target.value); if (t) applyTemplate(t); }, children: [
              jsx("option", { value: "", children: "插入模板…" }),
              ...TEMPLATES.map((t) => jsx("option", { key: t.label, value: t.label, children: t.label })),
            ] }),
            jsx("span", { className: "dsh-tm-hint", children: "helpers：require / fetch / log / now / env" }),
          ] }),
          jsx("textarea", {
            className: "dsh-tm-mono",
            rows: 12,
            value: code,
            onChange: (e) => setCode(e.target.value),
            placeholder: "return { hello: args.name || 'world' };",
          }),
        ] }),
        jsxs("div", { className: "dsh-tm-row", children: [
          jsx("label", { className: "dsh-tm-check", children: jsxs(Fragment, { children: [
            jsx("input", { type: "checkbox", checked: enabled, onChange: (e) => setEnabled(e.target.checked) }),
            " 保存后立即注册（模型可调用）",
          ] }) }),
        ] }),
        parseError ? jsx("div", { className: "dsh-tm-error", children: parseError }) : null,
        jsxs("div", { className: "dsh-tm-row", children: [
          jsx("button", { type: "button", className: "dsh-tm-btn dsh-tm-btn-primary", disabled: busy, onClick: handleSave, children: "保存" }),
          jsx("button", { type: "button", className: "dsh-tm-btn", disabled: busy, onClick: handleTest, children: jsxs(Fragment, { children: [jsx(IconPlayOutline16, { size: 12 }), " 试运行"] }) }),
          jsx("button", { type: "button", className: "dsh-tm-btn", disabled: busy, onClick: onCancel, children: "返回列表" }),
        ] }),
      ] });
    }

    /** 根据参数 schema 生成示例参数 JSON。 */
    function buildArgsSample(parameters) {
      const p = parameters && typeof parameters === "object" ? parameters : {};
      const props = p.properties && typeof p.properties === "object" ? p.properties : {};
      const sample = {};
      for (const [name, def] of Object.entries(props)) {
        const t = def && def.type;
        if (t === "string") sample[name] = "";
        else if (t === "number" || t === "integer") sample[name] = 0;
        else if (t === "boolean") sample[name] = false;
        else if (t === "array") sample[name] = [];
        else if (t === "object") sample[name] = {};
        else sample[name] = "";
      }
      return sample;
    }

    /** 试运行对话框 */
    function TestDialog(props) {
      const { tool, defaultTimeoutMs, onClose } = props;
      const [argsText, setArgsText] = useState("{}");
      const [running, setRunning] = useState(false);
      const [result, setResult] = useState(null);
      const [error, setError] = useState("");

      const sample = buildArgsSample(tool.parameters);
      const hasSample = Object.keys(sample).length > 0;
      const paramProps = tool.parameters && tool.parameters.properties
        && typeof tool.parameters.properties === "object"
        ? tool.parameters.properties
        : {};
      const paramReq = Array.isArray(tool.parameters && tool.parameters.required)
        ? tool.parameters.required
        : [];

      const run = async () => {
        setError("");
        setResult(null);
        let args;
        try {
          const text = argsText.trim();
          args = text ? JSON.parse(text) : {};
          if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("参数必须是 JSON 对象");
        } catch (err) {
          setError("参数 JSON 解析失败：" + (err && err.message ? err.message : String(err)));
          return;
        }
        setRunning(true);
        try {
          const data = await apiFetch("/tool-manager/api/test", {
            method: "POST",
            body: {
              id: tool.customId || undefined,
              name: tool.name,
              code: tool.code,
              args,
              timeoutMs: defaultTimeoutMs,
            },
          });
          setResult(data);
        } catch (err) {
          setError(err && err.message ? err.message : String(err));
        } finally {
          setRunning(false);
        }
      };

      return jsxs("div", { className: "dsh-tm-overlay", role: "dialog", "aria-label": "试运行工具", children: [
        jsx("div", { className: "dsh-tm-mask", onClick: onClose }),
        jsxs("div", { className: "dsh-tm-panel", style: { width: "720px", height: "min(720px, 100vh - 48px)" }, children: [
          jsxs("div", { className: "dsh-tm-panel-head", children: [
            jsx("span", { className: "dsh-tm-panel-title", children: "试运行「" + tool.name + "」" }),
            jsx("button", { type: "button", className: "dsh-tm-panel-close", "aria-label": "关闭", onClick: onClose, children: jsx(IconCloseOutline16, { size: 14 }) }),
          ] }),
          jsx("div", { className: "dsh-tm-panel-body", children: jsxs("div", { className: "dsh-tm", children: [
            Object.keys(paramProps).length > 0
              ? jsxs("div", { children: [
                  jsx("div", { className: "dsh-tm-section-label", children: "参数说明" }),
                  jsxs("div", { className: "dsh-tm-param-list", children: Object.keys(paramProps).map((n) => {
                    const d = paramProps[n] || {};
                    return jsxs("div", { className: "dsh-tm-param-row", key: n, children: [
                      jsx("span", { className: "dsh-tm-param-name", children: n }),
                      d.type ? jsx("span", { className: "dsh-tm-param-type", children: d.type }) : null,
                      paramReq.includes(n) ? jsx("span", { className: "dsh-tm-param-req", children: "必填" }) : null,
                      d.description ? jsx("span", { className: "dsh-tm-param-desc", children: d.description }) : null,
                    ] });
                  }) }),
                ] })
              : null,
            jsxs("div", { className: "dsh-tm-field", children: [
              jsx("label", { children: "参数（JSON 对象）" }),
              jsx("textarea", {
                className: "dsh-tm-mono dsh-tm-run-args",
                value: argsText,
                onChange: (e) => setArgsText(e.target.value),
                placeholder: "{}",
              }),
            ] }),
            jsxs("div", { className: "dsh-tm-row", children: [
              jsx("button", { type: "button", className: "dsh-tm-btn dsh-tm-btn-primary", disabled: running, onClick: run, children: running ? "运行中…" : "运行" }),
              hasSample
                ? jsx("button", { type: "button", className: "dsh-tm-btn", disabled: running, onClick: () => setArgsText(JSON.stringify(sample, null, 2)), children: "填入示例参数" })
                : null,
            ] }),
            error ? jsx("div", { className: "dsh-tm-error", children: error }) : null,
            result
              ? jsxs(Fragment, { children: [
                  result.logs && result.logs.length > 0
                    ? jsxs("div", { className: "dsh-tm-field", children: [
                        jsx("label", { children: "日志" }),
                        jsx("div", { className: "dsh-tm-run-result", children: result.logs.join("\n") }),
                      ] })
                    : null,
                  jsxs("div", { className: "dsh-tm-field", children: [
                    jsx("label", { children: "返回值（耗时 " + result.elapsedMs + "ms）" }),
                    jsx("div", { className: "dsh-tm-run-result", children: result.resultText !== undefined ? result.resultText : JSON.stringify(result.result, null, 2) }),
                  ] }),
                ] })
              : null,
          ] }) }),
        ] }),
      ] });
    }

    /** 面板主体 */
    function ManagerSection() {
      const [data, setData] = useState(null);
      const [error, setError] = useState("");
      const [notice, setNotice] = useState("");
      const [busy, setBusy] = useState(false);
      const [query, setQuery] = useState("");
      const [filter, setFilter] = useState("all"); // all | custom | disabled
      const [editing, setEditing] = useState(null); // null | tool | "__new__"
      const [testTarget, setTestTarget] = useState(null);
      const [confirmId, setConfirmId] = useState(null);

      const load = useCallback(async () => {
        try {
          const d = await apiFetch("/tool-manager/api/list");
          setData(d);
          setError("");
        } catch (err) {
          setError(err && err.message ? err.message : String(err));
        }
      }, []);

      useEffect(() => { load(); }, [load]);

      const runAction = async (path, body) => {
        setBusy(true);
        setError("");
        setNotice("");
        try {
          await apiFetch(path, { method: "POST", body });
          setNotice("操作成功");
          await load();
        } catch (err) {
          setError(err && err.message ? err.message : String(err));
        } finally {
          setBusy(false);
        }
      };

      const tools = data && Array.isArray(data.tools) ? data.tools : [];
      const protectedNames = data && Array.isArray(data.protected) ? data.protected : [];
      const defaultTimeoutMs = data ? data.defaultTimeoutMs : 30000;
      const q = query.trim().toLowerCase();
      const visible = tools.filter((t) => {
        if (filter === "custom" && t.source !== "custom") return false;
        if (filter === "disabled" && !t.disabled) return false;
        if (!q) return true;
        return t.name.toLowerCase().includes(q)
          || (t.description || "").toLowerCase().includes(q)
          || t.source.toLowerCase().includes(q);
      });

      const showEditor = editing !== null;
      const editorInitial = editing && editing !== "__new__" ? editing : null;

      return jsxs("div", { className: "dsh-tm", children: [
        jsxs("div", { className: "dsh-tm-head", children: [
          jsx("div", { className: "dsh-tm-title", children: "工具管理" }),
          jsx("div", { className: "dsh-tm-sub", children: "查看 DSH 全部工具，制作自定义工具（定义参数与执行代码，保存后主 Agent 立即可用），随时禁用/启用/删除。禁用后模型不再看到该工具。" }),
        ] }),
        jsxs("div", { className: "dsh-tm-tabs", children: [
          jsx("button", { className: "dsh-tm-tab" + (filter === "all" ? " dsh-tm-tab-on" : ""), onClick: () => setFilter("all"), children: "全部" }),
          jsx("button", { className: "dsh-tm-tab" + (filter === "custom" ? " dsh-tm-tab-on" : ""), onClick: () => setFilter("custom"), children: "自定义" }),
          jsx("button", { className: "dsh-tm-tab" + (filter === "disabled" ? " dsh-tm-tab-on" : ""), onClick: () => setFilter("disabled"), children: "已禁用" }),
        ] }),
        error ? jsx("div", { className: "dsh-tm-error", children: error }) : null,
        notice ? jsx("div", { className: "dsh-tm-info", children: notice }) : null,
        showEditor
          ? jsx(ToolEditor, {
              key: editorInitial ? "edit-" + editorInitial.customId : "new",
              initial: editorInitial,
              busy: busy,
              onSave: async (payload) => {
                setBusy(true);
                setError("");
                setNotice("");
                try {
                  await apiFetch("/tool-manager/api/save", { method: "POST", body: payload });
                  setNotice("已保存");
                  setEditing(null);
                  await load();
                } catch (err) {
                  setError(err && err.message ? err.message : String(err));
                } finally {
                  setBusy(false);
                }
              },
              onTest: (payload) => {
                setTestTarget({ customId: payload.id, name: payload.name || "未命名工具", code: payload.code });
              },
              onCancel: () => setEditing(null),
            })
          : jsxs(Fragment, { children: [
              jsxs("div", { className: "dsh-tm-toolbar", children: [
                jsxs("div", { className: "dsh-tm-search", children: [
                  jsx("span", { className: "dsh-tm-search-icon", children: jsx(IconSearchOutline16, { size: 14 }) }),
                  jsx("input", { value: query, onChange: (e) => setQuery(e.target.value), placeholder: "搜索工具（名称 / 描述）…" }),
                ] }),
                jsx("button", {
                  className: "dsh-tm-btn dsh-tm-btn-primary",
                  disabled: busy,
                  onClick: () => { setEditing("__new__"); setConfirmId(null); },
                  children: jsxs(Fragment, { children: [jsx(IconPlusOutline16, { size: 13 }), " 新建工具"] }),
                }),
                jsxs("span", { className: "dsh-tm-stats", children: [
                  jsx("span", { className: "dsh-tm-chip", children: "共 " + tools.length + " 个工具" }),
                  jsx("span", { className: "dsh-tm-chip", children: "自定义 " + tools.filter((t) => t.source === "custom").length }),
                  jsx("span", { className: "dsh-tm-chip", children: "已禁用 " + tools.filter((t) => t.disabled).length }),
                ] }),
              ] }),
              jsx("div", { className: "dsh-tm-hint", children: "状态保存在 " + (data ? data.path : "") + "，改动即时生效。" }),
              jsx("div", {
                className: "dsh-tm-list",
                children: visible.length === 0
                  ? jsx("div", { className: "dsh-tm-empty", children: q ? "没有匹配的工具" : "没有符合条件的工具。" })
                  : visible.map((tool) => jsx(ToolCard, {
                      key: tool.name + "-" + tool.customId,
                      tool: tool,
                      busy: busy,
                      confirmDelete: confirmId,
                      protectedNames: protectedNames,
                      onAskDelete: (t) => { setConfirmId(t.customId); },
                      onEdit: (t) => { setEditing(t); setConfirmId(null); },
                      onToggle: (t) => {
                        setConfirmId(null);
                        runAction("/tool-manager/api/toggle", { name: t.name, disabled: !t.disabled });
                      },
                      onTest: (t) => setTestTarget(t),
                      onDelete: (t) => {
                        setConfirmId(null);
                        runAction("/tool-manager/api/delete", { id: t.customId });
                      },
                    })),
              }),
            ] }),
        testTarget
          ? jsx(TestDialog, {
              tool: testTarget,
              defaultTimeoutMs: defaultTimeoutMs,
              onClose: () => setTestTarget(null),
            })
          : null,
      ] });
    }

    /** 侧边栏入口 + 独立面板 */
    function ToolManagerEntry(props) {
      const { wide } = props;
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
          className: "dsh-tm-trigger",
          "data-rail": wide ? undefined : true,
          "aria-haspopup": "dialog",
          "aria-expanded": open,
          title: "工具管理",
          onClick: () => setOpen(true),
          children: [
            jsx(IconSettingsOutline16, { size: wide ? 16 : 18 }),
            wide ? jsx("span", { className: "dsh-tm-trigger-label", children: "工具管理" }) : null,
          ],
        }),
        open
          ? jsxs("div", { className: "dsh-tm-overlay", role: "dialog", "aria-label": "工具管理", children: [
              jsx("div", { className: "dsh-tm-mask", onClick: close }),
              jsxs("div", { className: "dsh-tm-panel", children: [
                jsxs("div", { className: "dsh-tm-panel-head", children: [
                  jsx("span", { className: "dsh-tm-panel-title", children: "工具管理" }),
                  jsx("button", {
                    type: "button",
                    className: "dsh-tm-panel-close",
                    "aria-label": "关闭",
                    onClick: close,
                    children: jsx(IconCloseOutline16, { size: 14 }),
                  }),
                ] }),
                jsx("div", { className: "dsh-tm-panel-body", children: jsx(ManagerSection, {}) }),
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
        id: "dsh-tool-manager",
        order: 26,
        label: () => "工具管理",
      }, ToolManagerEntry));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
