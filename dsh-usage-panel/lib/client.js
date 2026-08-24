// dsh-usage-panel 客户端插件（浏览器 bundle，__ModuleLoader__ 格式）
// 在「设置」页新增一个「用量」分区：显示 DeepSeek 账户余额、Token 用量汇总
// （input/output/cache/reasoning）、按模型的拆分与估算费用、近 7 天每日 token。
// 只读，数据来自宿主 /dsh-usage/api/summary。
// 注册方式与 harness 内置设置分区（general/models/plugins）一致：
//   ctx.slots.inject("settings.section", () => ctx.slots.register({...}, Section))
// 注意：React 的 jsx(type, props) 中 children 必须放进 props 对象。
window.__ModuleLoader__.load({
  id: "dsh-usage-panel",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var react_jsx_runtime = require("react/jsx-runtime");
    var react = require("react");
    const { jsx, jsxs } = react_jsx_runtime;
    const { useState, useEffect, useCallback } = react;

    const css = `
.dsh-up-sec{max-width:720px;color:var(--dsw-alias-label-primary);flex-direction:column;gap:12px;display:flex}
.dsh-up *{box-sizing:border-box}
.dsh-up-title{color:var(--dsw-alias-label-primary);margin:0;font-size:16px;font-weight:500;line-height:24px}
.dsh-up-sub{color:var(--dsw-alias-label-tertiary);margin:0;font-size:13px;line-height:20px}
.dsh-up-grid{display:flex;gap:12px;flex-wrap:wrap}
.dsh-up-card{background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:14px;flex:1;min-width:150px;display:flex;flex-direction:column;gap:6px;justify-content:center}
.dsh-up-card-label{font-size:11px;color:var(--dsw-alias-label-tertiary);text-transform:uppercase;letter-spacing:.04em}
.dsh-up-card-value{font-size:22px;font-weight:600;color:var(--dsw-alias-label-primary);line-height:1.2}
.dsh-up-card-value.sm{font-size:16px}
.dsh-up-card-value.ok{color:var(--dsw-alias-state-success-primary)}
.dsh-up-card-note{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dsh-up-section{display:flex;flex-direction:column;gap:8px}
.dsh-up-section-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dsh-up-table{width:100%;border-collapse:collapse;font-size:13px}
.dsh-up-table th{text-align:left;font-weight:500;font-size:11px;color:var(--dsw-alias-label-tertiary);padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.dsh-up-table td{padding:6px 8px;color:var(--dsw-alias-label-secondary);border-bottom:1px solid var(--dsw-alias-border-l2);white-space:nowrap}
.dsh-up-table td:first-child{font-weight:500;color:var(--dsw-alias-label-primary);word-break:break-word;white-space:normal}
.dsh-up-table tr:last-child td{border-bottom:none}
.dsh-up-empty{color:var(--dsw-alias-label-tertiary);font-size:13px;text-align:center;padding:24px 0}
.dsh-up-error{color:var(--dsw-alias-state-error-primary);font-size:12px;border:1px solid var(--dsw-alias-state-error-primary);border-radius:8px;padding:8px 12px}
`;

    function ensureCss() {
      const tagId = "dsh-usage-panel/section.css";
      if (typeof document !== "undefined" && document.querySelector('style[data-plugin-css="' + tagId + '"]') === null) {
        const tag = document.createElement("style");
        tag.dataset.plugin = "dsh-usage-panel";
        tag.dataset.pluginCss = tagId;
        tag.textContent = css;
        document.head.appendChild(tag);
      }
    }

    async function apiFetchSummary() {
      const res = await fetch("/dsh-usage/api/summary", { method: "GET", headers: { accept: "application/json" } });
      let data = {};
      try { data = await res.json(); } catch { /* ignore */ }
      return data;
    }

    function fmtNum(n) {
      if (typeof n !== "number" || !Number.isFinite(n)) return "0";
      if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(2) + "B";
      if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(2) + "M";
      if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1) + "k";
      return String(Math.round(n));
    }

    function fmtMoney(n, cur) {
      if (typeof n !== "number" || !Number.isFinite(n)) return "—";
      const sym = cur === "USD" ? "$" : cur === "CNY" ? "¥" : cur + " ";
      return sym + n.toFixed(2);
    }

    function tokenRow(label, value) {
      return jsxs("tr", { children: [ jsx("td", { children: label }), jsx("td", { children: fmtNum(value) }) ] });
    }

    function buildInfoSection(data, t) {
      if (!data) return null;
      return jsxs("div", { className: "dsh-up-section", children: [
        jsxs("div", { className: "dsh-up-grid", children: [
          jsxs("div", { className: "dsh-up-card", children: [
            jsx("span", { className: "dsh-up-card-label", children: "账户余额" }),
            jsx("span", { className: "dsh-up-card-value " + (data.balance ? "ok" : ""), children: data.balance ? fmtMoney(parseFloat(data.balance.total) || 0, data.balance.currency) : "不可用" }),
            jsx("span", { className: "dsh-up-card-note", children: data.balance ? "DeepSeek 官方余额" : "未配置 DEEPSEEK_API_KEY 或查询失败" }),
          ] }),
          jsxs("div", { className: "dsh-up-card", children: [
            jsx("span", { className: "dsh-up-card-label", children: "估算费用" }),
            jsx("span", { className: "dsh-up-card-value sm", children: fmtMoney(data.costCny, "CNY") + " / " + fmtMoney(data.costUsd, "USD") }),
            jsx("span", { className: "dsh-up-card-note", children: data.sessions + " 个会话 · 官方用量 × 当前价格表（估算，仅供参考）" }),
          ] }),
          jsxs("div", { className: "dsh-up-card", children: [
            jsx("span", { className: "dsh-up-card-label", children: "Token 总量（官方）" }),
            jsx("span", { className: "dsh-up-card-value", children: fmtNum(t ? t.total : 0) }),
            jsx("span", { className: "dsh-up-card-note", children: "全部会话 · 官方逐次返回的实际值" }),
          ] }),
        ] }),
        jsxs("div", { className: "dsh-up-section", children: [
          jsx("span", { className: "dsh-up-section-title", children: "Token 拆分" }),
          jsxs("table", { className: "dsh-up-table", children: [
            jsxs("thead", { children: [ jsxs("tr", { children: [ jsx("th", { children: "指标" }), jsx("th", { children: "数值" }) ] }) ] }),
            jsxs("tbody", { children: [
              tokenRow("输入（缓存未命中）", t ? t.input : 0),
              tokenRow("输入（缓存命中）", t ? t.cacheRead : 0),
              tokenRow("输出", t ? t.output : 0),
              tokenRow("缓存写入", t ? t.cacheWrite : 0),
              tokenRow("推理", t ? t.reasoning : 0),
            ] }),
          ] }),
        ] }),
      ] });
    }

    function buildModelSection(data) {
      if (!data || !data.byModel || data.byModel.length === 0) return null;
      return jsxs("div", { className: "dsh-up-section", children: [
        jsx("span", { className: "dsh-up-section-title", children: "按模型（会话数 · token · 估算费用）" }),
        jsxs("table", { className: "dsh-up-table", children: [
          jsxs("thead", { children: [ jsxs("tr", { children: [
            jsx("th", { children: "模型" }), jsx("th", { children: "会话" }), jsx("th", { children: "输入" }),
            jsx("th", { children: "输出" }), jsx("th", { children: "缓存" }), jsx("th", { children: "费用(CNY)" }),
          ] }) ] }),
          jsxs("tbody", { children: data.byModel.map((m) => jsxs("tr", { key: m.model + m.provider, children: [
            jsx("td", { children: (m.provider && m.provider !== "unknown" ? m.provider + " · " : "") + m.model }),
            jsx("td", { children: String(m.sessions) }),
            jsx("td", { children: fmtNum(m.tokens.input) }),
            jsx("td", { children: fmtNum(m.tokens.output) }),
            jsx("td", { children: fmtNum(m.tokens.cacheRead + m.tokens.cacheWrite) }),
            jsx("td", { children: m.costCny ? fmtMoney(m.costCny, "CNY") : "—" }),
          ] }) ) }),
        ] }),
      ] });
    }

    function buildDaySection(data) {
      if (!data || !data.byDay || data.byDay.length === 0) return null;
      const last7 = data.byDay.slice(-7);
      return jsxs("div", { className: "dsh-up-section", children: [
        jsx("span", { className: "dsh-up-section-title", children: "近 7 天每日 token" }),
        jsxs("div", { className: "dsh-up-grid", children: last7.map((d) => jsxs("div", { key: d.date, className: "dsh-up-card", children: [
          jsx("span", { className: "dsh-up-card-label", children: d.date }),
          jsx("span", { className: "dsh-up-card-value sm", children: fmtNum(d.tokens.total) }),
          jsx("span", { className: "dsh-up-card-note", children: "输入 " + fmtNum(d.tokens.input) }),
        ] }) ) }),
      ] });
    }

    function UsageSection() {
      const [data, setData] = useState(null);
      const [error, setError] = useState("");
      const [loading, setLoading] = useState(true);

      const load = useCallback(async () => {
        setLoading(true);
        setError("");
        try {
          const d = await apiFetchSummary();
          if (d && d.ok === false) setError(d.error || "加载失败");
          setData(d);
        } catch (e) {
          setError("无法连接用量服务：" + (e && e.message ? e.message : String(e)));
        } finally {
          setLoading(false);
        }
      }, []);

      useEffect(() => { load(); }, [load]);
      useEffect(() => {
        const t = setInterval(load, 60000);
        return () => clearInterval(t);
      }, [load]);

      const t = data ? data.tokens : null;
      const infoSection = buildInfoSection(data, t);
      const modelSection = buildModelSection(data);
      const daySection = buildDaySection(data);

      return jsx("section", { className: "dsh-up-sec", children: [
        jsx("div", { className: "dsh-up", children: [
          jsx("h2", { className: "dsh-up-title", children: "DeepSeek 用量" }),
          jsx("div", { className: "dsh-up-sub", children: "Token 用量为 DeepSeek 官方按请求返回的实际值（非估算）；费用为按官方用量 × 价格表的估算，仅供参考" }),
          loading && !data ? jsx("div", { className: "dsh-up-empty", children: "加载中…" }) : null,
          error ? jsx("div", { className: "dsh-up-error", children: [error, " ", jsx("a", { href: "#", onClick: (e) => { e.preventDefault(); load(); }, children: "重试" })] }) : null,
          infoSection,
          modelSection,
          daySection,
        ] }),
      ] });
    }

    const inject = ["slots"];

    function apply(ctx) {
      ensureCss();
      ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section",
        id: "usage",
        order: 20,
        label: () => "用量",
        inject: () => ({}),
      }, UsageSection));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
