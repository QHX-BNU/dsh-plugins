// dsh-show-image 客户端插件（浏览器 bundle，__ModuleLoader__ 格式）
// 职责：在 `tool.call.toolview` 注册 key=show_image 的分发，渲染工具结果
// （携带 base64 data URL 的图片网格）为对话内联卡片；点击任一图片用
// createPortal(document.body) 渲染一个全屏灯箱（✕ / 点遮罩 / Esc 关闭）。
//
// 灯箱用局部 useState + portal，而不是 shell.overlay 席位：
//  - 局部状态保证点哪张、放大哪张，不依赖跨组件共享状态；
//  - portal 到 document.body 完全脱离应用框架的 overflow/z-index 裁剪。
// 图片字节来自工具结果 presentation（meta.images），不进会话消息内容与模型历史。
// 主题适配要点（见记忆）：不依赖 brand-primary 做背景（深色主题下它是近白色），
// 统一用 --dsw-alias-* 安全语义变量；按钮用深底白字。
window.__ModuleLoader__.load({
  id: "dsh-show-image",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const react = require("react");
    const { useState, useMemo, useEffect } = react;
    const react_dom = require("react-dom");
    const { createPortal } = react_dom;
    const react_jsx_runtime = require("react/jsx-runtime");
    const { jsx, jsxs, Fragment } = react_jsx_runtime;

    const css = `
.dsh-si *{box-sizing:border-box}
.dsh-si-grid{display:flex;flex-wrap:wrap;gap:8px;padding:8px 12px 8px 12px}
.dsh-si-cell{flex:1 1 120px;min-width:120px;display:flex;flex-direction:column;gap:4px}
.dsh-si-thumb{max-width:100%;max-height:320px;object-fit:contain;border-radius:8px;cursor:zoom-in;display:block;background:var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.15))}
.dsh-si-caption{font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary, #999);word-break:break-all}
.dsh-si-status{padding:8px 12px;font-size:13px;color:var(--dsw-alias-label-secondary, #999)}
.dsh-si-backdrop{position:fixed;inset:0;z-index:1000;pointer-events:auto;display:flex;align-items:center;justify-content:center;padding:32px;background:rgba(0,0,0,.68)}
.dsh-si-frame{position:relative;display:flex;flex-direction:column;align-items:center;gap:8px;max-width:92vw;max-height:92vh}
.dsh-si-image{max-width:88vw;max-height:78vh;object-fit:contain;border-radius:8px;display:block;background:var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.15));box-shadow:0 10px 44px rgba(0,0,0,.5)}
.dsh-si-close{position:absolute;top:-16px;right:-16px;width:30px;height:30px;border-radius:50%;border:1px solid rgba(255,255,255,.2);background:var(--dsw-alias-bg-elevated, #2a2a2a);color:var(--dsw-alias-label-primary, #eee);cursor:pointer;font-size:15px;line-height:1;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 10px rgba(0,0,0,.4)}
.dsh-si-caption2{color:var(--dsw-alias-label-secondary, #bbb);font-size:13px;line-height:18px;text-align:center;word-break:break-all;max-width:88vw}
`;

    function ensureCss() {
      const tagId = "dsh-show-image/style.css";
      if (typeof document !== "undefined" && document.querySelector('style[data-plugin-css="' + tagId + '"]') === null) {
        const tag = document.createElement("style");
        tag.dataset.plugin = "dsh-show-image";
        tag.dataset.pluginCss = tagId;
        tag.textContent = css;
        document.head.appendChild(tag);
      }
    }

    /** 全屏灯箱（经由 document.body 的 portal 渲染）。 */
    function LightboxOverlay({ entry, onClose }) {
      useEffect(() => {
        const onKey = (event) => {
          if (event.key === "Escape") onClose();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
      }, [onClose]);

      const hasCaption = entry.caption !== undefined && entry.caption !== "";
      return createPortal(
        jsxs("div", {
          className: "dsh-si-backdrop",
          onClick: onClose,
          children: [
            jsxs("div", {
              className: "dsh-si-frame",
              onClick: (event) => event.stopPropagation(),
              children: [
                jsx("button", {
                  type: "button",
                  "aria-label": "关闭",
                  className: "dsh-si-close",
                  onClick: onClose,
                  children: "✕",
                }),
                jsx("img", {
                  className: "dsh-si-image",
                  src: entry.src,
                  alt: entry.caption ?? entry.title ?? "",
                  title: entry.title,
                }),
                hasCaption ? jsx("div", { className: "dsh-si-caption2", children: entry.caption }) : null,
              ],
            }),
          ],
        }),
        document.body,
      );
    }

    /** 解析记录的原始工具参数（缺失/形状变化时静默降级为 null）。 */
    function parseArgs(block) {
      if (block === null || typeof block !== "object") return null;
      const raw = block.call != null ? block.call.argsRaw : block.argsRaw;
      if (typeof raw !== "string" || raw.length === 0) return null;
      try {
        const parsed = JSON.parse(raw);
        return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
      } catch {
        return null;
      }
    }

    /** 对话内联图片卡片 + 灯箱（点击任一图片放大）。props 来自 slot kit。 */
    function ShowImageRow(props) {
      const { block } = props;
      const view = block != null ? block.resultView : undefined;
      const settled = block != null && "kind" in block;
      const args = useMemo(() => parseArgs(block), [block]);
      const images = useMemo(() => {
        if (!settled || view == null || view.kind !== "images" || !Array.isArray(view.images)) return [];
        return view.images;
      }, [settled, view]);

      const [lightbox, setLightbox] = useState(null);

      const rawColumns = Number(args && args.columns);
      const columns = Math.max(1, Math.min(6, Number.isFinite(rawColumns) && rawColumns > 0 ? rawColumns : 3));
      const captions = Array.isArray(args && args.captions) ? args.captions : [];

      if (!settled) {
        const count = Array.isArray(args && args.paths) ? args.paths.length : 0;
        return jsx("div", { className: "dsh-si-status", children: count > 0 ? `正在显示 ${count} 张图片…` : "正在读取图片…" });
      }

      if (images.length === 0) {
        return jsx("div", {
          className: "dsh-si-status",
          children: Array.isArray(args && args.paths) && args.paths.length > 0
            ? `显示 ${args.paths.length} 张图片（渲染失败，路径见结果文本）`
            : "（无图片）",
        });
      }

      return jsxs(Fragment, { children: [
        jsx("div", { className: "dsh-si-grid", children: images.map((img, index) => {
          const caption = captions[index] ?? img.name ?? img.path;
          const src = typeof img.dataUrl === "string" && img.dataUrl.length > 0 ? img.dataUrl : undefined;
          return jsxs("div", { key: img.attachmentId ?? `${index}`, className: "dsh-si-cell", children: [
            src === undefined
              ? jsx("span", { className: "dsh-si-status", children: "图片数据不可用" })
              : jsx("img", {
                  className: "dsh-si-thumb",
                  src,
                  alt: caption,
                  title: img.path,
                  onClick: () => setLightbox({ src, caption, title: img.path }),
                }),
            caption !== undefined && caption !== ""
              ? jsx("div", { className: "dsh-si-caption", children: caption })
              : null,
          ] });
        }) }),
        lightbox !== null ? jsx(LightboxOverlay, { entry: lightbox, onClose: () => setLightbox(null) }) : null,
      ] });
    }

    const inject = ["slots"];

    function apply(ctx) {
      ensureCss();
      ctx.slots.inject("tool.call.toolview", () => ctx.slots.register({
        name: "tool.call.toolview",
        key: "show_image",
        locale: "conversation",
      }, (props) => jsx(ShowImageRow, props)));
    }

    exports.name = "dsh-show-image";
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
