/**
 * dsh-pwsh-guard — 融合版 PowerShell 守门插件
 *
 * 三件事：
 *   1. 闸门：`tools/pre-execute` 拦截每次 pwsh 调用，命中已知坑位 → deny 并附修复建议
 *   2. 工具：pwsh_run（修复 + 结构化执行 + UTF-8 + 沙箱）、pwsh_check（只查不跑）、run_argv（免 shell）
 *   3. 教学：注册 pwsh-guard skill，教模型在本机（Windows PowerShell 5.1）怎么写对
 *
 * 融合来源（均为 MIT / 公开实现，思路借鉴、代码重写）：
 *   - chaggle/dsh-powershell-check   静态规则表与 pre-execute 闸门形态
 *   - GuTianshuo/powershell-fix      bash -> PowerShell 自动修复
 *   - fengbai2233/dsh-pwsh-quoting-guard  结构化执行与沙箱/输出词表
 *   - sryimnoob123/dsh-tool-pwsh-safe     超长脚本 base64 兜底
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { check, formatHits } from "./rules.js";
import { fix, formatNotes } from "./fixer.js";
import { runPowerShell, runProcess, resolveCwd, DEFAULT_TIMEOUT_MS } from "./exec.js";
import { deepCheck, formatAstErrors, formatPssaFindings } from "./ast.js";
import { startPowerShellBackground, listLocalJobs, readLocalJob, killLocalJob, clearLocalJobs } from "./background.js";
import { assessDanger, formatDanger } from "./danger.js";
import { appendAudit, readAuditTail, summarizeAudit, clipCommand } from "./audit.js";

export const name = "dsh-pwsh-guard";
export const inject = ["tools", "skills", "subprocess"];

const PROVIDER_NAME = "dsh-pwsh-guard";
const SKILL_URL = new URL("../SKILL.md", import.meta.url);
const RESOURCE_BASE = { kind: "directory", path: fileURLToPath(new URL("../", import.meta.url)) };

const CANDIDATE = {
  name: "pwsh-guard",
  description: "在 Windows 上写/执行 PowerShell 之前必读：本机 DSH 实际运行 Windows PowerShell 5.1，先查坑再执行；优先用 pwsh_run 绕开引号与编码问题，原生程序用 run_argv。",
  invocation: { modelInvocable: true, userInvocable: true },
  provider: PROVIDER_NAME,
  source: "bundled",
  resourceBase: RESOURCE_BASE,
  rank: 610,
  locator: SKILL_URL,
};

const provider = {
  name: PROVIDER_NAME,
  list: () => Promise.resolve([CANDIDATE]),
  async get() {
    return {
      name: CANDIDATE.name,
      description: CANDIDATE.description,
      invocation: CANDIDATE.invocation,
      provider: CANDIDATE.provider,
      source: CANDIDATE.source,
      resourceBase: RESOURCE_BASE,
      content: await readFile(SKILL_URL, "utf8"),
    };
  },
};

/** 归一化插件配置（来自 cordis.patch.yml 的 config）。 */
function normalizeConfig(config = {}) {
  const mode = config.mode === "warn" || config.mode === "off" ? config.mode : "deny";
  const lang = config.lang === "en" ? "en" : "zh";
  const disabled = Array.isArray(config.disableRules)
    ? config.disableRules.filter((x) => typeof x === "string")
    : [];
  const autoFix = config.autoFix !== false;
  const shell = typeof config.shell === "string" && config.shell.length > 0 ? config.shell : "auto";
  const deepCheckMode = config.deepCheck === "off" || config.deepCheck === "all" ? config.deepCheck : "run";
  const analyzer = config.analyzer === "psscriptanalyzer" ? "psscriptanalyzer" : "builtin";
  const outputGuard = config.outputGuard !== false;
  const takeover = config.takeover === "replace" ? "replace" : "off";
  return { mode, lang, disabled, autoFix, shell, deepCheck: deepCheckMode, analyzer, outputGuard, takeover };
}

/** 从 pwsh 工具调用参数里取出命令文本。 */
function commandOf(exec) {
  const args = exec && exec.arguments;
  if (!args || typeof args !== "object") return "";
  return typeof args.command === "string" ? args.command : "";
}

/** 记录用的 agent 标识（取不到就省略）。 */
function agentIdOf(exec) {
  try {
    if (exec && exec.agent && exec.agent.id !== undefined) return String(exec.agent.id);
  } catch {
    /* ignore */
  }
  return undefined;
}

