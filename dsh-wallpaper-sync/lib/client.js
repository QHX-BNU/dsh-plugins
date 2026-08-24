// dsh-wallpaper-sync 客户端插件（浏览器 bundle，__ModuleLoader__ 格式）
//
// 完全参照 dsh-dream-skin / dsh-ui-appearance 的官方实现方式：
//   - 客户端通过 ctx.theme.overrideTokens() 覆写主题 token（这里是让内容画布半透明，
//     从而透出背景层），而不是手动在 body 上塞 !important 变量；
//   - 背景层是一个 z-index:-1 的 fixed 元素，用 background-image 承载壁纸；
//   - 渲染方式按壁纸类型：video→<video>、web→<iframe>、scene→静态帧、image→<img>；
//   - 通过同源 fetch 调 /wallpaper-sync/api/* 拿当前壁纸与状态，轮询跟随桌面切换。
//
// 前端零 React 依赖，仅用 ctx.theme + 原生 DOM + fetch。
window.__ModuleLoader__.load({
  id: "dsh-wallpaper-sync",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    // ---------------------------------------------------------------- 常量
    const OVERRIDE_SOURCE = "dsh-wallpaper-sync";
    const BG_LAYER_ID = "dswp-bg-layer";
    const PANEL_ID = "dswp-panel";
    const TOGGLE_ID = "dswp-toggle";
    const SETTINGS_KEY = "dsh-wallpaper-sync.settings";

    const DEFAULT_SETTINGS = {
      enabled: true,
      follow: true,       // 跟随桌面：开=同步当前桌面壁纸；关=用手动从库选的壁纸
      pickedKey: "",      // 手动模式选中的库壁纸（规范化 key）
      overlay: 0.30,      // 内容遮罩(纱帘)强度 0..0.9
      opacity: 0.55,      // 内容画布不透明度 0.2..1（越小越透壁纸；0.88 太实会遮住壁纸）
      blur: 0,            // 背景模糊 px
      fit: "cover",       // 适配方式：cover=铺满裁边(同桌面) / contain=完整显示留白
      pos: "center",      // 背景定位：center / top / bottom / left / right
      mode: "auto",       // 动态/静态：auto=按壁纸类型 / static=强制静态帧 / animated=强制播放视频
      pollIntervalMs: 3000,
    };

    // ---------------------------------------------------------------- 设置
    let settings;
    function loadSettings() {
      try {
        const raw = localStorage.getItem(SETTINGS_KEY);
        settings = raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_SETTINGS };
      } catch {
        settings = { ...DEFAULT_SETTINGS };
      }
    }
    function saveSettings() {
      try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* ignore */ }
    }
    function clamp(v, min, max) {
      const n = Number(v);
      if (isNaN(n)) return min;
      return Math.min(max, Math.max(min, n));
    }

    // ---------------------------------------------------------------- API（同源 fetch）
    async function fetchCurrent() {
      const r = await fetch("/wallpaper-sync/api/current");
      return r.json().catch(() => ({ ok: false }));
    }
    async function fetchStatus() {
      const r = await fetch("/wallpaper-sync/api/status");
      return r.json().catch(() => ({ ok: false }));
    }

    // ---------------------------------------------------------------- 背景层
    let bgEl = null;        // 壁纸层元素
    let frameEl = null;     // img/video/iframe 当前渲染层
    let currentCtx = null;  // 最近一次 { kind, title, file, ... }
    let lastSig = null;
    let pollTimer = null;
    let wallpaperOverrideDispose = null;

    // 内容画布的可读纱帘：壁纸上叠一层（深浅主题分别配色）
    const SCRIM = { light: "rgba(255,255,255,", dark: "rgba(10,15,30," };

    // 内容画布不透明底色（mode pair），用于 overrideTokens 的半透明烘焙。
    const CANVAS_BASE = {
      "--dsw-alias-bg-base": { light: "#ffffff", dark: "#151517" },
      "--dsw-specific-sidebar-fill": { light: "#f9fafb", dark: "#1b1b1c" },
    };

    function ensureBgEl() {
      if (bgEl && document.body && document.body.contains(bgEl)) return bgEl;
      bgEl = document.createElement("div");
      bgEl.id = BG_LAYER_ID;
      bgEl.style.cssText =
        "position:fixed;inset:0;z-index:-1;pointer-events:none;" +
        "background-size:cover;background-position:center;background-repeat:no-repeat;";
      document.body.prepend(bgEl);
      return bgEl;
    }

    /**
     * 用 ctx.theme.overrideTokens() 覆写内容画布 token 为半透明，让壁纸从内容透出。
     * 采用与 dsh-dream-skin 完全一致的方式：token 值按 {light,dark} 给 rgba 对。
     */
    function shadeCanvas(ctx, alpha) {
      const overrides = {};
      for (const [name, pair] of Object.entries(CANVAS_BASE)) {
        overrides[name] = {
          light: toRgba(pair.light, alpha),
          dark: toRgba(pair.dark, alpha),
        };
      }
      wallpaperOverrideDispose?.();
      wallpaperOverrideDispose = ctx.theme.overrideTokens(OVERRIDE_SOURCE, overrides);
    }

    function toRgba(hex, alpha) {
      const a = clamp(alpha, 0, 1);
      const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || "").trim());
      if (m) {
        const n = parseInt(m[1], 16);
        const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
        return `rgba(${r}, ${g}, ${b}, ${a})`;
      }
      return `rgba(21, 21, 23, ${a})`;
    }

    function clearFrame() {
      if (frameEl) { frameEl.remove(); frameEl = null; }
    }

    function teardownWallpaper() {
      clearFrame();
      if (bgEl) { bgEl.removeAttribute("data-kind"); bgEl.style.backgroundImage = "none"; }
    }

    /** 计算此壁纸应采用的动/静模式。 */
    function resolveMode(kind) {
      // auto：video→动态播放；scene/image/web→静态。static 强制静态；animated 强制视频播放(仅视频有意义)。
      if (settings.mode === "static") return "static";
      if (settings.mode === "animated") return kind === "video" ? "animated" : "static";
      // auto
      if (kind === "video") return "animated";
      return "static";
    }

    /** 应用背景层 CSS 的适配/定位。 */
    function applyBgFit() {
      if (!bgEl) return;
      const fit = settings.fit === "contain" ? "contain" : "cover";
      bgEl.style.backgroundSize = fit;
      bgEl.style.backgroundPosition = settings.pos || "center";
      bgEl.style.backgroundRepeat = "no-repeat";
    }

    /** 渲染 video 层（animated 播放 / static 定格首帧）。 */
    function mountVideo(info, mediaUrl, scrimColor, animated) {
      const v = document.createElement("video");
      v.muted = true; v.loop = true; v.playsInline = true;
      v.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:" +
        (settings.fit === "contain" ? "contain" : "cover") + ";object-position:" + (settings.pos || "center") + ";";
      v.src = mediaUrl;
      v.preload = "auto";
      if (animated) {
        v.autoplay = true;
        v.paused = false;
        try { v.play().catch(() => {}); } catch { /* 忽略 */ }
      } else {
        // 静态：加载首帧并暂停
        v.autoplay = false;
        v.paused = true;
        v.addEventListener("loadeddata", () => { try { v.pause(); v.currentTime = 0; } catch { /* 忽略 */ } });
      }
      v.onerror = () => { v.remove(); frameEl = null; };
      bgEl.appendChild(v); frameEl = v;
      bgEl.style.backgroundImage = `linear-gradient(${scrimColor}, ${scrimColor})`;
    }

    /** 按当前壁纸信息渲染背景层 frame + 覆写画布 token。
     *  item 兼容两种来源：
     *   - /current 返回的 info：{ kind, title, mediaUrl, mediaType, sceneFrame, sceneFrameType, ... }
     *   - 壁纸库条目：{ kind, title, mediaUrl, previewUrl, ... }
     */
    function renderBg(ctx, info) {
      if (!bgEl) return;
      clearFrame();
      if (!info || (!info.ok && !info.kind)) {
        teardownWallpaper();
        return;
      }
      currentCtx = info;
      const scrim = clamp(settings.overlay, 0, 0.9);
      const dark = document.body.getAttribute("data-ds-dark-theme") !== null;
      const scrimColor = (dark ? SCRIM.dark : SCRIM.light) + scrim + ")";
      const blurPx = clamp(settings.blur, 0, 40);
      const kindMode = info.kind;
      const effMode = resolveMode(kindMode);

      // 媒体地址：库条目优先用其 mediaUrl；scene 无媒体时用预览帧
      let mediaUrl = info.mediaUrl || "/wallpaper-sync/api/media";
      if (kindMode === "scene") {
        // scene 无视频源：用其静态预览帧（/current 给 sceneFrame 对应 /media；库条目给 previewUrl）
        mediaUrl = info.sceneFrame ? "/wallpaper-sync/api/media" : (info.previewUrl || mediaUrl);
      }

      bgEl.style.filter = blurPx > 0 ? `blur(${blurPx}px)` : "none";
      bgEl.setAttribute("data-kind", kindMode);
      bgEl.setAttribute("data-mode", effMode);
      applyBgFit();

      if (kindMode === "video") {
        mountVideo(info, mediaUrl, scrimColor, effMode === "animated");
      } else if (kindMode === "web") {
        const fr = document.createElement("iframe");
        fr.style.cssText = "position:absolute;inset:0;width:100%;height:100%;border:0;";
        fr.src = mediaUrl; fr.setAttribute("scrolling", "no");
        bgEl.appendChild(fr); frameEl = fr;
        bgEl.style.backgroundImage = `linear-gradient(${scrimColor}, ${scrimColor})`;
      } else {
        // scene（静态帧）/ image：作为背景图像，fit/pos 生效
        bgEl.style.backgroundImage =
          `linear-gradient(${scrimColor}, ${scrimColor}), url("${mediaUrl}")`;
      }

      // 内容画布半透明 → 透出壁纸
      shadeCanvas(ctx, settings.opacity);
    }

    // ---------------------------------------------------------------- 跟随轮询
    async function refresh(ctx, force) {
      if (!settings.enabled) return;
      if (!settings.follow && settings.pickedKey) {
        // 手动模式：渲染库中选中的壁纸，不跟随桌面
        const lib = await ensureLibrary();
        const item = (lib && lib.items ? lib.items : []).find((x) => x.key === settings.pickedKey);
        if (item) {
          renderBg(ctx, { kind: item.kind, title: item.title, mediaUrl: item.mediaUrl, previewUrl: item.previewUrl, mediaType: item.mediaType, _picked: true });
          currentCtx = item;
        } else {
          // 选中项失效：回退跟随桌面
          settings.pickedKey = '';
          saveSettings();
          return refresh(ctx, true);
        }
        updatePanelNow();
        return;
      }
      // 跟随桌面模式
      const info = await fetchCurrent();
      if (info && info.ok) {
        renderBg(ctx, info);
        lastSig = `${info.file}|${info.monitor}|${info.kind}`;
      } else {
        teardownWallpaper();
        currentCtx = null;
        lastSig = null;
      }
      updatePanelNow();
    }
    async function tick(ctx) {
      if (!settings.enabled || !settings.follow) return;
      const st = await fetchStatus();
      if (!st || !st.ok) return;
      const sig = `${st.file}|${st.monitor}|${st.kind}`;
      if (sig !== lastSig) await refresh(ctx, true);
    }
    function startPolling(ctx) {
      stopPolling();
      if (!settings.follow || !settings.enabled) return;
      pollTimer = setInterval(() => tick(ctx), Math.max(500, Number(settings.pollIntervalMs) || 3000));
    }
    function stopPolling() {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    }

    // ---------------------------------------------------------------- 壁纸库
    let libraryCache = null; // { items: [...] }
    async function ensureLibrary(force) {
      if (libraryCache && !force) return libraryCache;
      try {
        const r = await fetch("/wallpaper-sync/api/library");
        const data = await r.json();
        libraryCache = data && data.ok ? data : { ok: false, items: [] };
      } catch {
        libraryCache = { ok: false, items: [] };
      }
      return libraryCache;
    }

    // ---------------------------------------------------------------- 设置面板 + 浮钮
    // 用固定深底白字（不依赖 brand-primary），两套主题都可读。
    let panelEl = null;
    let toggleEl = null;

    function buildUi(ctx) {
      if (toggleEl && document.body.contains(toggleEl)) return;
      const css = `
#${TOGGLE_ID}{position:fixed;right:16px;bottom:16px;z-index:3000;width:38px;height:38px;border-radius:12px;
  display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:18px;line-height:1;
  background:#1d2b4f;color:#fff;border:1px solid rgba(255,255,255,.18);box-shadow:0 6px 20px rgba(0,0,0,.35);
  user-select:none}
#${TOGGLE_ID}:hover{filter:brightness(1.15)}
#${TOGGLE_ID} .dot{width:8px;height:8px;border-radius:50%;background:#5ce08b;position:absolute;top:5px;right:5px;border:1px solid rgba(0,0,0,.4)}
#${TOGGLE_ID}.off .dot{background:#8a93a6}
#${PANEL_ID}{position:fixed;right:16px;bottom:62px;z-index:3000;width:308px;border-radius:14px;padding:14px 15px 16px;
  background:#1d2b4f;color:#fff;border:1px solid rgba(255,255,255,.16);box-shadow:0 10px 30px rgba(0,0,0,.4);
  font-size:13px;user-select:none}
#${PANEL_ID} h3{margin:0 0 4px;font-size:14px;font-weight:600;color:#fff}
#${PANEL_ID} .hint{margin:0 0 12px;font-size:11px;line-height:1.5;color:rgba(255,255,255,.62)}
#${PANEL_ID} .row{display:flex;align-items:center;gap:10px;margin:8px 0}
#${PANEL_ID} .row label{flex:1;min-width:0;font-size:12px;color:rgba(255,255,255,.88)}
#${PANEL_ID} .row input[type=range]{flex:0 0 120px;accent-color:#7aa2ff}
#${PANEL_ID} .row .val{flex:0 0 40px;text-align:right;font-size:11px;color:rgba(255,255,255,.7);font-variant-numeric:tabular-nums}
#${PANEL_ID} .sw{display:flex;align-items:center;justify-content:space-between;margin:6px 0}
#${PANEL_ID} .sw .lbl{font-size:12px;color:rgba(255,255,255,.88)}
#${PANEL_ID} .sw .tic{width:38px;height:20px;border-radius:10px;background:rgba(255,255,255,.18);position:relative;cursor:pointer;transition:background .18s}
#${PANEL_ID} .sw .tic::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:transform .18s}
#${PANEL_ID} .sw .tic.on{background:#3d8bfd}
#${PANEL_ID} .sw .tic.on::after{transform:translateX(18px)}
#${PANEL_ID} .now{margin:10px 0 0;font-size:11px;line-height:1.5;color:rgba(255,255,255,.62);padding-top:8px;border-top:1px solid rgba(255,255,255,.14);word-break:break-all}
#${PANEL_ID} .now b{color:rgba(255,255,255,.9);font-weight:600}
#${PANEL_ID} .sel{display:flex;align-items:center;gap:10px;margin:6px 0}
#${PANEL_ID} .sel label{flex:1;min-width:0;font-size:12px;color:rgba(255,255,255,.88)}
#${PANEL_ID} .sel select{flex:0 0 130px;background:rgba(255,255,255,.12);color:#fff;border:1px solid rgba(255,255,255,.2);border-radius:8px;height:26px;padding:0 6px;font-size:12px}
#${PANEL_ID} .sel select:hover{border-color:rgba(255,255,255,.4)}
#${PANEL_ID} .sel select option{background:#1d2b4f;color:#fff}
#${PANEL_ID} .lib-title{margin:12px 0 6px;font-size:12px;color:rgba(255,255,255,.7);display:flex;align-items:center;justify-content:space-between}
#${PANEL_ID} .lib-title button{background:none;border:1px solid rgba(255,255,255,.2);color:rgba(255,255,255,.8);border-radius:6px;height:22px;padding:0 8px;font-size:11px;cursor:pointer}
#${PANEL_ID} .lib-title button:hover{border-color:rgba(255,255,255,.5)}
#${PANEL_ID} .lib{max-height:180px;overflow:auto;display:grid;grid-template-columns:repeat(2,1fr);gap:6px;padding:2px}
#${PANEL_ID} .lib::-webkit-scrollbar{width:6px}
#${PANEL_ID} .lib::-webkit-scrollbar-thumb{background:rgba(255,255,255,.18);border-radius:3px}
#${PANEL_ID} .lib-it{position:relative;border:1px solid rgba(255,255,255,.16);border-radius:8px;overflow:hidden;cursor:pointer;aspect-ratio:16/9;background:#12182b}
#${PANEL_ID} .lib-it:hover{border-color:rgba(122,162,255,.6)}
#${PANEL_ID} .lib-it.cur{border-color:#3d8bfd;box-shadow:0 0 0 1px #3d8bfd}
#${PANEL_ID} .lib-it img{width:100%;height:100%;object-fit:cover;display:block}
#${PANEL_ID} .lib-it .tag{position:absolute;top:3px;left:3px;font-size:9px;padding:1px 5px;border-radius:4px;background:rgba(0,0,0,.6);color:#fff}
#${PANEL_ID} .lib-it .name{position:absolute;left:0;right:0;bottom:0;font-size:10px;line-height:1.2;padding:2px 5px 3px;background:linear-gradient(transparent,rgba(0,0,0,.75));color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#${PANEL_ID} .lib-it .sel{position:absolute;top:3px;right:3px;width:15px;height:15px;border-radius:50%;border:1px solid rgba(255,255,255,.5);font-size:10px;line-height:13px;text-align:center;color:#fff;background:rgba(0,0,0,.5)}
#${PANEL_ID} .lib-it.cur .sel{background:#3d8bfd;border-color:#3d8bfd}
.dswp-hide{display:none}
`;
      const style = document.createElement("style");
      style.dataset.plugin = "dsh-wallpaper-sync";
      style.dataset.pluginCss = "dsh-wallpaper-sync/panel.css";
      style.textContent = css;
      document.head.appendChild(style);

      toggleEl = document.createElement("button");
      toggleEl.id = TOGGLE_ID;
      toggleEl.title = "DSH 壁纸同步设置";
      toggleEl.textContent = "🖼";
      const dot = document.createElement("span");
      dot.className = "dot";
      toggleEl.appendChild(dot);
      document.body.appendChild(toggleEl);

      panelEl = document.createElement("div");
      panelEl.id = PANEL_ID;
      panelEl.className = "dswp-hide";
      panelEl.innerHTML = `
        <h3>背景壁纸同步</h3>
        <p class="hint">跟随 Windows 桌面背景（Wallpaper Engine 当前激活壁纸），桌面切换时自动跟随。</p>
        <div class="sw"><span class="lbl">启用背景壁纸</span><span class="tic" data-t="enabled"></span></div>
        <div class="sw"><span class="lbl">跟随桌面切换</span><span class="tic" data-t="follow"></span></div>
        <div class="lib-title"><span>壁纸库（点选即用）</span><button type="button" data-act="refreshlib">刷新</button></div>
        <div class="lib" data-lib></div>
        <div class="sel"><label>动/静模式</label><select data-s="mode"><option value="auto">自动</option><option value="static">静态帧</option><option value="animated">动态视频</option></select></div>
        <div class="sel"><label>屏幕适配</label><select data-s="fit"><option value="cover">铺满(同桌面)</option><option value="contain">完整显示</option></select></div>
        <div class="sel"><label>背景位置</label><select data-s="pos"><option value="center">居中</option><option value="top">靠上</option><option value="bottom">靠下</option><option value="left">靠左</option><option value="right">靠右</option></select></div>
        <div class="row"><label>内容不透明度</label><input type="range" data-k="opacity" min="20" max="100" step="1"><span class="val"></span></div>
        <div class="row"><label>背景模糊</label><input type="range" data-k="blur" min="0" max="40" step="1"><span class="val"></span></div>
        <div class="row"><label>遮罩强度</label><input type="range" data-k="overlay" min="0" max="90" step="1"><span class="val"></span></div>
        <div class="now"></div>
      `;
      document.body.appendChild(panelEl);

      toggleEl.addEventListener("click", (e) => {
        e.stopPropagation();
        panelEl.classList.toggle("dswp-hide");
      });

      panelEl.querySelectorAll(".tic").forEach((tic) => {
        tic.addEventListener("click", () => {
          const k = tic.dataset.t;
          settings[k] = !settings[k];
          saveSettings();
          syncUi(ctx);
          if (k === "enabled") { if (settings.enabled) refresh(ctx, true); else { teardownWallpaper(); stopPolling(); } }
          if (k === "follow") {
            // 跟随时回桌面；关掉时若没有已选壁纸则仍显示当前，随后由 refresh 决定
            if (settings.follow) settings.pickedKey = '';
            refresh(ctx, true);
          }
          startPolling(ctx);
          renderLibrary(ctx);
        });
      });
      panelEl.querySelectorAll("input[type=range]").forEach((inp) => {
        inp.addEventListener("input", () => {
          const k = inp.dataset.k;
          if (k === "blur") settings[k] = clamp(Number(inp.value), 0, 40);
          else settings[k] = clamp(Number(inp.value) / 100, 0, 1);
          saveSettings();
          applyPanelToCanvas(ctx);
          syncSliderVals();
        });
      });
      // 下拉：动/静模式、屏幕适配、背景位置
      panelEl.querySelectorAll("select[data-s]").forEach((sel) => {
        sel.addEventListener("change", () => {
          settings[sel.dataset.s] = sel.value;
          saveSettings();
          if (currentCtx) renderBg(ctx, currentCtx);
          else applyBgFit();
        });
      });
      // 壁纸库：刷新按钮
      const refreshBtn = panelEl.querySelector('[data-act="refreshlib"]');
      if (refreshBtn) refreshBtn.addEventListener("click", () => renderLibrary(ctx, true));
      // 壁纸库：点击选择（事件委托）
      const libEl = panelEl.querySelector("[data-lib]");
      if (libEl) libEl.addEventListener("click", (e) => {
        const it = e.target.closest(".lib-it");
        if (!it) return;
        const key = it.dataset.key;
        if (!key) return;
        settings.pickedKey = key;
        saveSettings();
        // 切换到手动模式（关掉跟随），渲染选中的壁纸
        settings.follow = false;
        saveSettings();
        syncUi(ctx);
        refresh(ctx, true).then(() => renderLibrary(ctx));
      });
    }

    /** 渲染壁纸库小网格。 */
    async function renderLibrary(ctx, force) {
      if (!panelEl || !panelEl.querySelector("[data-lib]")) return;
      const libEl = panelEl.querySelector("[data-lib]");
      const lib = await ensureLibrary(force);
      const items = (lib && lib.items) ? lib.items : [];
      if (items.length === 0) {
        libEl.innerHTML = `<div style="color:rgba(255,255,255,.5);font-size:11px;grid-column:1/-1;text-align:center;padding:10px 0">未扫描到壁纸（Wallpaper Engine 未激活或库为空）</div>`;
        return;
      }
      const kindLabel = { video: "视频", web: "网页", scene: "场景", image: "图片", unknown: "未知" };
      libEl.innerHTML = items.map((it) => {
        const thumb = it.previewUrl || "";
        const cur = it.current || (settings.follow ? false : settings.pickedKey === it.key);
        const selMark = cur ? `<span class="sel">✓</span>` : "";
        return `<div class="lib-it${cur ? " cur" : ""}" data-key="${escapeHtml(it.key)}" title="${escapeHtml(it.title)}">
          ${thumb ? `<img src="${escapeHtml(thumb)}" loading="lazy" alt="">` : `<div style="height:100%;background:#12182b"></div>`}
          <span class="tag">${kindLabel[it.kind] || "未知"}</span>
          <span class="name">${escapeHtml(it.title)}</span>${selMark}
        </div>`;
      }).join("");
    }

    function escapeHtml(s) {
      return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    }

    function applyPanelToCanvas(ctx) {
      if (!bgEl) return;
      const blurPx = clamp(settings.blur, 0, 40);
      bgEl.style.filter = blurPx > 0 ? `blur(${blurPx}px)` : "none";
      if (currentCtx) renderBg(ctx, currentCtx);
      shadeCanvas(ctx, settings.opacity);
    }

    function syncUi(ctx) {
      if (!panelEl) return;
      panelEl.querySelectorAll(".tic").forEach((tic) => {
        const k = tic.dataset.t;
        tic.classList.toggle("on", !!settings[k]);
      });
      toggleEl && toggleEl.classList.toggle("off", !settings.enabled);
      panelEl.querySelectorAll("input[type=range]").forEach((inp) => {
        const k = inp.dataset.k;
        if (k === "blur") inp.value = String(clamp(settings.blur, 0, 40));
        else if (k === "opacity") inp.value = String(Math.round(clamp(settings.opacity, 0.2, 1) * 100));
        else inp.value = String(Math.round(clamp(settings.overlay, 0, 0.9) * 100));
      });
      panelEl.querySelectorAll("select[data-s]").forEach((sel) => {
        const v = settings[sel.dataset.s];
        if (v !== undefined && v !== null) sel.value = String(v);
      });
      syncSliderVals();
    }
    function syncSliderVals() {
      if (!panelEl) return;
      panelEl.querySelectorAll("input[type=range]").forEach((inp) => {
        const val = inp.parentElement.querySelector(".val");
        if (!val) return;
        val.textContent = inp.dataset.k === "blur" ? inp.value + "px" : inp.value + "%";
      });
    }
    function updatePanelNow() {
      if (!panelEl) return;
      const now = panelEl.querySelector(".now");
      if (!now) return;
      if (currentCtx) {
        const label = currentCtx.kind === "video" ? "视频" :
          currentCtx.kind === "web" ? "网页" :
          currentCtx.kind === "scene" ? "场景(静态帧)" :
          currentCtx.kind === "image" ? "图片" : "未知";
        now.innerHTML = `当前：<b>${label}</b> · ${currentCtx.title || currentCtx.file || "—"}`;
      } else {
        now.textContent = "当前：未检测到壁纸（Wallpaper Engine 未激活或未读到）";
      }
    }

    // ---------------------------------------------------------------- 插件入口
    const inject = ["theme"];

    function apply(ctx) {
      const start = () => {
        try {
          ensureBgEl();
          buildUi(ctx);
          loadSettings();
          syncUi(ctx);
          renderLibrary(ctx);
          if (settings.enabled) {
            refresh(ctx, true).then(() => startPolling(ctx));
          } else {
            teardownWallpaper();
          }
        } catch (err) {
          console.error("[dsh-wallpaper-sync] 初始化失败:", err);
        }
      };
      if (document.body) start();
      else {
        document.addEventListener("DOMContentLoaded", () => start(), { once: true });
        setTimeout(() => { if (document.body) start(); }, 0);
      }

      ctx.effect(() => {
        return () => {
          stopPolling();
          wallpaperOverrideDispose?.();
          wallpaperOverrideDispose = null;
          teardownWallpaper();
          if (bgEl) bgEl.remove();
          if (panelEl) panelEl.remove();
          if (toggleEl) toggleEl.remove();
        };
      }, "dsh-wallpaper-sync");
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
