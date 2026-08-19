// dsh-retract-prompt 客户端插件（浏览器 bundle，__ModuleLoader__ 格式）
// v3：每条用户指令消息下方的操作区提供「撤回」按钮（复制按钮旁）。
//  - 接管 conversation.chat.node 的 user / steering 渲染（priority 最低，
//    渲染出错会自动回退到原版渲染器）；
//  - 点击「撤回」：若 Agent 正在运行先停止（等价「停止生成」），然后把这条
//    指令的文本直接放回会话主输入框，用户在输入框里修改后自行发送（无弹窗）。
// 说明：DSH 会话历史 append-only，无删除/替换 API，「撤回」= 停止执行 + 内容
// 放回输入框重发修正版本。
// 注意：React 19 的 jsx(type, props) 中 children 必须放进 props 对象。
window.__ModuleLoader__.load({
  id: "dsh-retract-prompt",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var react_jsx_runtime = require("react/jsx-runtime");
    var react = require("react");
    const { jsx, jsxs } = react_jsx_runtime;
    const { useState, useEffect, useRef, useCallback } = react;

    // ---------------------------------------------------------------- 工具

    /** content block 数组 → { text, images, rest }（与原版 contentParts 一致）。 */
    function contentParts(content) {
      const texts = [];
      const images = [];
      const rest = [];
      for (const block of content || []) {
        const b = block;
        if (b && b.type === "text" && typeof b.text === "string") texts.push(b.text);
        else if (b && b.type === "image" && b.attachment !== void 0) images.push({ attachment: b.attachment });
        else if (b) rest.push(b);
      }
      return { text: texts.join(""), images, rest };
    }

    function formatClock(time) {
      try {
        return new Date(time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      } catch {
        return "";
      }
    }

    /** 同源 fetch 封装：服务端返回 { ok:false, error } 时抛错。 */
    function apiFetch(path, options) {
      const init = { method: options && options.method ? options.method : "GET" };
      if (options && options.body !== undefined) {
        init.headers = { "content-type": "application/json" };
        init.body = JSON.stringify(options.body);
      }
      return fetch(path, init).then((res) => res.json()).then((data) => {
        if (!data || data.ok === false) {
          const err = new Error((data && (data.message || data.error)) || "请求失败");
          err.code = data && data.error;
          throw err;
        }
        return data;
      });
    }

    // ---------------------------------------------------------------- 样式

    const css = `
/* ---- 用户消息行（复刻原版布局，操作区增加撤回按钮） ---- */
.drp-ur-row{display:flex;flex-direction:column;align-items:flex-end;gap:6px}
.drp-ur-stack{display:flex;flex-direction:column;align-items:flex-end;gap:8px;min-width:0;max-width:min(525px,82%)}
.drp-ur-bubble{background:var(--dsw-specific-bubble);max-width:100%;color:var(--dsw-alias-label-primary);border-radius:22px;padding:10px 16px;font-size:16px;line-height:24px;white-space:pre-wrap;word-break:break-word}
.drp-ur-img{max-width:min(420px,100%);max-height:420px;border-radius:12px;object-fit:contain}
.drp-ur-rest{max-width:100%;margin:4px 0 0;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:8px 10px;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-all;overflow:auto;max-height:240px}
.drp-ur-rest summary{cursor:pointer;font-weight:600;color:var(--dsw-alias-label-secondary)}
.drp-ur-rest pre{margin:6px 0 0;font-size:11px;white-space:pre-wrap;word-break:break-all}
.drp-ur-actions{display:flex;align-items:center;gap:4px;height:28px}
.drp-ur-time{color:var(--dsw-alias-label-tertiary);white-space:nowrap;padding-right:12px;font-size:14px;line-height:24px;opacity:0;transition:opacity 80ms}
[data-time-hover-root]:hover .drp-ur-time,[data-time-hover-root]:focus-within .drp-ur-time{opacity:1}
.drp-ur-btn{display:inline-flex;align-items:center;gap:4px;height:28px;padding:0 8px;border:none;border-radius:28px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;font:inherit;font-size:12px;white-space:nowrap}
.drp-ur-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.drp-ur-btn:disabled{opacity:.45;cursor:default}
.drp-ur-btn-running{color:var(--dsw-alias-label-error)}
.drp-ur-btn-running:hover:not(:disabled){color:var(--dsw-alias-label-error)}
.drp-ur-copied{color:var(--dsw-alias-state-success-primary)}
/* ---- 撤回结果提示（底部 toast） ---- */
.drp-toast{position:fixed;left:50%;bottom:96px;transform:translateX(-50%);z-index:4000;max-width:72vw;background:var(--dsw-static-neutral-bluish-1000,#1d2b4f);color:#ffffff;border-radius:10px;padding:8px 14px;font-size:12px;line-height:1.5;text-align:center;box-shadow:var(--dsw-shadow-lv3)}
.drp-toast-err{background:var(--dsw-alias-label-error)}
`;

    function ensureCss() {
      const tagId = "dsh-retract-prompt/style.css";
      if (typeof document !== "undefined" && document.querySelector('style[data-plugin-css="' + tagId + '"]') === null) {
        const tag = document.createElement("style");
        tag.dataset.plugin = "dsh-retract-prompt";
        tag.dataset.pluginCss = tagId;
        tag.textContent = css;
        document.head.appendChild(tag);
      }
    }

    // ---------------------------------------------------------------- 图片

    /** 简单图片渲染：loadImage(attachment) → URL。 */
    function RetractImage({ attachment, loadImage, alt }) {
      const [url, setUrl] = useState(null);
      useEffect(() => {
        let alive = true;
        if (typeof loadImage !== "function") return;
        loadImage(attachment)
          .then((u) => {
            if (alive && typeof u === "string") setUrl(u);
          })
          .catch(() => {});
        return () => {
          alive = false;
        };
      }, [attachment, loadImage]);
      if (!url) return null;
      return jsx("img", { className: "drp-ur-img", src: url, alt: alt || "", draggable: false });
    }

    // ---------------------------------------------------------------- 用户消息渲染

    /**
     * user / steering 消息渲染器：复刻原版气泡 + 操作区（时间 / 复制 / 撤回）。
     * props：标准 kit（useSessions / sessionId）+ ChatNodeSeat 的 routedOwner
     * （node / loadImage）+ 本插件 inject（scopedConversation / inputShell）。
     */
    function RetractUserMessageView(props) {
      const { node, loadImage, sessionId, useSessions, scopedConversation, inputShell, resyncSession } = props;
      const data = node && node.data ? node.data : {};
      const { text, images, rest } = contentParts(data.content);
      const running = useSessions((s) => !!(s && s.byId && s.byId[sessionId] && s.byId[sessionId].running));

      const [busy, setBusy] = useState(false);
      const [notice, setNotice] = useState(null); // { kind: "ok"|"err", text }
      const noticeTimer = useRef(null);
      const mountedRef = useRef(true);
      useEffect(() => () => { mountedRef.current = false; }, []);
      useEffect(() => () => {
        if (noticeTimer.current) clearTimeout(noticeTimer.current);
      }, []);

      const flash = useCallback((kind, text) => {
        if (!mountedRef.current) return;
        setNotice({ kind, text });
        if (noticeTimer.current) clearTimeout(noticeTimer.current);
        noticeTimer.current = setTimeout(() => {
          if (mountedRef.current) setNotice(null);
        }, 5000);
      }, []);

      const [copied, setCopied] = useState(false);
      const copyTimer = useRef(null);
      useEffect(() => () => {
        if (copyTimer.current) clearTimeout(copyTimer.current);
      }, []);

      const onCopy = useCallback(() => {
        if (!text || copied) return;
        const done = () => {
          if (!mountedRef.current) return;
          setCopied(true);
          if (copyTimer.current) clearTimeout(copyTimer.current);
          copyTimer.current = setTimeout(() => {
            if (mountedRef.current) setCopied(false);
          }, 1000);
        };
        try {
          if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
            navigator.clipboard.writeText(text).then(done).catch(() => {});
          } else {
            const ta = document.createElement("textarea");
            ta.value = text;
            ta.style.position = "fixed";
            ta.style.opacity = "0";
            document.body.appendChild(ta);
            ta.select();
            try {
              document.execCommand("copy");
              done();
            } catch {
              /* 复制失败静默 */
            }
            document.body.removeChild(ta);
          }
        } catch {
          /* 复制失败静默 */
        }
      }, [text, copied]);

      /**
       * 撤回：若正在运行先停止，然后把这条指令的文本直接放回会话主输入框。
       * 无弹窗 —— 用户在输入框里修改后自行发送。
       */
      const onRetract = useCallback(async () => {
        if (busy || !text || !text.trim()) return;
        setBusy(true);
        try {
          // 1) 正在运行 → 先停止
          if (running) {
            try {
              const conv = scopedConversation(sessionId);
              if (conv) await conv.cancel();
            } catch (err) {
              // 停止失败不阻塞撤回（服务端会按 open turn 自动前移边界）
              flash("err", "停止运行失败：" + (err && err.message ? err.message : String(err)) + "，继续撤回…");
            }
            // 等 Agent 收尾事件落定，避免截断竞态
            await new Promise((r) => setTimeout(r, 400));
          }
          // 2) 服务端真正撤回：删除该消息及其后的所有事件（不再参与对话）
          if (data.seq === undefined) throw new Error("无法确定这条指令的序号");
          await apiFetch("/retract-prompt/api/retract", {
            method: "POST",
            body: { sessionId, seq: data.seq },
          });
          // 3) 内容放回输入框 + 提示（提示先显示，重载后消息节点消失）
          const shell = inputShell(sessionId);
          if (shell) shell.actions.setDraft(text);
          flash("ok", "已撤回这条指令（不再参与对话），内容已放回输入框，修改后发送即可");
          // 4) 重载会话窗口（重新拉取历史，被撤回的消息消失）
          const resync = resyncSession(sessionId);
          if (resync && typeof resync.then === "function") await resync;
        } catch (err) {
          flash("err", err && err.message ? err.message : String(err));
        } finally {
          if (mountedRef.current) setBusy(false);
        }
      }, [busy, running, text, data.seq, sessionId, scopedConversation, inputShell, resyncSession, flash]);

      const showBubble = text !== "" || rest.length > 0;

      return jsxs("div", {
        className: "drp-ur-row",
        "data-time-hover-root": true,
        children: [
          jsxs("div", {
            className: "drp-ur-stack",
            children: [
              images.map((img, i) => jsx(RetractImage, {
                key: i,
                attachment: img.attachment,
                loadImage,
                alt: "用户图片",
              })),
              showBubble
                ? jsxs("div", {
                    className: "drp-ur-bubble",
                    children: [
                      text,
                      rest.map((block, i) => jsx("details", {
                        key: "rest" + i,
                        className: "drp-ur-rest",
                        children: [
                          jsx("summary", { children: "附加内容 #" + (i + 1) }),
                          jsx("pre", { children: JSON.stringify(block, null, 2) }),
                        ],
                      })),
                    ],
                  })
                : null,
            ],
          }),
          jsxs("div", {
            className: "drp-ur-actions",
            children: [
              data.time ? jsx("span", { className: "drp-ur-time", children: formatClock(data.time) }) : null,
              jsx("button", {
                type: "button",
                className: "drp-ur-btn" + (copied ? " drp-ur-copied" : ""),
                title: copied ? "已复制" : "复制这条指令",
                "aria-label": copied ? "已复制" : "复制",
                onClick: onCopy,
                children: copied ? "✓ 已复制" : "复制",
              }),
              jsx("button", {
                type: "button",
                className: "drp-ur-btn" + (running ? " drp-ur-btn-running" : ""),
                title: running ? "停止当前运行，并撤回这条指令（从对话中移除，不再参与对话）" : "撤回这条指令（从对话中移除，不再参与对话），修改后重新发送",
                "aria-label": "撤回这条指令",
                disabled: busy,
                onClick: onRetract,
                children: busy ? "处理中…" : (running ? "⏹ 停止并撤回" : "✎ 撤回"),
              }),
            ],
          }),
          notice
            ? jsx("div", {
                className: "drp-toast" + (notice.kind === "err" ? " drp-toast-err" : ""),
                role: "status",
                children: notice.text,
              })
            : null,
        ],
      });
    }

    // ---------------------------------------------------------------- 插件入口

    const inject = ["slots", "conversation", "sessions"];

    function apply(ctx) {
      ensureCss();

      const sessionsScope = (sessionId) => {
        try {
          return ctx.sessions.scope(sessionId);
        } catch {
          return null;
        }
      };
      const scopedConversation = (sessionId) => {
        try {
          const scoped = sessionsScope(sessionId);
          if (!scoped) return null;
          return scoped.get("conversation") || null;
        } catch {
          return null;
        }
      };
      const inputShell = (sessionId) => {
        try {
          const input = ctx.conversation ? ctx.conversation.input : null;
          if (!input || typeof input.shell !== "function") return null;
          return input.shell(sessionId);
        } catch {
          return null;
        }
      };
      /** 重载客户端会话窗口（重新拉取历史；撤回后调用使消息消失）。 */
      const resyncSession = (sessionId) => {
        try {
          const binding = ctx.sessions.binding(sessionId);
          if (!binding || !binding.session || typeof binding.session.resync !== "function") return null;
          return binding.session.resync();
        } catch {
          return null;
        }
      };

      // 接管 user / steering 消息渲染（priority 最低；渲染出错自动回退原版）
      for (const key of ["user", "steering"]) {
        ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({
          name: "conversation.chat.node",
          key,
          priority: -1,
          inject: () => ({
            scopedConversation,
            inputShell,
            resyncSession,
          }),
        }, RetractUserMessageView));
      }
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
