/**
 * dsh-pwsh-guard — 深度检查：PowerShell AST 语法校验 + 可选 PSScriptAnalyzer
 *
 * 这一层补的是启发式正则规则做不到的真语法错误（真解析，不是模式匹配）：
 *   - 用 PowerShell 自身的 Parser（[System.Management.Automation.Language.Parser]）
 *     把脚本解析成 AST，任何解析错误都带行列位置返回；
 *   - 可选在同一进程里跑 PSScriptAnalyzer（-ScriptDefinition，不落盘）；
 *   - 一次进程调用完成两件事，输出单个 JSON。
 *
 * 脚本通过 stdin 以 base64(UTF-16LE) 传入：不写临时文件、不受 Windows 命令行长度限制、
 * 编码无歧义。探针只做解析，不执行用户脚本，因此不经过沙箱 confine（无副作用）。
 */

import { resolveShell, resolveCwd, dshEnvironment, toEncodedCommand } from "./exec.js";

const NL = "\n";

/** 固定探针：读 stdin -> 解析 AST ->（可选）PSScriptAnalyzer -> JSON。 */
const PROBE_LINES = [
  "$ErrorActionPreference = 'Stop'",
  "try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch {}",
  "$b64 = [Console]::In.ReadToEnd()",
  "$src = ''",
  "if ($b64.Trim().Length -gt 0) { $src = [System.Text.Encoding]::Unicode.GetString([System.Convert]::FromBase64String($b64.Trim())) }",
  "$tokens = $null; $errs = $null",
  "[void][System.Management.Automation.Language.Parser]::ParseInput($src, [ref]$tokens, [ref]$errs)",
  "$astErrors = @()",
  "foreach ($e in @($errs)) { $astErrors += [pscustomobject]@{ id = [string]$e.ErrorId; message = [string]$e.Message; line = [int]$e.Extent.StartLineNumber; column = [int]$e.Extent.StartColumnNumber; text = [string]$e.Extent.Text } }",
  "$pssaStatus = 'skipped'; $pssaErrors = @(); $pssaWarnings = @()",
  "if ($env:DSH_GUARD_PSSA -eq '1') {",
  "  $mod = Get-Module -ListAvailable -Name PSScriptAnalyzer -ErrorAction SilentlyContinue",
  "  if ($null -eq $mod) { $pssaStatus = 'missing' } else {",
  "    $pssaStatus = 'ok'",
  "    try {",
  "      foreach ($f in @(Invoke-ScriptAnalyzer -ScriptDefinition $src -ErrorAction SilentlyContinue)) {",
  "        $sev = [string]$f.Severity",
  "        $rec = [pscustomobject]@{ rule = [string]$f.RuleName; severity = $sev; message = [string]$f.Message; line = [int]$f.Line; column = [int]$f.Column }",
  "        if ($sev -match 'Error|Parse') { $pssaErrors += $rec } else { $pssaWarnings += $rec }",
  "      }",
  "    } catch { $pssaStatus = 'failed' }",
  "  }",
  "}",
  "[pscustomobject]@{ ok = (@($errs).Count -eq 0); errors = @($astErrors); pssaStatus = $pssaStatus; pssaErrors = @($pssaErrors); pssaWarnings = @($pssaWarnings) } | ConvertTo-Json -Depth 6 -Compress",
];

export const PROBE_SCRIPT = PROBE_LINES.join(NL);

function messageOf(error) {
  return error && error.message ? error.message : String(error);
}

function emptyPssa(status = "skipped") {
  return { status, errors: [], warnings: [] };
}

function failed(detail, pssa) {
  return { status: "failed", errors: [], pssa: pssa || emptyPssa(), detail: String(detail).slice(0, 400) };
}

/** 从 stdout 里取最后一行可解析的 JSON（PowerShell 可能混入提示行）。 */
export function lastJsonLine(stdout) {
  const lines = String(stdout || "").split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.length === 0) continue;
    if (line[0] !== "{") continue;
    try {
      return JSON.parse(line);
    } catch {
      /* keep looking */
    }
  }
  return null;
}

function normalizeAstErrors(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object") continue;
    out.push({
      id: String(item.id || ""),
      message: String(item.message || ""),
      line: Number(item.line || 0),
      column: Number(item.column || 0),
      text: String(item.text || ""),
    });
  }
  return out;
}