/** 从工具结果里提取文本块。 */
function textOfToolResult(result) {
  const content = result && Array.isArray(result.content) ? result.content : [];
  const parts = [];
  for (const block of content) {
    if (block && typeof block === "object" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n");
}

/** 高置信度乱码特征（正常文本不误报）。 */
function looksLikeMojibake(text) {
  if (typeof text !== "string" || text.length === 0) return false;
  if (/锟斤拷/.test(text)) return true;
  if (/\uFFFD|ï»¿|â€/.test(text)) return true;
  const replacement = (text.match(/\uFFFD/g) || []).length;
  if (replacement >= 3 && replacement / text.length > 0.005) return true;
  return false;
}

/**
 * 接管：在每个 agent（含子代理）的 scope 上隐藏全局 pwsh 工具，
 * 让模型只能看到 pwsh_run / run_argv / pwsh_check。
 * 用的是官方 per-scope restriction API（agent.ctx.tools.restrict），可逆、可热卸载。
 */
function installTakeover(ctx) {
  const installed = new Map();
  const installOne = (agent) => {
    if (!agent || installed.has(agent)) return;
    try {
      const scoped = agent.ctx && agent.ctx.tools;
      if (!scoped || typeof scoped.restrict !== "function") return;
      const dispose = scoped.restrict({ deny: ["pwsh"] });
      installed.set(agent, typeof dispose === "function" ? dispose : () => {});
      ctx.logger?.info?.("[pwsh-guard] 已接管：该 agent 的 pwsh 工具被隐藏，改用 pwsh_run / run_argv");
    } catch (error) {
      ctx.logger?.warn?.("[pwsh-guard] 接管失败（保持原工具）：" + (error && error.message ? error.message : String(error)));
    }
  };
  try {
    const agents = ctx.get("agents");
    if (agents && typeof agents.list === "function") {
      for (const agent of agents.list()) installOne(agent);
    }
  } catch {
    /* ignore */
  }
  ctx.on("agent/created", ({ agent }) => installOne(agent));
  ctx.on("agent/disposed", ({ agent }) => {
    const dispose = installed.get(agent);
    if (typeof dispose === "function") {
      try { dispose(); } catch { /* ignore */ }
    }
    installed.delete(agent);
  });
  if (typeof ctx.effect === "function") {
    ctx.effect(() => () => {
      for (const dispose of installed.values()) {
        try { dispose(); } catch { /* ignore */ }
      }
      installed.clear();
    }, "pwsh-guard.takeover");
  }
}

const output = {
  schema: { type: "object", properties: { text: { type: "string" } }, additionalProperties: false },
  render: (_args, value) => [{ type: "text", text: value.text }],
};

/** 渲染 check 结果。 */
function reportHits(result, lang) {
  const zh = lang !== "en";
  const lines = [];
  if (result.blocking.length > 0) {
    lines.push((zh ? "阻断级问题（" : "Blocking issues (") + result.blocking.length + (zh ? "）：" : "):"));
    lines.push(formatHits(result.blocking, lang));
  }
  if (result.advisory.length > 0) {
    lines.push((zh ? "建议级问题（" : "Advisory issues (") + result.advisory.length + (zh ? "）：" : "):"));
    lines.push(formatHits(result.advisory, lang));
  }
  return lines.join("\n");
}

/** 渲染修复说明。 */
function reportNotes(notes, lang) {
  if (notes.length === 0) return "";
  return (lang !== "en" ? "[pwsh-guard] 自动修复 " : "[pwsh-guard] auto-fixed ") + notes.length + (lang !== "en" ? " 处：" : " item(s):") + "\n" + formatNotes(notes, lang);
}
/** 插件入口：注册 skill、pre-execute 闸门、三个工具与系统提示。 */
export function apply(ctx, config = {}) {
  const cfg = normalizeConfig(config);
  const zh = cfg.lang !== "en";

  // --- 1) 教学：注册 pwsh-guard skill ---
  try {
    ctx.skills.registerProvider(() => provider);
  } catch (error) {
    ctx.logger?.warn?.("[pwsh-guard] skill provider 注册失败：" + (error && error.message ? error.message : String(error)));
  }

  // --- 2) 闸门：pwsh 调用执行前的静态检查 ---
  ctx.on("tools/pre-execute", async (exec, next) => {
    try {
    if (cfg.mode === "off") return next();
    if (!exec || exec.name !== "pwsh") return next();
    const command = commandOf(exec);
    if (command.trim().length === 0) return next();

    const result = check(command, { disabled: cfg.disabled });
    if (result.blocking.length === 0) {
      if (cfg.deepCheck === "all") {
        const deep = await deepCheck(ctx, exec, command, { pssa: cfg.analyzer === "psscriptanalyzer", shell: cfg.shell });
        if (deep.status === "ok" && deep.errors.length > 0) {
          appendAudit({ event: "deep-block", source: "gate", ast: deep.errors.length, agent: agentIdOf(exec), command: clipCommand(command) });
          return {
            kind: "deny",
            reason: [
              zh ? "dsh-pwsh-guard：PowerShell 语法解析失败（AST），已阻止执行：" : "dsh-pwsh-guard: PowerShell parse error (AST); execution blocked:",
              formatAstErrors(deep.errors, cfg.lang),
              "",
              zh ? "修正语法后再执行，或改用 pwsh_run（执行前会做同样的解析检查）。" : "Fix the syntax, or use pwsh_run (it runs the same parse check first).",
            ].join("\n"),
          };
        }
      }
      if (result.advisory.length > 0) {
        ctx.logger?.info?.("[pwsh-guard] " + result.advisory.length + (zh ? " 条建议（放行）：" : " advisory item(s), allowed:") + "\n" + formatHits(result.advisory, cfg.lang));
      }
      return next();
    }
    if (cfg.mode === "warn") {
      appendAudit({ event: "warn", rules: result.blocking.map((h) => h.id), agent: agentIdOf(exec), command: clipCommand(command) });
      ctx.logger?.warn?.("[pwsh-guard] " + result.blocking.length + (zh ? " 个阻断问题（warn 模式放行）：" : " blocking issue(s), allowed in warn mode:") + "\n" + formatHits(result.blocking, cfg.lang));
      return next();
    }

    appendAudit({ event: "deny", rules: result.blocking.map((h) => h.id), mode: cfg.mode, agent: agentIdOf(exec), command: clipCommand(command) });
    const fixed = cfg.autoFix ? fix(command) : { text: command, notes: [] };
    const reason = [
      (zh ? "dsh-pwsh-guard：检测到 " : "dsh-pwsh-guard: ") + result.blocking.length + (zh ? " 个阻断级 PowerShell 坑位，已阻止执行：" : " blocking PowerShell pitfall(s); execution blocked:"),
      formatHits(result.blocking, cfg.lang),
      "",
      (zh ? "已自动修复 " : "Auto-fixed ") + fixed.notes.length + (zh ? " 处，可直接改用下面的命令：" : " item(s); use this command instead:"),
      "```powershell",
      fixed.text,
      "```",
      "",
      zh ? "也可以用 pwsh_run 工具执行同样的正文（内置 UTF-8 前导、自动修复、与内置 pwsh 相同的沙箱）。" : "You can also run the same body with the pwsh_run tool (UTF-8 prelude, auto-fix, same sandbox as built-in pwsh).",
    ].join("\n");
    return { kind: "deny", reason };
    } catch (error) {
      ctx.logger?.warn?.("[pwsh-guard] 闸门内部异常，已放行：" + (error && error.message ? error.message : String(error)));
      return next();
    }
  });

  // --- 2b) 输出防护：内置 pwsh 输出疑似乱码时追加提示 ---
  if (cfg.outputGuard) {
    ctx.on("tools/post-execute", async (exec, result, next) => {
      try {
        if (!exec || exec.name !== "pwsh") return next();
        const text = textOfToolResult(result);
        if (!looksLikeMojibake(text)) return next();
        const note = {
          type: "text",
          text: zh
            ? "[pwsh-guard] 输出疑似编码乱码（GBK/UTF-8 混淆）。建议改用 pwsh_run（内置 UTF-8 前导），或在该命令前加 chcp 65001 | Out-Null 后重试。"
            : "[pwsh-guard] Output looks like mojibake (GBK/UTF-8 mismatch). Prefer pwsh_run (UTF-8 prelude), or prefix chcp 65001 | Out-Null and retry.",
        };
        const content = Array.isArray(result && result.content) ? result.content.slice() : [];
        return { kind: "accept", content: content.concat([note]) };
      } catch (error) {
        ctx.logger?.warn?.("[pwsh-guard] 输出防护异常，已跳过：" + (error && error.message ? error.message : String(error)));
        return next();
      }
    });
  }

  // --- 3) 工具：pwsh_run / pwsh_check / run_argv ---
  ctx.tools.register({
    name: "pwsh_run",
    description: "在 Windows 上执行 PowerShell 脚本（推荐入口）：脚本体逐字传入、无需任何引号转义，数据放 args 并用 $DSH_ARGS[0]、[1] 读取。默认自动修复 bash 风格写法（&&、npm、ls -la、/dev/null、export 等）并做静态检查；命中阻断级坑位会拒绝执行并给出修复建议。走与内置 pwsh 相同的沙箱与审批策略。",
    parameters: {
      type: "object",
      properties: {
        script: { type: "string", description: "PowerShell 正文，逐字传入，可多行。" },
        args: { type: "array", items: { type: "string" }, description: "要绑定的数据，脚本里读 $DSH_ARGS[0]、[1]；不要把这些值写进正文。" },
        cwd: { type: "string", description: "工作目录；默认会话工作区。" },
        fix: { type: "boolean", description: "是否自动修复 bash 风格写法（默认跟随插件配置，通常为 true）。" },
        force: { type: "boolean", description: "为 true 时跳过阻断级检查（不建议）。" },
        background: { type: "boolean", description: "为 true 时作为 DSH 后台任务启动，立即返回 jobId（用 job_output 读取输出、job_kill 终止）。" },
        dangerous: { type: "boolean", description: "确认执行自动修复产生的破坏性命令（递归删除系统路径、磁盘操作、持久化写入等）。默认拒绝。" },
      },
      required: ["script"],
    },
    output,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    execute: async (args, exec) => {
      const script = args && args.script;
      if (typeof script !== "string" || script.trim().length === 0) throw new Error("script 必须是非空字符串");
      const argList = Array.isArray(args.args) ? args.args.slice() : [];
      for (const item of argList) {
        if (typeof item !== "string") throw new Error("args 的每个元素必须是字符串");
      }
      const doFix = args.fix === undefined ? cfg.autoFix : args.fix !== false;
      const fixed = doFix ? fix(script) : { text: script, notes: [] };
      if (fixed.notes.length > 0) {
        appendAudit({ event: "fix", transforms: fixed.notes.map((n) => n.id), agent: agentIdOf(exec), command: clipCommand(fixed.text) });
      }
      const result = check(fixed.text, { disabled: cfg.disabled });
      const header = [];
      if (fixed.notes.length > 0) {
        header.push(reportNotes(fixed.notes, cfg.lang));
        if (fixed.text.length <= 2000) {
          header.push(zh ? "实际执行（已修复）：" : "Executed (after auto-fix):", "```powershell", fixed.text, "```");
        }
      }
      if (cfg.deepCheck !== "off") {
        const deep = await deepCheck(ctx, exec, fixed.text, { pssa: cfg.analyzer === "psscriptanalyzer", shell: cfg.shell });
        const astErrors = deep.status === "ok" ? deep.errors : [];
        const pssaErrors = deep.status === "ok" ? deep.pssa.errors : [];
        if ((astErrors.length > 0 || pssaErrors.length > 0) && args.force !== true) {
          appendAudit({ event: "deep-block", source: "run", ast: astErrors.length, pssa: pssaErrors.length, agent: agentIdOf(exec) });
          header.push(zh ? "[pwsh-guard] 未执行：深度检查发现问题" : "[pwsh-guard] not executed: deep check failed");
          if (astErrors.length > 0) header.push(formatAstErrors(astErrors, cfg.lang));
          if (pssaErrors.length > 0) header.push(formatPssaFindings(pssaErrors, deep.pssa.warnings, cfg.lang));
          header.push(zh ? "修正后用 pwsh_run 重试；确需强制执行传 force=true（不建议）。" : "Fix and retry; pass force=true to execute anyway (not recommended).");
          return { text: header.join("\n") };
        }
      }
      if (result.blocking.length > 0 && args.force !== true) {
        header.push((zh ? "[pwsh-guard] 未执行：修复后仍有阻断级问题" : "[pwsh-guard] not executed: blocking issues remain") + "\n" + reportHits(result, cfg.lang));
        header.push(zh ? "确需强制执行可传 force=true（不建议）。" : "Pass force=true to execute anyway (not recommended).");
        return { text: header.join("\n") };
      }
      if (result.blocking.length > 0) {
        appendAudit({ event: "force", rules: result.blocking.map((h) => h.id), agent: agentIdOf(exec), command: clipCommand(fixed.text) });
        header.push("[pwsh-guard] force=true：" + (zh ? "已跳过 " : "skipped ") + result.blocking.length + (zh ? " 个阻断问题" : " blocking issue(s)"));
      }
      else if (result.advisory.length > 0) header.push("[pwsh-guard] " + (zh ? "提示：" : "note: ") + result.advisory.length + (zh ? " 条建议（未阻断）：" : " advisory item(s):") + "\n" + formatHits(result.advisory, cfg.lang));

      const danger = assessDanger(fixed.text);
      if (danger.dangerous && fixed.notes.length > 0 && args.dangerous !== true) {
        appendAudit({ event: "danger-block", reasons: danger.reasons.map((r) => r.id), agent: agentIdOf(exec), command: clipCommand(fixed.text) });
        header.push(zh
          ? "[pwsh-guard] 未执行：自动修复把命令变成了破坏性操作，需要显式确认（上面列出的是修复后的命令，尚未执行）"
          : "[pwsh-guard] not executed: auto-fix produced a destructive command; explicit confirmation required");
        header.push(formatDanger(danger.reasons, cfg.lang));
        header.push(zh
          ? "若确认要执行，请加 dangerous: true 重新调用；或用 fix: false 直接执行你原本写的命令。"
          : "Pass dangerous: true to confirm, or use fix: false to run the original command.");
        return { text: header.join("\n") };
      }
      if (danger.dangerous && args.dangerous === true) {
        appendAudit({ event: "danger-confirm", reasons: danger.reasons.map((r) => r.id), agent: agentIdOf(exec), command: clipCommand(fixed.text) });
        header.push("[pwsh-guard] " + (zh ? "已确认执行破坏性命令（dangerous=true）" : "destructive command confirmed (dangerous=true)"));
      }
      if (args.background === true) {
        let started;
        try {
          started = await startPowerShellBackground(ctx, exec, fixed.text, argList, { cwd: args.cwd, shell: cfg.shell, label: fixed.text.slice(0, 120) });
        } catch (error) {
          header.push("[pwsh-guard] " + (zh ? "后台启动失败：" : "background start failed: ") + (error && error.message ? error.message : String(error)));
          return { text: header.join("\n") };
        }
        appendAudit({ event: "background", mode: started.mode, id: started.id, agent: agentIdOf(exec), command: clipCommand(fixed.text) });
        header.push((zh ? "[pwsh-guard] 后台任务已启动：jobId=" : "[pwsh-guard] background job started: jobId=") + started.id);
        if (started.mode === "jobs") {
          header.push(zh ? "用 job_output " + started.id + " 读取增量输出、job_kill " + started.id + " 终止。" : "Use job_output " + started.id + " / job_kill " + started.id + ".");
        } else {
          header.push(zh
            ? "本 profile 没有官方 job 控制器，任务由插件托管：pwsh_job { action: \"read\", jobId: \"" + started.id + "\" } 读输出，action: \"kill\" 终止，action: \"list\" 查看全部。"
            : "Managed locally (no job controller): use pwsh_job { action: \"read\"|\"kill\"|\"list\", jobId }.");
        }
        return { text: header.join("\n") };
      }
      let run;
      try {
        run = await runPowerShell(ctx, exec, fixed.text, argList, { cwd: args.cwd, shell: cfg.shell });
      } catch (error) {
        header.push("[pwsh-guard] " + (zh ? "执行失败：" : "execution failed: ") + (error && error.message ? error.message : String(error)));
        return { text: header.join("\n") };
      }
      header.push(run.text);
      return { text: header.join("\n") };
    },
  });

  ctx.tools.register({
    name: "pwsh_check",
    description: "只做静态检查、不执行：检查 PowerShell 命令或脚本里的已知坑位并给出修复建议；可选输出自动修复后的版本。生成 .ps1 或复杂命令前可先自查。",
    parameters: {
      type: "object",
      properties: {
        script: { type: "string", description: "要检查的 PowerShell 命令或脚本。" },
        fix: { type: "boolean", description: "为 true 时同时输出自动修复后的版本。" },
      },
      required: ["script"],
    },
    output,
    timeoutMs: 30000,
    execute: async (args, exec) => {
      const script = args && args.script;
      if (typeof script !== "string" || script.trim().length === 0) throw new Error("script 必须是非空字符串");
      const result = check(script, { disabled: cfg.disabled });
      const lines = [];
      if (cfg.deepCheck !== "off") {
        const deep = await deepCheck(ctx, exec, script, { pssa: cfg.analyzer === "psscriptanalyzer", shell: cfg.shell });
        if (deep.status === "ok") {
          lines.push("");
          lines.push("[pwsh-guard] AST: " + (deep.errors.length === 0 ? (zh ? "语法通过" : "syntax OK") : deep.errors.length + (zh ? " 个语法错误" : " parse error(s)")));
          if (deep.errors.length > 0) lines.push(formatAstErrors(deep.errors, cfg.lang));
          if (cfg.analyzer === "psscriptanalyzer") {
            if (deep.pssa.status === "missing") {
              lines.push("[pwsh-guard] PSScriptAnalyzer: " + (zh ? "未安装（已跳过）" : "not installed (skipped)"));
              lines.push(zh ? "  一键安装：pwsh_analyzer { action: \"install\" }（或手动 Install-Module PSScriptAnalyzer -Scope CurrentUser -Force）" : "  One-click install: pwsh_analyzer { action: \"install\" }");
            }
            else if (deep.pssa.status === "ok" && (deep.pssa.errors.length > 0 || deep.pssa.warnings.length > 0)) lines.push(formatPssaFindings(deep.pssa.errors, deep.pssa.warnings, cfg.lang));
            else if (deep.pssa.status === "ok") lines.push("[pwsh-guard] PSScriptAnalyzer: " + (zh ? "无发现" : "no findings"));
          }
        } else {
          lines.push("");
          lines.push("[pwsh-guard] " + (zh ? "深度检查不可用（已降级）：" : "deep check unavailable (degraded): ") + (deep.detail || ""));
        }
      }
      if (result.blocking.length === 0 && result.advisory.length === 0) {
        lines.push(zh ? "[pwsh-guard] PASS — 未发现已知坑位" : "[pwsh-guard] PASS — no known pitfalls");
      } else {
        lines.push("[pwsh-guard] " + result.blocking.length + (zh ? " 阻断级 / " : " blocking / ") + result.advisory.length + (zh ? " 建议级" : " advisory"));
        lines.push(reportHits(result, cfg.lang));
      }
      const dangerInfo = assessDanger(script);
      if (dangerInfo.dangerous) {
        lines.push("");
        lines.push("[pwsh-guard] " + (zh ? "破坏性操作（pwsh_run 自动修复时会要求 dangerous: true 确认）：" : "destructive operation (pwsh_run auto-fix will require dangerous: true):"));
        lines.push(formatDanger(dangerInfo.reasons, cfg.lang));
      }
      if (args.fix) {
        const fixed = fix(script);
        if (fixed.changed) {
          lines.push("", zh ? "修复后（可直接执行）：" : "Fixed version:", "```powershell", fixed.text, "```");
        }
        if (fixed.notes.length > 0) lines.push(reportNotes(fixed.notes, cfg.lang));
      }
      return { text: lines.join("\n") };
    },
  });

  ctx.tools.register({
    name: "run_argv",
    description: "不经 shell 直接运行程序（argv 逐字传递）：给 git / node / python 等原生程序传含引号或特殊字符的参数时用它，规避 PS 5.1 静默吞引号的问题。",
    parameters: {
      type: "object",
      properties: {
        program: { type: "string", description: "可执行文件名或绝对路径。" },
        args: { type: "array", items: { type: "string" }, description: "逐字传递的参数数组，一个元素一个参数。" },
        cwd: { type: "string", description: "工作目录；默认会话工作区。" },
      },
      required: ["program"],
    },
    output,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    execute: async (args, exec) => {
      const program = args && args.program;
      if (typeof program !== "string" || program.trim().length === 0) throw new Error("program 必须是非空字符串");
      const rest = Array.isArray(args.args) ? args.args.slice() : [];
      for (const item of rest) {
        if (typeof item !== "string") throw new Error("args 的每个元素必须是字符串");
      }
      let resolved = program;
      try {
        const found = await ctx.subprocess.resolveExecutable(program, undefined, exec.signal);
        if (typeof found === "string" && found.length > 0) resolved = found;
      } catch {
        /* 交给 spawn 报错 */
      }
      const cwd = resolveCwd(ctx, exec, args.cwd, "用 run_argv 的 cwd 参数显式指定");
      const run = await runProcess(ctx, exec, [resolved].concat(rest), cwd);
      return { text: run.text };
    },
  });

  ctx.tools.register({
    name: "pwsh_analyzer",
    description: "PSScriptAnalyzer 管理：action=status 检测模块是否安装；action=install 一键安装到当前用户（Install-Module -Scope CurrentUser）。安装后把插件配置 analyzer 设为 psscriptanalyzer，即可在 pwsh_check / pwsh_run 里获得官方静态分析。",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["status", "install"], description: "status 或 install" },
        cwd: { type: "string", description: "工作目录；默认会话工作区。" },
      },
      required: ["action"],
    },
    output,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    execute: async (args, exec) => {
      const action = args && args.action === "install" ? "install" : "status";
      const probe = "if (Get-Module -ListAvailable PSScriptAnalyzer) { 'OK:' + ((Get-Module -ListAvailable PSScriptAnalyzer | Select-Object -First 1).Version.ToString()) } else { 'MISSING' }";
      if (action === "status") {
        const run = await runPowerShell(ctx, exec, probe, [], { cwd: args.cwd, shell: cfg.shell });
        if (/OK:/.test(run.text)) return { text: "[pwsh-guard] PSScriptAnalyzer " + run.text.trim() };
        return { text: (zh ? "[pwsh-guard] PSScriptAnalyzer 未安装。运行 pwsh_analyzer { action: \"install\" } 一键安装（需要能访问 PSGallery）。" : "[pwsh-guard] PSScriptAnalyzer not installed.") };
      }
      const script = [
        "$ProgressPreference = 'SilentlyContinue'",
        "$ConfirmPreference = 'None'",
        "if (Get-Module -ListAvailable PSScriptAnalyzer) {",
        "  'ALREADY'",
        "} else {",
        "  try { Set-PSRepository -Name PSGallery -InstallationPolicy Trusted -ErrorAction SilentlyContinue } catch {}",
        "  try { Install-PackageProvider -Name NuGet -MinimumVersion 2.8.5.201 -Force -Confirm:$false -Scope CurrentUser -ErrorAction SilentlyContinue | Out-Null } catch {}",
        "  Install-Module PSScriptAnalyzer -Scope CurrentUser -Force -AllowClobber -Confirm:$false -SkipPublisherCheck -ErrorAction Stop",
        "  'INSTALLED'",
        "}",
        probe,
      ].join("\n");
      let run;
      try {
        run = await runPowerShell(ctx, exec, script, [], { cwd: args.cwd, shell: cfg.shell });
      } catch (error) {
        return { text: "[pwsh-guard] " + (zh ? "安装失败：" : "install failed: ") + (error && error.message ? error.message : String(error)) };
      }
      const installed = /OK:/.test(run.text);
      if (installed) return { text: (zh ? "[pwsh-guard] 安装完成，PSScriptAnalyzer " : "[pwsh-guard] installed: ") + run.text.trim() + "\n" + (zh ? "把配置里 analyzer 设为 psscriptanalyzer 即可启用深度检查。" : "set analyzer: psscriptanalyzer to enable.") };
      return { text: (zh ? "[pwsh-guard] 安装未完成（可能是网络或 PSGallery 问题）。可手动重试：Install-Module PSScriptAnalyzer -Scope CurrentUser -Force\n" : "[pwsh-guard] install incomplete.\n") + run.text };
    },
  });

  ctx.tools.register({
    name: "pwsh_job",
    description: "读取/终止本插件托管的本地后台任务（pwsh_run { background: true } 在没有官方 job 控制器的 profile 里启动的任务）：action=list 列出全部，action=read 读取增量输出，action=kill 终止。若任务注册在官方 jobs 表里，请用内置 job_output / job_kill。",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "read", "kill"], description: "list / read / kill" },
        jobId: { type: "string", description: "action=read 或 kill 时的任务 id" },
      },
      required: ["action"],
    },
    output,
    timeoutMs: 30000,
    execute: async (args) => {
      const action = args && typeof args.action === "string" ? args.action : "list";
      if (action === "list") {
        const jobs = listLocalJobs();
        if (jobs.length === 0) return { text: zh ? "[pwsh-guard] 没有本地后台任务。" : "[pwsh-guard] no local background jobs." };
        return {
          text: jobs
            .map((job) => "- " + job.id + " | " + (job.settled ? (job.error ? "failed: " + job.error : "exited: " + String(job.exitCode)) : "running") + " | " + job.label)
            .join("\n"),
        };
      }
      const jobId = args && typeof args.jobId === "string" ? args.jobId : "";
      if (jobId.length === 0) throw new Error("jobId 不能为空");
      if (action === "kill") {
        const killed = killLocalJob(jobId);
        if (killed === undefined) return { text: "[pwsh-guard] " + (zh ? "未知本地任务 " + jobId + "；若它是官方 jobs 任务，请用 job_kill。" : "unknown local job " + jobId) };
        return { text: "[pwsh-guard] " + (zh ? "已终止 " : "killed ") + jobId };
      }
      const text = readLocalJob(jobId);
      if (text === undefined) return { text: "[pwsh-guard] " + (zh ? "未知本地任务 " + jobId + "；若它是官方 jobs 任务，请用 job_output。" : "unknown local job " + jobId) };
      return { text };
    },
  });

  ctx.tools.register({
    name: "pwsh_audit",
    description: "查看本插件的审计日志：action=stats 聚合统计（事件计数、命中规则、修复转换），action=tail 返回最近 N 条原始记录。用于了解防护实际拦了什么、修复器改了什么、破坏性操作被确认过几次。",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["stats", "tail"], description: "stats 或 tail" },
        limit: { type: "number", description: "action=tail 时返回的条数，默认 20，最大 200。" },
      },
      required: ["action"],
    },
    output,
    timeoutMs: 30000,
    execute: async (args) => {
      const action = args && args.action === "tail" ? "tail" : "stats";
      if (action === "tail") {
        const limit = args && Number.isFinite(args.limit) ? Math.min(200, Math.max(1, Math.floor(args.limit))) : 20;
        const entries = readAuditTail(limit);
        if (entries.length === 0) return { text: zh ? "[pwsh-guard] 审计日志为空。" : "[pwsh-guard] audit log is empty." };
        return { text: entries.map((entry) => JSON.stringify(entry)).join("\n") };
      }
      const entries = readAuditTail(5000);
      const summary = summarizeAudit(entries);
      const lines = [];
      lines.push("[pwsh-guard] " + (zh ? "审计统计（最近 " + summary.total + " 条）" : "audit stats (last " + summary.total + ")"));
      for (const [name, count] of Object.entries(summary.events)) lines.push("  " + name + ": " + count);
      const topRules = Object.entries(summary.rules).sort((a, b) => b[1] - a[1]).slice(0, 10);
      if (topRules.length > 0) lines.push("  " + (zh ? "命中：" : "hits: ") + topRules.map(([id, n]) => id + " x" + n).join(", "));
      const topTransforms = Object.entries(summary.transforms).sort((a, b) => b[1] - a[1]).slice(0, 10);
      if (topTransforms.length > 0) lines.push("  " + (zh ? "修复：" : "fixes: ") + topTransforms.map(([id, n]) => id + " x" + n).join(", "));
      if (summary.total === 0) lines.push(zh ? "（还没有记录）" : "(no entries yet)");
      return { text: lines.join("\n") };
    },
  });

  // --- 4) 系统提示：优先使用本插件的工具 ---
  const systemPrompt = ctx.get("systemPrompt");
  if (systemPrompt !== undefined && typeof systemPrompt.section === "function") {
    systemPrompt.section({
      name: "dsh-pwsh-guard",
      order: 108,
      text: (cfg.takeover === "replace"
        ? "本 profile 已接管 shell：pwsh 工具已隐藏，PowerShell 一律用 pwsh_run 执行（自动 UTF-8、自动修复、静态检查），原生程序用 run_argv，查错用 pwsh_check。"
        : "Windows 上的 PowerShell 命令优先用 pwsh_run 执行（自动 UTF-8、自动修复 bash 风格、走同一沙箱）；给原生程序传参用 run_argv；直接用 pwsh 工具时会被 dsh-pwsh-guard 静态检查，命中坑位会返回修复建议而不是执行。"),
    });
  }

  if (cfg.takeover === "replace") installTakeover(ctx);

  // 插件卸载/热更新时终止本插件托管的本地后台任务
  if (typeof ctx.effect === "function") {
    ctx.effect(() => () => clearLocalJobs(), "pwsh-guard.local-jobs");
  }
}