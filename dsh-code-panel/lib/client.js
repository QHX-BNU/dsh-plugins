// dsh-code-panel 客户端插件（浏览器 bundle，__ModuleLoader__ 格式）
// 在 Web 界面右侧（details 栏）提供代码显示区域：
//  - 「工作区文件」：懒加载浏览当前会话工作区（cwd）下的目录与文件（左侧树），
//    右侧语法高亮显示代码；
//  - 「我的代码」：显示 Agent 代码片段目录（data/code-panel/snippets/）下的文件；
//  - 在代码区选中文本（或未选中则整文件）后，「选到输入框」把代码放进会话的
//    主输入框（自动插入：选中即入框），由用户补充说明后自行发送；
//  - 会话标题行右上角（Session Log 旁）的「代码面板」按钮开关本面板；
//  - 监听 window 事件「dsh-code-panel:open-file」（其他插件 @ 文件选择触发）：
//    打开面板并把对应文件定位加载到内容区；「dsh-code-panel:probe」用于能力探测。
// 注意：React 19 的 jsx(type, props) 中 children 必须放进 props 对象。
window.__ModuleLoader__.load({
  id: "dsh-code-panel",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var react_jsx_runtime = require("react/jsx-runtime");
    var react = require("react");
    const { jsx, jsxs } = react_jsx_runtime;
    const { useState, useEffect, useRef, useCallback, useMemo } = react;

    // ---------------------------------------------------------------- 常量

    /** 面板开关状态（跨 details 条目与标题行按钮共享的模块级标志，带订阅通知）。 */
    const panelState = {
      open: false,
      listeners: new Set(),
      set(open) {
        if (panelState.open === open) return;
        panelState.open = open;
        for (const fn of panelState.listeners) {
          try {
            fn(open);
          } catch {
            /* 单个订阅者出错不影响其他订阅者 */
          }
        }
      },
      subscribe(fn) {
        panelState.listeners.add(fn);
        return () => panelState.listeners.delete(fn);
      },
    };

    /**
     * @菜单"打开文件"请求存储（跨 details 条目与面板挂载状态共享）：
     * 其他插件（如 dsh-skill-manager 的 @ 文件选择）通过
     * window "dsh-code-panel:open-file" 事件发起请求；事件监听器把请求
     * 写入这里并打开面板。CodePanel 挂载时订阅：已挂载则同步处理，
     * 未挂载（面板尚未打开）则在挂载后立即投递未消费的请求。
     * 每个请求带自增序号，订阅方按序号去重，避免重复打开。
     */
    const openRequests = {
      seq: 0,
      current: null,
      listeners: new Set(),
      request(detail) {
        const req = {
          root: String(detail.root || ""),
          rel: String(detail.rel || ""),
          name: String(detail.name || ""),
          seq: ++openRequests.seq,
        };
        openRequests.current = req;
        const listeners = [...openRequests.listeners];
        // 已有订阅者（面板已挂载）：派发即消费；否则保留为待投递请求
        if (listeners.length > 0) openRequests.current = null;
        for (const fn of listeners) {
          try {
            fn(req);
          } catch (err) {
            console.error("[dsh-code-panel] open-file listener failed:", err);
          }
        }
      },
      subscribe(fn) {
        openRequests.listeners.add(fn);
        const pending = openRequests.current;
        if (pending !== null) {
          openRequests.current = null; // 挂载时投递并消费，避免陈旧请求二次触发
          try {
            fn(pending);
          } catch (err) {
            console.error("[dsh-code-panel] open-file listener failed:", err);
          }
        }
        return () => openRequests.listeners.delete(fn);
      },
    };

    const FILE_ICON = "📄";
    const DIR_ICON = "📁";
    const EXT_ICONS = {
      js: "🟨", mjs: "🟨", cjs: "🟨", jsx: "🟨", ts: "🟦", tsx: "🟦",
      json: "🧾", css: "🎨", html: "🌐", md: "📝", py: "🐍", sql: "🗄️",
      ps1: "🟦", sh: "⚙️", yaml: "⚙️", yml: "⚙️", go: "🔵", rs: "🦀",
      java: "☕", c: "©️", cpp: "©️", cs: "🟣", rb: "💎", php: "🐘",
      lua: "🌙", r: "📊", kt: "🟠", swift: "🟠", dart: "🔷",
      png: "🖼️", apng: "🖼️", jpg: "🖼️", jpeg: "🖼️", gif: "🖼️", webp: "🖼️",
      bmp: "🖼️", svg: "🖼️", ico: "🖼️", avif: "🖼️", heic: "🖼️", heif: "🖼️",
      tif: "🖼️", tiff: "🖼️",
    };

    /** 可预览的图片扩展名（与服务端 api.js 的 IMAGE_MIME 保持同步）。 */
    const IMAGE_EXTS = new Set([
      "png", "apng", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico",
      "avif", "heic", "heif", "tif", "tiff",
    ]);

    const MAX_HIGHLIGHT_CHARS = 200000;
    const MAX_TOKENS = 50000;

    // ---------------------------------------------------------------- 高亮

    const KEYWORDS = {
      js: "abstract|arguments|as|async|await|boolean|break|case|catch|class|const|continue|debugger|declare|default|delete|do|else|enum|export|extends|false|finally|for|from|function|get|if|implements|import|in|infer|instanceof|interface|is|keyof|let|namespace|new|null|of|package|private|protected|public|readonly|require|return|satisfies|set|static|super|switch|this|throw|true|try|type|typeof|undefined|var|void|while|with|yield",
      python: "False|None|True|and|as|assert|async|await|break|class|continue|def|del|elif|else|except|finally|for|from|global|if|import|in|is|lambda|nonlocal|not|or|pass|raise|return|self|try|while|with|yield",
      shell: "alias|case|do|done|echo|elif|else|esac|exit|export|fi|for|function|if|in|local|readonly|return|select|set|shift|source|then|true|false|null|unset|until|while",
      powershell: "add|and|begin|break|catch|class|continue|default|do|else|elseif|end|enum|exit|filter|foreach|foreach-object|for|function|get|if|in|measure|module|new|not|or|out|param|process|remove|return|script|select|set|sort|switch|throw|try|until|using|where|where-object|while|workflow|write|true|false|null",
      sql: "add|all|alter|and|as|asc|begin|between|by|case|check|column|commit|constraint|create|cursor|database|declare|default|delete|desc|distinct|drop|else|end|exec|execute|exists|fetch|for|foreign|from|grant|group|having|if|in|index|inner|insert|into|is|join|key|left|like|limit|loop|not|null|offset|on|or|order|outer|primary|procedure|references|revoke|right|rollback|select|set|table|then|trigger|union|unique|update|values|view|when|where|while",
      html: "a|article|aside|audio|b|blockquote|body|br|button|canvas|code|datalist|details|dialog|div|em|embed|fieldset|figcaption|figure|footer|form|h1|h2|h3|h4|h5|h6|head|header|hr|html|i|iframe|img|input|label|legend|li|link|main|map|meta|nav|object|ol|optgroup|option|p|param|picture|pre|script|section|select|slot|source|span|strong|style|summary|svg|table|tbody|td|template|textarea|tfoot|th|thead|title|tr|track|u|ul|video",
      css: "absolute|active|auto|baseline|before|block|center|column|currentColor|dashed|default|dotted|fixed|flex-end|flex-start|flex|grid|hidden|hover|important|inherit|initial|inline-block|inline|last-child|left|middle|none|nowrap|nth-child|pointer|relative|right|solid|space-around|space-between|space-evenly|static|sticky|stretch|top|transparent|unset|visited|visible|wrap|first-child|after",
      yaml: "true|false|null|yes|no|on|off|and|or|not",
      go: "break|case|chan|const|continue|default|defer|else|fallthrough|for|func|go|goto|if|import|interface|map|package|range|return|select|struct|switch|type|var|true|false|nil",
      rust: "as|async|await|break|const|continue|crate|dyn|else|enum|extern|false|fn|for|if|impl|in|let|loop|match|mod|move|mut|pub|ref|return|self|Self|static|struct|super|trait|true|type|unsafe|use|where|while",
      java: "abstract|boolean|break|byte|case|catch|char|class|const|continue|default|do|double|else|enum|extends|final|finally|float|for|goto|if|implements|import|instanceof|int|interface|long|native|new|null|package|private|protected|public|return|short|static|strictfp|super|switch|synchronized|this|throw|throws|transient|try|void|volatile|while|true|false|var|record|sealed|permits|yield",
      csharp: "abstract|as|base|bool|break|byte|case|catch|char|checked|class|const|continue|decimal|default|delegate|do|double|else|enum|event|explicit|extern|false|finally|fixed|float|for|foreach|goto|if|implicit|in|int|interface|internal|is|lock|long|namespace|new|null|object|operator|out|override|params|private|protected|public|readonly|record|ref|return|sbyte|sealed|short|sizeof|stackalloc|static|string|struct|switch|this|throw|true|try|typeof|uint|ulong|unchecked|unsafe|ushort|using|var|virtual|void|volatile|while|async|await|get|set|init|required|file|global",
      c: "auto|break|case|char|const|continue|default|do|double|else|enum|extern|float|for|goto|if|inline|int|long|register|restrict|return|short|signed|sizeof|static|struct|switch|typedef|union|unsigned|void|volatile|while|true|false|bool|null",
      cpp: "alignas|alignof|and|asm|auto|bitand|bitor|bool|break|case|catch|char|class|compl|concept|const|consteval|constexpr|constinit|const_cast|continue|co_await|co_return|co_yield|decltype|default|delete|do|double|dynamic_cast|else|enum|explicit|export|extern|false|float|for|friend|goto|if|inline|int|long|mutable|namespace|new|noexcept|not|nullptr|operator|or|private|protected|public|register|reinterpret_cast|requires|return|short|signed|sizeof|static|static_assert|static_cast|struct|switch|template|this|thread_local|throw|true|try|typedef|typeid|typename|union|unsigned|using|virtual|void|volatile|wchar_t|while|xor",
      ruby: "BEGIN|END|alias|and|begin|break|case|class|def|defined|do|else|elsif|end|ensure|false|for|if|in|module|next|nil|not|or|redo|rescue|retry|return|self|super|then|true|undef|unless|until|when|while|yield",
      php: "abstract|and|array|as|break|callable|case|catch|class|clone|const|continue|declare|default|die|do|echo|else|elseif|empty|enddeclare|endfor|endforeach|endif|endswitch|endwhile|enum|eval|exit|extends|final|finally|fn|for|foreach|function|global|goto|if|implements|include|instanceof|insteadof|interface|isset|list|match|namespace|new|or|print|private|protected|public|readonly|require|return|static|switch|throw|trait|try|unset|use|var|while|xor|yield|true|false|null",
      kotlin: "as|break|class|continue|do|else|false|for|fun|if|in|interface|is|null|object|package|return|super|this|throw|true|try|typealias|typeof|val|var|when|while|by|catch|constructor|delegate|dynamic|field|file|finally|get|import|init|param|property|receiver|set|setparam|where|actual|abstract|annotation|companion|const|crossinline|data|enum|expect|external|final|infix|inline|inner|internal|lateinit|noinline|open|operator|out|override|private|protected|public|reified|sealed|suspend|tailrec|vararg",
      swift: "associatedtype|class|deinit|enum|extension|fileprivate|func|import|init|inout|internal|let|open|operator|private|protocol|public|rethrows|static|struct|subscript|typealias|var|break|case|catch|continue|default|defer|do|else|fallthrough|for|guard|if|in|repeat|return|throw|switch|where|while|as|Any|false|is|nil|self|Self|super|throws|true|try",
      scala: "abstract|case|catch|class|def|do|else|extends|final|finally|for|forSome|if|implicit|import|lazy|match|new|null|object|override|package|private|protected|return|sealed|super|this|throw|trait|try|type|val|var|while|with|yield|true|false",
      lua: "and|break|do|else|elseif|end|false|for|function|goto|if|in|local|nil|not|or|repeat|return|then|true|until|while",
      r: "if|else|repeat|while|function|for|in|next|break|TRUE|FALSE|NULL|Inf|NaN|NA|return|require|library|source|setwd|install.packages",
      dart: "abstract|as|assert|async|await|break|case|catch|class|const|continue|covariant|default|deferred|do|dynamic|else|enum|export|extends|extension|external|factory|false|final|finally|for|Function|get|hide|if|implements|import|in|interface|is|late|library|mixin|new|null|on|operator|part|required|rethrow|return|sealed|set|show|static|super|switch|sync|this|throw|true|try|typedef|var|void|while|with|yield",
      groovy: "abstract|as|assert|boolean|break|byte|case|catch|char|class|const|continue|def|default|do|double|else|enum|extends|final|finally|float|for|goto|if|implements|import|in|instanceof|int|interface|long|native|new|package|private|protected|public|return|short|static|strictfp|super|switch|synchronized|this|throw|throws|trait|transient|try|void|volatile|while|true|false|null",
      dockerfile: "FROM|RUN|CMD|LABEL|MAINTAINER|EXPOSE|ENV|ADD|COPY|ENTRYPOINT|VOLUME|USER|WORKDIR|ARG|ONBUILD|STOPSIGNAL|HEALTHCHECK|SHELL",
      makefile: ".PHONY|all|clean|install|build|test|run|ifeq|ifneq|ifdef|ifndef|else|endif|include|define|endef|export|unexport|override",
    };

    const COMMENT_RE = {
      js: "\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/",
      python: "#[^\\n]*",
      shell: "#[^\\n]*",
      powershell: "#[^\\n]*",
      sql: "--[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/",
      html: "<!--[\\s\\S]*?-->",
      css: "\\/\\*[\\s\\S]*?\\*\\/",
      yaml: "#[^\\n]*",
      ruby: "#[^\\n]*",
      php: "\\/\\/[^\\n]*|#[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/",
      go: "\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/",
      rust: "\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/",
      lua: "--[^\\n]*|--\\[\\[[\\s\\S]*?\\]\\]",
      r: "#[^\\n]*",
      scala: "\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/",
      groovy: "\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/",
      kotlin: "\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/",
      swift: "\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/",
      c: "\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/",
      cpp: "\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/",
      csharp: "\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/",
      java: "\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/",
      dart: "\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/",
    };

    const STRING_RE_DEFAULT = "\"(?:[^\"\\\\\\n]|\\\\.)*\"|'(?:[^'\\\\\\n]|\\\\.)*'";
    const STRING_RE = {
      python: "\"\"\"(?:[^\"\\\\]|\\\\.)*?\"\"\"|'''(?:[^'\\\\]|\\\\.)*?'''|" + STRING_RE_DEFAULT,
      shell: STRING_RE_DEFAULT + "|`[^`\\n]*`",
      js: STRING_RE_DEFAULT + "|`(?:[^`\\\\]|\\\\.)*`",
      sql: STRING_RE_DEFAULT,
      html: STRING_RE_DEFAULT,
      css: STRING_RE_DEFAULT,
      yaml: STRING_RE_DEFAULT,
      r: STRING_RE_DEFAULT,
      powershell: STRING_RE_DEFAULT,
      go: STRING_RE_DEFAULT + "|`[^`\\n]*`",
      rust: STRING_RE_DEFAULT + "|r#\"[\\s\\S]*?\"#",
      lua: STRING_RE_DEFAULT + "|\\[\\[[\\s\\S]*?\\]\\]",
      ruby: STRING_RE_DEFAULT + "|%[qQwWr](\\[|\\{|\\()(?:[^\\]\\}\\)\\\\]|\\\\.)*?(\\]|\\}|\\))",
    };

    const NUMBER_RE = "\\b(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)\\b";
    const FUNC_RE = "\\b[A-Za-z_$][A-Za-z0-9_$]*(?=\\s*\\()";
    const TYPE_RE = "\\b[A-Z][A-Za-z0-9_]*\\b";

    const FUNC_LANGS = new Set([
      "js", "ts", "jsx", "tsx", "python", "go", "rust", "java", "c", "cpp", "csharp",
      "ruby", "php", "kotlin", "swift", "scala", "lua", "r", "dart", "groovy",
      "powershell", "shell",
    ]);
    const TYPE_LANGS = new Set([
      "ts", "tsx", "java", "c", "cpp", "csharp", "go", "rust", "kotlin", "swift",
      "scala", "dart", "groovy", "js",
    ]);

    /** 构造某语言的正则与分组名。diff 单独处理。 */
    function makeSpec(lang) {
      const groups = [];
      const parts = [];
      const add = (cls, src) => {
        groups.push(cls);
        parts.push(src);
      };
      const comment = COMMENT_RE[lang];
      if (comment) add("comment", comment);
      add("string", STRING_RE[lang] || STRING_RE_DEFAULT);
      add("number", NUMBER_RE);
      const kw = KEYWORDS[lang];
      if (kw) add("keyword", "\\b(?:" + kw + ")\\b");
      if (FUNC_LANGS.has(lang)) add("func", FUNC_RE);
      if (TYPE_LANGS.has(lang)) add("type", TYPE_RE);
      if (parts.length === 0) return null;
      return { re: new RegExp(parts.map((p) => "(" + p + ")").join("|"), "gm"), groups };
    }

    const SPEC_CACHE = new Map();
    function specOf(lang) {
      if (!SPEC_CACHE.has(lang)) SPEC_CACHE.set(lang, makeSpec(lang));
      return SPEC_CACHE.get(lang);
    }

    /**
     * 把代码切成带类名的 token，再按行拆分。
     * 返回 lines: Array<Array<{text, cls}>>；超大/超量时返回 null（纯文本渲染）。
     */
    function tokenize(code, lang) {
      if (code.length > MAX_HIGHLIGHT_CHARS) return null;
      const spec = specOf(lang);
      if (spec === null) return null;
      const re = spec.re;
      re.lastIndex = 0;
      const tokens = [];
      let last = 0;
      let count = 0;
      let m;
      while ((m = re.exec(code)) !== null) {
        if (m.index > last) tokens.push({ text: code.slice(last, m.index), cls: "" });
        let cls = "";
        for (let i = 1; i < m.length; i++) {
          if (m[i] !== undefined) {
            cls = spec.groups[i - 1];
            break;
          }
        }
        tokens.push({ text: m[0], cls });
        last = m.index + m[0].length;
        if (++count > MAX_TOKENS) return null;
        if (m[0].length === 0) re.lastIndex += 1;
      }
      if (last < code.length) tokens.push({ text: code.slice(last), cls: "" });
      const lines = [];
      let cur = [];
      for (const tok of tokens) {
        const parts = tok.text.split("\n");
        for (let i = 0; i < parts.length; i++) {
          if (i > 0) {
            lines.push(cur);
            cur = [];
          }
          if (parts[i] !== "") cur.push({ text: parts[i], cls: tok.cls });
        }
      }
      if (cur.length > 0 || lines.length === 0) lines.push(cur);
      return lines;
    }

    /** diff 按行分类。 */
    function diffLines(code) {
      const out = [];
      const raw = code.split("\n");
      for (const line of raw) {
        if (line.startsWith("@@")) out.push([{ text: line, cls: "meta" }]);
        else if (line.startsWith("+")) out.push([{ text: line, cls: "ins" }]);
        else if (line.startsWith("-")) out.push([{ text: line, cls: "del" }]);
        else if (line.startsWith("diff --git") || line.startsWith("Index:")) out.push([{ text: line, cls: "meta" }]);
        else out.push([{ text: line, cls: "" }]);
      }
      return out;
    }

    // ---------------------------------------------------------------- 工具

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
          err.payload = data || null;
          throw err;
        }
        return data;
      }).catch((err) => {
        // 服务端返回的业务错误直接透传；网络层失败给出友好提示
        if (err && err.code) throw err;
        const e = new Error("无法连接代码面板服务：" + (err && err.message ? err.message : String(err)));
        e.code = "network";
        throw e;
      });
    }

    /** 判断文件名是否为可预览图片（按扩展名）。 */
    function isImageName(name) {
      return IMAGE_EXTS.has(extOf(name));
    }

    /**
     * 加载图片预览地址：图片接口返回二进制（image/*），错误时返回 JSON。
     * 成功返回 { url, size }；失败抛出带信息的 Error。
     */
    async function loadImageUrl(url) {
      let res;
      try {
        res = await fetch(url);
      } catch (err) {
        throw new Error("无法加载图片：" + (err && err.message ? err.message : String(err)));
      }
      const contentType = res.headers.get("content-type") || "";
      if (res.ok && contentType.startsWith("image/")) {
        const size = Number(res.headers.get("content-length")) || 0;
        return { url, size };
      }
      let data = null;
      try {
        data = await res.json();
      } catch {
        /* 非 JSON 响应 */
      }
      if (data && data.ok === false) {
        throw new Error((data && data.message) || (data && data.error) || "加载图片失败");
      }
      throw new Error("加载图片失败（HTTP " + res.status + "）");
    }

    function qs(params) {
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
      }
      return p.toString();
    }

    function basenameOf(p) {
      if (!p) return "";
      const parts = String(p).split(/[/\\]+/).filter(Boolean);
      return parts.length > 0 ? parts[parts.length - 1] : p;
    }

    function fmtBytes(n) {
      if (n == null) return "";
      if (n < 1024) return n + " B";
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
      return (n / (1024 * 1024)).toFixed(1) + " MB";
    }

    function extOf(name) {
      const dot = name.lastIndexOf(".");
      if (dot <= 0) return "";
      return name.slice(dot + 1).toLowerCase();
    }

    function iconOf(name, dir) {
      if (dir) return DIR_ICON;
      return EXT_ICONS[extOf(name)] || FILE_ICON;
    }

    /** 工作区相对路径 → 绝对路径（与 runtime 的 resolveWorkspacePath 一致）。 */
    function resolveAbs(root, rel) {
      if (!rel) return root || "";
      if (rel.startsWith("/") || /^[A-Za-z]:[/\\]/.test(rel) || rel.startsWith("\\\\")) return rel;
      return (root ? root.replace(/[/\\]+$/, "") : "") + "/" + rel.replace(/^[/\\]+/, "");
    }

    /** 构建插入输入框的代码块文本（带围栏与来源说明）。 */
    function buildCodeBlock(rel, lang, code, sourceLabel) {
      const fence = (lang && lang !== "text" ? lang : "");
      const backticks = code.includes("```") ? "````" : "```";
      return "来自 " + (sourceLabel || rel) + "：\n" + backticks + fence + "\n" + code + "\n" + backticks;
    }

    // ---------------------------------------------------------------- 样式

    const css = `
.dsh-code-panel{display:flex;flex-direction:column;min-width:0;height:100%;background:var(--dsw-alias-bg-base);font-size:13px}
.dsh-code-panel *{box-sizing:border-box}
.dsh-code-head{display:flex;align-items:center;gap:8px;height:40px;padding:0 10px 0 14px;flex:none;border-bottom:1px solid var(--dsw-alias-border-l2)}
.dsh-code-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-code-close{width:26px;height:26px;border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:14px;line-height:1;flex:none}
.dsh-code-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-code-tabs{display:flex;gap:2px;padding:6px 10px 0;flex:none}
.dsh-code-tab{border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;height:28px;padding:0 12px;border-radius:8px 8px 0 0;cursor:pointer;border-bottom:2px solid transparent}
.dsh-code-tab:hover{color:var(--dsw-alias-label-primary)}
.dsh-code-tab-active{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-brand-primary);font-weight:600}
.dsh-code-body{display:flex;flex:1;min-height:0}
.dsh-code-side{width:38%;min-width:130px;max-width:240px;flex:none;display:flex;flex-direction:column;min-height:0;border-right:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}
.dsh-code-path{display:flex;align-items:center;gap:6px;padding:4px 8px 4px 10px;font-size:11px;color:var(--dsw-alias-label-tertiary);min-width:0;flex:none;border-bottom:1px solid var(--dsw-alias-border-l1)}
.dsh-code-path-name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0}
.dsh-code-refresh{border:none;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:11px;padding:2px 6px;border-radius:6px;flex:none}
.dsh-code-refresh:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-code-tree{flex:1;min-height:0;overflow:auto;padding:4px 4px 8px}
.dsh-code-tree::-webkit-scrollbar{width:8px}
.dsh-code-tree::-webkit-scrollbar-thumb{background:var(--dsw-alias-scrollbar-bg-l2);border-radius:4px}
.dsh-code-row{display:flex;align-items:center;gap:4px;width:100%;text-align:left;background:transparent;border:none;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;height:24px;padding:0 6px;border-radius:6px;cursor:pointer;white-space:nowrap;min-width:0}
.dsh-code-row:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-code-row-dir{color:var(--dsw-alias-label-primary)}
.dsh-code-row-selected{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-code-row-caret{width:12px;flex:none;font-size:9px;color:var(--dsw-alias-label-tertiary)}
.dsh-code-row-icon{width:16px;flex:none;font-size:11px;text-align:center}
.dsh-code-row-name{overflow:hidden;text-overflow:ellipsis;min-width:0}
.dsh-code-row-size{margin-left:auto;flex:none;font-size:10px;color:var(--dsw-alias-label-caption);padding-left:6px}
.dsh-code-snippets{flex:1;min-height:0;overflow:auto;padding:6px}
.dsh-code-snippets::-webkit-scrollbar{width:8px}
.dsh-code-snippets::-webkit-scrollbar-thumb{background:var(--dsw-alias-scrollbar-bg-l2);border-radius:4px}
.dsh-code-snippet-btn{display:flex;align-items:center;gap:8px;width:100%;text-align:left;background:transparent;border:none;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;height:30px;padding:0 8px;border-radius:8px;cursor:pointer}
.dsh-code-snippet-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-code-snippet-btn-selected{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-code-snippet-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.dsh-code-snippet-size{margin-left:auto;flex:none;font-size:10px;color:var(--dsw-alias-label-caption)}
.dsh-code-snippet-hint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.7;padding:4px 8px}
.dsh-code-view{flex:1;min-width:0;display:flex;flex-direction:column;min-height:0}
.dsh-code-filebar{display:flex;align-items:center;gap:6px;padding:5px 12px;font-size:11px;color:var(--dsw-alias-label-tertiary);border-bottom:1px solid var(--dsw-alias-border-l2);flex:none;min-width:0}
.dsh-code-filebar-name{font-weight:600;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.dsh-code-filebar-meta{flex:none}
.dsh-code-scroll{flex:1;min-height:0;overflow:auto;margin:0;background:var(--dsw-alias-bg-layer-2)}
.dsh-code-scroll::-webkit-scrollbar{width:8px;height:8px}
.dsh-code-scroll::-webkit-scrollbar-thumb{background:var(--dsw-alias-scrollbar-bg-l2);border-radius:4px}
.dsh-code-pre{display:block;padding:8px 0;margin:0;font-family:"Cascadia Code","JetBrains Mono","Fira Code",Consolas,Menlo,monospace;font-size:12px;line-height:1.6;tab-size:4;-moz-tab-size:4}
.dsh-code-line{display:flex;min-width:100%}
.dsh-code-line:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-code-gutter{flex:none;width:44px;padding-right:10px;text-align:right;color:var(--dsw-alias-label-caption);user-select:none;font-size:11px;line-height:1.6;background:var(--dsw-alias-bg-layer-3);position:sticky;left:0}
.dsh-code-linecode{white-space:pre;min-width:0}
.dsh-code-tok{white-space:pre}
.tok-comment{color:#008000;font-style:italic}
.tok-string{color:#a31515}
.tok-number{color:#098658}
.tok-keyword{color:#0000ff}
.tok-func{color:#795e26}
.tok-type{color:#267f99}
.tok-ins{color:#0a7a0a}
.tok-del{color:#c41e1e}
.tok-meta{color:#0a4d9e;font-weight:600}
body[data-ds-dark-theme] .tok-comment{color:#6a9955}
body[data-ds-dark-theme] .tok-string{color:#ce9178}
body[data-ds-dark-theme] .tok-number{color:#b5cea8}
body[data-ds-dark-theme] .tok-keyword{color:#569cd6}
body[data-ds-dark-theme] .tok-func{color:#dcdcaa}
body[data-ds-dark-theme] .tok-type{color:#4ec9b0}
body[data-ds-dark-theme] .tok-ins{color:#89d185}
body[data-ds-dark-theme] .tok-del{color:#f48771}
body[data-ds-dark-theme] .tok-meta{color:#9cdcfe}
.dsh-code-empty{flex:1;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary);font-size:12px;padding:24px;text-align:center}
.dsh-code-error{flex:1;color:var(--dsw-alias-label-error);font-size:12px;padding:12px 14px;line-height:1.6}
.dsh-code-loading{flex:1;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary);font-size:12px;padding:24px}
/* 图片预览：居中展示、可滚动、自适应缩放 */
.dsh-code-image-wrap{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;align-items:center;justify-content:flex-start;gap:8px;padding:16px;background:var(--dsw-alias-bg-layer-2)}
.dsh-code-image-wrap::-webkit-scrollbar{width:8px;height:8px}
.dsh-code-image-wrap::-webkit-scrollbar-thumb{background:var(--dsw-alias-scrollbar-bg-l2);border-radius:4px}
.dsh-code-image{max-width:100%;max-height:calc(100% - 34px);object-fit:contain;border-radius:8px;box-shadow:var(--dsw-shadow-lv1)}
.dsh-code-image-meta{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dsh-code-foot{flex:none;display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:8px 10px;border-top:1px solid var(--dsw-alias-border-l2)}
.dsh-code-selinfo{font-size:11px;color:var(--dsw-alias-label-tertiary);flex:1;min-width:80px}
.dsh-code-btn{font:inherit;font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;height:28px;padding:0 10px;cursor:pointer;white-space:nowrap}
.dsh-code-btn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary)}
.dsh-code-btn:disabled{opacity:.45;cursor:default}
.dsh-code-btn-primary{background:var(--dsw-static-neutral-bluish-1000, #1d2b4f);border-color:var(--dsw-static-neutral-bluish-1000, #1d2b4f);color:#ffffff}
.dsh-code-btn-primary:hover:not(:disabled){filter:brightness(1.15)}
.dsh-code-status{flex-basis:100%;font-size:11px;color:var(--dsw-alias-label-tertiary);min-height:14px}
.dsh-code-status-ok{color:var(--dsw-alias-state-success-primary)}
.dsh-code-status-err{color:var(--dsw-alias-label-error)}
/* 浮动确认按钮：深浅主题都用深底白字，避免深色主题下 brand-primary 变浅导致文字不可见 */
.dsh-code-float-btn{position:fixed;z-index:2000;font:inherit;font-size:12px;font-weight:600;color:#ffffff;background:var(--dsw-static-neutral-bluish-1000, #1d2b4f);border:1px solid var(--dsw-static-neutral-bluish-1000, #1d2b4f);border-radius:10px;height:32px;padding:0 14px;cursor:pointer;white-space:nowrap;box-shadow:var(--dsw-shadow-lv3)}
.dsh-code-float-btn:hover{filter:brightness(1.15)}
.dsh-code-float-btn:active{filter:brightness(.95)}
.dsh-code-header-btn{display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);border-radius:8px;font:inherit;font-size:12px;cursor:pointer;flex:none}
.dsh-code-header-btn:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary)}
.dsh-code-header-btn-on{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
`;

    function ensureCss() {
      const tagId = "dsh-code-panel/style.css";
      if (typeof document !== "undefined" && document.querySelector('style[data-plugin-css="' + tagId + '"]') === null) {
        const tag = document.createElement("style");
        tag.dataset.plugin = "dsh-code-panel";
        tag.dataset.pluginCss = tagId;
        tag.textContent = css;
        document.head.appendChild(tag);
      }
    }

    // ---------------------------------------------------------------- 代码视图

    /**
     * 代码视图：行号 + 高亮 + 选中文本与选区位置上报。
     * props: { content, lang, onSelection(text, rect) } rect 为选区视口矩形或 null。
     */
    function CodeView(props) {
      const { content, lang, onSelection } = props;
      const containerRef = useRef(null);

      const lines = useMemo(() => {
        if (!content) return [];
        if (lang === "diff") return diffLines(content);
        const tokenized = tokenize(content, lang);
        if (tokenized !== null) return tokenized;
        return content.split("\n").map((line) => [{ text: line, cls: "" }]);
      }, [content, lang]);

      // 选区上报（mouseup + selectionchange 节流；滚动时重算位置）
      useEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        let raf = null;
        const read = () => {
          raf = null;
          const sel = window.getSelection();
          let text = "";
          let rect = null;
          if (sel && sel.toString()) {
            const anchor = sel.anchorNode;
            const focus = sel.focusNode;
            if (anchor && focus && (el.contains(anchor) || el.contains(focus))) {
              text = sel.toString();
              try {
                if (sel.rangeCount > 0 && !sel.getRangeAt(0).collapsed) {
                  rect = sel.getRangeAt(0).getBoundingClientRect();
                }
              } catch {
                rect = null;
              }
            }
          }
          onSelection(text, rect);
        };
        const schedule = () => {
          if (raf !== null) return;
          raf = requestAnimationFrame(read);
        };
        el.addEventListener("mouseup", schedule);
        el.addEventListener("scroll", schedule, { passive: true });
        document.addEventListener("selectionchange", schedule);
        return () => {
          if (raf !== null) cancelAnimationFrame(raf);
          el.removeEventListener("mouseup", schedule);
          el.removeEventListener("scroll", schedule);
          document.removeEventListener("selectionchange", schedule);
        };
      }, [content, onSelection]);

      const lineCount = lines.length;
      const gutterWidth = lineCount >= 10000 ? 58 : lineCount >= 1000 ? 50 : 44;

      return jsx("div", {
        ref: containerRef,
        className: "dsh-code-scroll",
        children: jsx("pre", {
          className: "dsh-code-pre",
          children: lines.map((tokens, idx) => {
            const gutter = String(idx + 1).padStart(String(lineCount).length, " ");
            return jsxs("div", {
              className: "dsh-code-line",
              key: idx,
              children: [
                jsx("span", {
                  className: "dsh-code-gutter",
                  style: { width: gutterWidth + "px" },
                  children: gutter,
                }),
                jsx("span", {
                  className: "dsh-code-linecode",
                  children: tokens.map((tok, ti) =>
                    tok.cls
                      ? jsx("span", { key: ti, className: "dsh-code-tok tok-" + tok.cls, children: tok.text })
                      : jsx("span", { key: ti, className: "dsh-code-tok", children: tok.text }),
                  ),
                }),
              ],
            });
          }),
        }),
      });
    }

    // ---------------------------------------------------------------- 代码面板

    function CodePanel(props) {
      const { useSessions, sessionId, closeDetails, input, openPath } = props;
      const cwd = useSessions((s) => (s && s.byId ? s.byId[sessionId]?.cwd : undefined));

      const [tab, setTab] = useState("workspace");
      // 文件树：rel -> { expanded, loaded, entries }
      const [tree, setTree] = useState({});
      const [selFile, setSelFile] = useState(null); // {rel, name, lang}
      const [snippets, setSnippets] = useState(null); // {dir, items}
      const [selSnippet, setSelSnippet] = useState(null);
      // 内容区：{status: 'idle'|'loading'|'ok'|'error', data?, error?}
      const [contentState, setContentState] = useState({ status: "idle" });
      // 当前选中：{text, rect} | null（rect 为选区视口矩形，用于浮动确认按钮定位）
      const [selInfo, setSelInfo] = useState(null);
      const [status, setStatus] = useState(""); // 操作反馈
      const [statusKind, setStatusKind] = useState("");

      const mountedRef = useRef(true);
      useEffect(() => () => { mountedRef.current = false; }, []);
      // 面板卸载（切会话等）时复位开关；HeaderToggle 通过订阅保持同步
      useEffect(() => () => { panelState.set(false); }, []);

      const safeSet = useCallback((fn) => {
        if (mountedRef.current) fn();
      }, []);

      const loadDir = useCallback(async (root, rel) => {
        const data = await apiFetch("/code-panel/api/list?" + qs({ root, rel }));
        if (!mountedRef.current) return;
        setTree((prev) => ({
          ...prev,
          [rel]: { expanded: prev[rel] ? prev[rel].expanded : true, loaded: true, entries: data.entries || [] },
        }));
      }, []);

      // 切换工作区时重置树与选中，并自动加载根目录
      useEffect(() => {
        setTree({});
        setSelFile(null);
        setSelInfo(null);
        setContentState({ status: "idle" });
        if (cwd) {
          setTree((prev) => ({ ...prev, "": { expanded: true, loaded: false, entries: [] } }));
          loadDir(cwd, "").catch(() => {});
        }
      }, [cwd, loadDir]);

      const onDirClick = useCallback((root, rel, expanded, loaded) => {
        if (!loaded) {
          loadDir(root, rel).catch((err) => {
            if (mountedRef.current) {
              setStatus(err.message);
              setStatusKind("err");
            }
          });
        }
        setTree((prev) => ({
          ...prev,
          [rel]: { ...(prev[rel] || { entries: [] }), expanded: !expanded },
        }));
      }, [loadDir]);

      const onFileClick = useCallback(async (root, rel, name) => {
        safeSet(() => {
          setSelFile({ rel, name, lang: extOf(name) });
          setSelSnippet(null);
          setSelInfo(null);
        });
        safeSet(() => setContentState({ status: "loading" }));
        try {
          if (isImageName(name)) {
            // 图片：走二进制预览接口，内容区渲染 <img>
            const { url, size } = await loadImageUrl("/code-panel/api/image?" + qs({ root, rel }));
            safeSet(() => {
              setSelFile({ rel, name, lang: "image" });
              setContentState({ status: "ok", data: { kind: "image", url, name, rel, size, lang: "image" } });
            });
            return;
          }
          const data = await apiFetch("/code-panel/api/read?" + qs({ root, rel }));
          safeSet(() => {
            setSelFile({ rel, name, lang: data.lang || extOf(name) });
            setContentState({ status: "ok", data });
          });
        } catch (err) {
          safeSet(() => {
            if (err.code === "binary" || err.code === "file-too-large") {
              setContentState({ status: "error", error: err.message || err.code, payload: err.payload || null });
            } else {
              setContentState({ status: "error", error: err.message });
            }
          });
        }
      }, [safeSet]);

      // @ 菜单"打开文件"：cwd 的实时引用（异步加载过程中校验会话是否切换）
      const cwdRef = useRef(cwd);
      useEffect(() => { cwdRef.current = cwd; }, [cwd]);

      /** 按 @ 菜单请求打开文件：展开祖先目录链 → 选中并加载文件内容。 */
      const openFileAt = useCallback(async (root, rel, name) => {
        if (!root || !rel || !name) return;
        const norm = (p) => String(p || "").replace(/[/\\]+$/, "").toLowerCase();
        const expectRoot = norm(root);
        setTab("workspace");
        safeSet(() => setSelInfo(null));
        // 逐级加载祖先目录（懒加载文件树需要各级目录都有条目才能渲染）
        const parts = rel.split("/").filter(Boolean);
        const dirs = [""];
        let acc = "";
        for (let i = 0; i < parts.length - 1; i++) {
          acc = acc ? acc + "/" + parts[i] : parts[i];
          dirs.push(acc);
        }
        for (const d of dirs) {
          if (!mountedRef.current || norm(cwdRef.current) !== expectRoot) return; // 会话已切换则放弃
          safeSet(() => setTree((prev) => ({
            ...prev,
            [d]: { ...(prev[d] || { expanded: true, loaded: false, entries: [] }), expanded: true },
          })));
          try {
            await loadDir(root, d);
          } catch (err) {
            // 单个目录加载失败（权限/删除等）不阻断后续步骤
          }
        }
        if (!mountedRef.current || norm(cwdRef.current) !== expectRoot) return;
        onFileClick(root, rel, name);
      }, [loadDir, onFileClick, safeSet]);

      // 订阅 @ 菜单打开请求：序号去重；cwd 与请求 root 不一致（其他工作区）时忽略
      const lastOpenSeqRef = useRef(0);
      useEffect(() => openRequests.subscribe((req) => {
        if (!req || req.seq === lastOpenSeqRef.current) return;
        lastOpenSeqRef.current = req.seq;
        const cur = cwdRef.current;
        if (!cur) return;
        const norm = (p) => String(p || "").replace(/[/\\]+$/, "").toLowerCase();
        if (norm(cur) !== norm(req.root)) return;
        void openFileAt(req.root, req.rel, req.name);
      }), [openFileAt]);

      const loadSnippets = useCallback(async () => {
        try {
          const data = await apiFetch("/code-panel/api/snippets");
          safeSet(() => setSnippets({ dir: data.dir, items: data.snippets || [] }));
        } catch (err) {
          safeSet(() => setStatus(err.message));
        }
      }, [safeSet]);

      useEffect(() => {
        if (tab === "snippets" && snippets === null) loadSnippets();
      }, [tab, snippets, loadSnippets]);

      const onSnippetClick = useCallback(async (item) => {
        safeSet(() => {
          setSelSnippet(item);
          setSelFile(null);
          setSelInfo(null);
        });
        safeSet(() => setContentState({ status: "loading" }));
        try {
          if (isImageName(item.name)) {
            // 图片片段：走二进制预览接口
            const { url, size } = await loadImageUrl("/code-panel/api/snippets/image?" + qs({ name: item.name }));
            safeSet(() => {
              setSelSnippet({ ...item, lang: "image" });
              setContentState({ status: "ok", data: { kind: "image", url, name: item.name, rel: item.name, size, lang: "image" } });
            });
            return;
          }
          const data = await apiFetch("/code-panel/api/snippets/read?" + qs({ name: item.name }));
          safeSet(() => {
            setSelSnippet({ ...item, lang: data.lang });
            setContentState({ status: "ok", data });
          });
        } catch (err) {
          safeSet(() => setContentState({ status: "error", error: err.message }));
        }
      }, [safeSet]);

      // 当前内容信息
      const activeContent = contentState.status === "ok" ? contentState.data.content : "";
      const activeLang = contentState.status === "ok" ? (contentState.data.lang || "text") : "text";
      const activeRel = selSnippet ? selSnippet.name : selFile ? selFile.rel : "";
      const sourceLabel = selSnippet ? "我的代码/" + selSnippet.name : selFile ? "工作区/" + selFile.rel : "";
      // 图片预览模式：不能作为代码引用
      const isImageView = contentState.status === "ok" && contentState.data.kind === "image";
      const hasContent = contentState.status === "ok" && !isImageView && activeContent.length > 0;

      // 访问会话主输入框（input 可能是惰性 getter：conversation 服务可能晚于
      // 面板注册就绪，不能在校验时刻固化）
      const inputShell = useCallback(() => {
        try {
          const resolved = typeof input === "function" ? input() : input;
          if (!resolved) return null;
          return resolved.shell(sessionId);
        } catch {
          return null;
        }
      }, [input, sessionId]);

      /** 把文本插入会话主输入框（追加到末尾；输入框为空则直接填入）。 */
      const insertToInput = useCallback((text) => {
        if (!text || !text.trim()) return false;
        const shell = inputShell();
        if (!shell) {
          safeSet(() => { setStatus("无法访问输入框（会话未就绪）"); setStatusKind("err"); });
          return false;
        }
        try {
          const current = shell.snapshot ? shell.snapshot.draft || "" : "";
          shell.actions.setDraft(current ? current.replace(/\s+$/, "") + "\n\n" + text : text);
          return true;
        } catch (err) {
          safeSet(() => { setStatus("插入失败：" + (err && err.message ? err.message : String(err))); setStatusKind("err"); });
          return false;
        }
      }, [inputShell, safeSet]);

      /** 把当前选中（无选中则整文件）作为代码块插入输入框。 */
      const selectToInput = useCallback((text) => {
        if (!hasContent) return false;
        const code = text && text.trim() ? text : activeContent;
        if (!code) return false;
        const block = buildCodeBlock(activeRel, activeLang, code, sourceLabel);
        const ok = insertToInput(block);
        if (ok) {
          safeSet(() => { setStatus("已选到输入框 ✓（可直接在输入框补充说明后发送）"); setStatusKind("ok"); });
        }
        return ok;
      }, [hasContent, activeContent, activeRel, activeLang, sourceLabel, insertToInput, safeSet]);

      /** 浮动确认按钮：把当前选中内容加入输入框。 */
      const confirmInsertSelection = useCallback(() => {
        if (!selInfo || !selInfo.text.trim()) return;
        const ok = selectToInput(selInfo.text);
        try {
          window.getSelection()?.removeAllRanges();
        } catch {
          /* 清除选区失败不影响 */
        }
        safeSet(() => setSelInfo(null));
        if (ok) {
          safeSet(() => { setStatus("已把选中内容加入输入框 ✓（可直接补充说明后发送）"); setStatusKind("ok"); });
        }
      }, [selInfo, selectToInput, safeSet]);

      // 清除选区（点击面板其他区域）时隐藏浮动按钮
      const onSelection = useCallback((text, rect) => {
        safeSet(() => {
          if (text && text.trim()) setSelInfo({ text, rect: rect || null });
          else setSelInfo(null);
        });
      }, [safeSet]);

      const openWorkspace = useCallback(() => {
        if (!openPath || !cwd) return;
        openPath(cwd).catch(() => {});
      }, [openPath, cwd]);

      const refreshCurrent = useCallback(() => {
        if (tab === "workspace" && cwd) {
          setTree({ "": { expanded: true, loaded: false, entries: [] } });
          loadDir(cwd, "").catch(() => {});
          if (selFile && contentState.status === "ok") onFileClick(cwd, selFile.rel, selFile.name);
        } else {
          setSnippets(null);
          loadSnippets();
        }
      }, [tab, cwd, loadDir, selFile, contentState.status, onFileClick, loadSnippets]);

      const onClose = useCallback(() => {
        panelState.set(false);
        if (closeDetails) closeDetails();
      }, [closeDetails]);

      // ---- 左侧树（懒加载，子目录行始终渲染）----
      const treeRows = [];
      if (cwd) {
        const renderDir = (rel, depth) => {
          const node = tree[rel] || { expanded: false, loaded: false, entries: [] };
          const label = rel === "" ? basenameOf(cwd) || "工作区" : basenameOf(rel);
          treeRows.push(jsxs("button", {
            key: "d" + rel,
            type: "button",
            className: "dsh-code-row dsh-code-row-dir",
            style: { paddingLeft: (6 + depth * 14) + "px" },
            onClick: () => onDirClick(cwd, rel, node.expanded, node.loaded),
            children: [
              jsx("span", { className: "dsh-code-row-caret", children: node.expanded ? "▾" : "▸" }),
              jsx("span", { className: "dsh-code-row-icon", children: DIR_ICON }),
              jsx("span", { className: "dsh-code-row-name", children: label }),
            ],
          }));
          if (node.expanded && node.loaded) {
            for (const entry of node.entries || []) {
              if (entry.dir) {
                renderDir(entry.rel, depth + 1);
              } else {
                treeRows.push(jsxs("button", {
                  key: "f" + entry.rel,
                  type: "button",
                  className: "dsh-code-row" + (selFile && selFile.rel === entry.rel ? " dsh-code-row-selected" : ""),
                  style: { paddingLeft: (6 + (depth + 1) * 14) + "px" },
                  onClick: () => onFileClick(cwd, entry.rel, entry.name),
                  children: [
                    jsx("span", { className: "dsh-code-row-caret", children: "" }),
                    jsx("span", { className: "dsh-code-row-icon", children: iconOf(entry.name, false) }),
                    jsx("span", { className: "dsh-code-row-name", children: entry.name }),
                    entry.size > 0 ? jsx("span", { className: "dsh-code-row-size", children: fmtBytes(entry.size) }) : null,
                  ],
                }));
              }
            }
          }
        };
        renderDir("", 0);
      }

      // ---- 右侧内容区 ----
      const contentNode = (() => {
        if (contentState.status === "loading") {
          return jsx("div", { className: "dsh-code-loading", children: "加载中…" });
        }
        if (contentState.status === "error") {
          return jsx("div", { className: "dsh-code-error", children: contentState.error });
        }
        if (contentState.status === "ok") {
          if (contentState.data.kind === "image") {
            // 图片预览：居中展示，可滚动；不参与代码选区
            return jsxs("div", {
              className: "dsh-code-image-wrap",
              children: [
                jsx("img", {
                  className: "dsh-code-image",
                  src: contentState.data.url,
                  alt: contentState.data.name || "图片预览",
                  draggable: false,
                  onError: (e) => {
                    // 加载失败（如文件被删）时替换为提示
                    e.currentTarget.style.display = "none";
                    e.currentTarget.nextSibling.textContent = "图片加载失败（文件可能已被删除）";
                  },
                }),
                jsx("div", { className: "dsh-code-image-meta", children: "图片预览 · 可让 Agent 调用视觉能力查看内容" }),
              ],
            });
          }
          return jsx(CodeView, {
            content: contentState.data.content,
            lang: contentState.data.lang || "text",
            onSelection,
          });
        }
        return jsx("div", {
          className: "dsh-code-empty",
          children: tab === "workspace"
            ? (cwd ? "在左侧选择文件查看代码；选中代码后点「选到输入框」即可引用给 Agent" : "当前会话没有工作区，请先新建会话并选择工作区")
            : "选择左侧片段查看；Agent 写好的代码可保存到片段目录（data/code-panel/snippets/）",
        });
      })();

      // ---- 左侧面板（树 / 片段列表）----
      const sideNode = tab === "workspace"
        ? jsxs(react.Fragment, { children: [
            jsxs("div", {
              className: "dsh-code-path",
              children: [
                jsx("span", { className: "dsh-code-path-name", title: cwd || "", children: cwd ? basenameOf(cwd) : "（无工作区）" }),
                jsx("button", {
                  type: "button",
                  className: "dsh-code-refresh",
                  title: "刷新",
                  onClick: refreshCurrent,
                  children: "⟳",
                }),
                cwd
                  ? jsx("button", { type: "button", className: "dsh-code-refresh", title: "在工作区目录中打开", onClick: openWorkspace, children: "打开目录" })
                  : null,
              ],
            }),
            cwd
              ? jsxs("div", { className: "dsh-code-tree", children: treeRows.length > 0 ? treeRows : jsx("div", { className: "dsh-code-loading", children: "加载中…" }) })
              : jsx("div", { className: "dsh-code-empty", children: "当前会话没有工作区" }),
          ] })
        : jsxs(react.Fragment, { children: [
            jsxs("div", {
              className: "dsh-code-path",
              children: [
                jsx("span", { className: "dsh-code-path-name", children: "Agent 代码片段" }),
                jsx("button", {
                  type: "button",
                  className: "dsh-code-refresh",
                  title: "刷新",
                  onClick: refreshCurrent,
                  children: "⟳",
                }),
              ],
            }),
            snippets === null
              ? jsx("div", { className: "dsh-code-loading", children: "加载中…" })
              : snippets.items.length === 0
                ? jsx("div", {
                    className: "dsh-code-snippet-hint",
                    children: "片段目录为空。Agent 写好的代码保存到 " + snippets.dir + " 后，会显示在这里。",
                  })
                : jsx("div", {
                    className: "dsh-code-snippets",
                    children: snippets.items.map((item) => jsx("button", {
                      key: item.name,
                      type: "button",
                      className: "dsh-code-snippet-btn" + (selSnippet && selSnippet.name === item.name ? " dsh-code-snippet-btn-selected" : ""),
                      onClick: () => onSnippetClick(item),
                      children: [
                        jsx("span", { className: "dsh-code-row-icon", children: iconOf(item.name, false) }),
                        jsx("span", { className: "dsh-code-snippet-name", children: item.name }),
                        jsx("span", { className: "dsh-code-snippet-size", children: fmtBytes(item.size) }),
                      ],
                    })),
                  }),
          ] });

      return jsxs("div", {
        className: "dsh-code-panel",
        children: [
          jsxs("div", {
            className: "dsh-code-head",
            children: [
              jsx("span", { className: "dsh-code-title", children: "代码面板" }),
              jsx("button", {
                type: "button",
                className: "dsh-code-close",
                title: "关闭面板",
                "aria-label": "关闭面板",
                onClick: onClose,
                children: "✕",
              }),
            ],
          }),
          jsxs("div", {
            className: "dsh-code-tabs",
            children: [
              jsx("button", {
                type: "button",
                className: "dsh-code-tab" + (tab === "workspace" ? " dsh-code-tab-active" : ""),
                onClick: () => setTab("workspace"),
                children: "工作区文件",
              }),
              jsx("button", {
                type: "button",
                className: "dsh-code-tab" + (tab === "snippets" ? " dsh-code-tab-active" : ""),
                onClick: () => setTab("snippets"),
                children: "我的代码",
              }),
            ],
          }),
          jsxs("div", {
            className: "dsh-code-body",
            children: [
              jsx("div", { className: "dsh-code-side", children: sideNode }),
              jsxs("div", {
                className: "dsh-code-view",
                children: [
                  jsxs("div", {
                    className: "dsh-code-filebar",
                    children: [
                      jsx("span", { className: "dsh-code-filebar-name", children: sourceLabel || "未选择文件" }),
                      contentState.status === "ok"
                        ? jsx("span", { className: "dsh-code-filebar-meta", children: fmtBytes(contentState.data.size) + " · " + (contentState.data.lang === "image" ? "图片" : (contentState.data.lang || "text")) })
                        : null,
                    ],
                  }),
                  contentNode,
                ],
              }),
            ],
          }),
          jsxs("div", {
            className: "dsh-code-foot",
            children: [
              jsx("span", {
                className: "dsh-code-selinfo",
                children: selInfo && selInfo.text.trim()
                  ? "已选中 " + selInfo.text.length + " 字符，点上方按钮加入输入框"
                  : isImageView
                    ? "图片预览模式：无法作为代码引用"
                    : hasContent
                      ? "未选中文本，点「选到输入框」将整个文件加入输入框"
                      : "",
              }),
              jsx("button", {
                type: "button",
                className: "dsh-code-btn dsh-code-btn-primary",
                disabled: !hasContent,
                title: isImageView
                  ? "图片无法插入输入框，理解图片内容请让 Agent 调用视觉能力"
                  : "把整个文件放进会话输入框（不发送，可自行补充说明）",
                onClick: () => selectToInput(""),
                children: "选到输入框",
              }),
              status
                ? jsx("div", {
                    className: "dsh-code-status" + (statusKind === "err" ? " dsh-code-status-err" : statusKind === "ok" ? " dsh-code-status-ok" : ""),
                    children: status,
                  })
                : null,
            ],
          }),
          // 浮动确认按钮：选中代码后浮现
          selInfo && selInfo.text.trim() && selInfo.rect
            ? jsx("button", {
                type: "button",
                className: "dsh-code-float-btn",
                style: {
                  left: Math.max(8, Math.round(selInfo.rect.left + selInfo.rect.width / 2)) + "px",
                  top: (selInfo.rect.top < 130 ? Math.round(selInfo.rect.bottom + 10) : Math.round(selInfo.rect.top - 10)) + "px",
                  transform: selInfo.rect.top < 130 ? "translate(-50%, 0)" : "translate(-50%, -100%)",
                },
                onClick: confirmInsertSelection,
                children: "将选中内容加入到输入框",
              })
            : null,
        ],
      });
    }

    // ---------------------------------------------------------------- 标题行开关按钮

    function HeaderToggle(props) {
      const { onToggle } = props;
      // 订阅模块级开关状态：面板 ✕ 关闭、切会话复位等都会同步到这里，
      // 避免按钮高亮与实际面板状态不一致
      const [open, setOpen] = useState(panelState.open);
      useEffect(() => panelState.subscribe(setOpen), []);
      return jsx("button", {
        type: "button",
        className: "dsh-code-header-btn" + (open ? " dsh-code-header-btn-on" : ""),
        title: open ? "代码面板已打开（面板右上角 ✕ 可关闭）" : "打开右侧代码面板",
        onClick: onToggle,
        children: [
          jsx("span", { "aria-hidden": true, children: "</>" }),
          jsx("span", { children: "代码面板" }),
        ],
      });
    }

    // ---------------------------------------------------------------- 插件入口

    const inject = ["slots", "layout", "conversation", "sessions", "workspaces"];

    function apply(ctx) {
      ensureCss();

      // @ 菜单"打开文件"事件监听（dsh-skill-manager 等插件触发）：
      //   dsh-code-panel:open-file  {root, rel, name, handled} 打开面板并加载文件
      //   dsh-code-panel:probe      {available}                能力探测（同步应答）
      ctx.effect(() => {
        const onOpenFile = (e) => {
          const d = e && e.detail;
          if (!d || !d.root || !d.rel || !d.name) return;
          d.handled = true;
          openRequests.request({ root: d.root, rel: d.rel, name: d.name });
          panelState.set(true);
          try {
            ctx.layout.openDetails();
          } catch (err) {
            console.error("[dsh-code-panel] openDetails failed:", err);
          }
        };
        const onProbe = (e) => {
          if (e && e.detail) e.detail.available = true;
        };
        window.addEventListener("dsh-code-panel:open-file", onOpenFile);
        window.addEventListener("dsh-code-panel:probe", onProbe);
        return () => {
          window.removeEventListener("dsh-code-panel:open-file", onOpenFile);
          window.removeEventListener("dsh-code-panel:probe", onProbe);
        };
      }, "dsh-code-panel: open-file 监听");

      // 右侧 details 栏：以更低优先级接管（shadow 默认的工具调用详情面板）
      ctx.slots.inject("details", () => ctx.slots.register({
        name: "details",
        priority: -1,
        inject: (sessionId) => ({
          closeDetails: () => {
            panelState.set(false);
            ctx.layout.closeDetails();
          },
          // 惰性 getter：conversation 服务可能晚于本插件就绪，取用时才解析
          input: () => {
            try {
              return ctx.conversation ? ctx.conversation.input : null;
            } catch {
              return null;
            }
          },
          openPath: (path) => ctx.workspaces.openPath(path),
        }),
      }, CodePanel));

      // 会话标题行右上角（Session Log 同一行，utilities 区）：开关代码面板
      ctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register({
        name: "conversation.session.header.utilities",
        id: "code-panel",
        order: 30,
        inject: () => ({
          onToggle: () => {
            const next = !panelState.open;
            panelState.set(next);
            if (next) ctx.layout.openDetails();
            else ctx.layout.closeDetails();
          },
        }),
      }, (props) => jsx(HeaderToggle, { onToggle: props.onToggle })));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