function normalizeFindings(raw, severityFallback) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object") continue;
    out.push({
      rule: String(item.rule || ""),
      severity: String(item.severity || severityFallback || ""),
      message: String(item.message || ""),
      line: Number(item.line || 0),
      column: Number(item.column || 0),
    });
  }
  return out;
}
function collectText(reader) {
  if (reader === undefined) return "";
  try {
    const read = reader.readFrom(0);
    return read && typeof read.text === "string" ? read.text : "";
  } catch {
    return "";
  }
}

/**
 * 深度检查一段脚本：AST 语法 +（可选）PSScriptAnalyzer。
 * 任何基础设施故障都降级为 status=failed，绝不抛出。
 * @param {{ subprocess: object }} ctx
 * @param {object} exec 工具执行上下文（提供 signal / session）
 * @param {string} source 待检查脚本
 * @param {{ pssa?: boolean, shell?: string }} [options]
 */
export async function deepCheck(ctx, exec, source, options = {}) {
  const src = typeof source === "string" ? source : "";
  let shell;
  try {
    shell = await resolveShell(ctx, exec, options.shell);
  } catch (error) {
    return failed("找不到 PowerShell：" + messageOf(error));
  }

  const argv = [shell, "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", toEncodedCommand(PROBE_SCRIPT)];
  const env = { DSH_GUARD_PSSA: options.pssa ? "1" : "0" };
  const managed = dshEnvironment(ctx, exec);
  for (const key of Object.keys(managed)) env[key] = managed[key];

  let cwd;
  try {
    cwd = resolveCwd(ctx, exec, undefined, "");
  } catch {
    cwd = undefined;
  }

  let handle;
  try {
    handle = ctx.subprocess.spawn({
      argv,
      cwd: cwd || process.cwd(),
      stdio: {
        stdin: { data: Buffer.from(src, "utf16le").toString("base64") },
        stdout: { maxBytes: 262144 },
        stderr: { maxBytes: 65536 },
      },
      graceMs: 2000,
      signal: exec && exec.signal ? exec.signal : undefined,
      env,
    });
  } catch (error) {
    return failed("无法启动检查进程：" + messageOf(error));
  }

  let outcome;
  try {
    outcome = await handle.done;
  } catch (error) {
    return failed("检查进程失败：" + messageOf(error));
  }

  const stdout = collectText(handle.collected && handle.collected.stdout);
  const stderr = collectText(handle.collected && handle.collected.stderr);
  const payload = lastJsonLine(stdout);
  if (payload === null) {
    const exitCode = outcome && typeof outcome.exitCode === "number" ? outcome.exitCode : "?";
    return failed("检查输出无法解析（exit=" + String(exitCode) + "）：" + (stderr || stdout));
  }

  const status = String(payload.pssaStatus || "skipped");
  const pssa = {
    status: status === "ok" || status === "missing" || status === "failed" ? status : "skipped",
    errors: normalizeFindings(payload.pssaErrors, "Error"),
    warnings: normalizeFindings(payload.pssaWarnings, "Warning"),
  };
  return { status: "ok", errors: normalizeAstErrors(payload.errors), pssa };
}

/** 渲染 AST 语法错误。 */
export function formatAstErrors(errors, lang = "zh") {
  const zh = lang !== "en";
  const lines = [];
  for (const item of errors.slice(0, 10)) {
    const loc = item.line > 0 ? " (L" + item.line + ":C" + item.column + ")" : "";
    const excerpt = item.text ? "  <- " + item.text.replace(/\s+/g, " ").slice(0, 80) : "";
    lines.push("  [" + (zh ? "语法" : "AST") + "]" + loc + " " + item.message + excerpt);
  }
  return lines.join(NL);
}

/** 渲染 PSScriptAnalyzer 结果。 */
export function formatPssaFindings(errors, warnings, lang = "zh") {
  const zh = lang !== "en";
  const lines = [];
  for (const item of errors.slice(0, 10)) {
    const loc = item.line > 0 ? " (L" + item.line + ":C" + item.column + ")" : "";
    lines.push("  [PSSA:" + item.severity + "] " + item.rule + loc + ": " + item.message);
  }
  if (warnings.length > 0) {
    lines.push("  " + (zh ? "另有 PSSA 警告 " : "plus PSSA warning(s): ") + warnings.length + (zh ? " 条（不阻断）" : " (non-blocking)"));
  }
  return lines.join(NL);
}