/**
 * dsh-pwsh-guard — PowerShell 执行封装（零依赖）
 *
 * 复刻并融合两条社区实践：
 *   - fengbai2233/dsh-pwsh-quoting-guard：正文作为单个 argv 元素，数据走 $DSH_ARGS；
 *     沙箱 confine 语义与输出词表（[stderr] / truncated / [exit code]）与官方 pwsh 工具一致。
 *   - sryimnoob123/dsh-tool-pwsh-safe：脚本过长时自动切 -EncodedCommand（base64），
 *     避免撞 Windows 命令行长度上限。
 *
 * 关键点：强制 UTF-8 前导（解决 GBK 乱码）、参数由代码转义（模型永不转义）、
 * 沙箱包装失败时 fail closed。
 */

const NL = "\n";

/** 单 argv 内联脚本的长度上限（保守值，Windows CreateProcess 约 32K）。 */
const MAX_INLINE_BYTES = 24000;
const MAX_OUTPUT_BYTES = 64000;
const MAX_SPILL_BYTES = 67108864;
const GRACE_MS = 3000;
export const DEFAULT_TIMEOUT_MS = 300000;

export const DEFAULT_SHELLS = ["pwsh", "pwsh.exe", "powershell.exe", "powershell"];

/** PowerShell 单引号字面量：只需把单引号加倍。 */
export function psLiteral(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

/**
 * 组合第一行（UTF-8 前导 + $DSH_ARGS 绑定）与模型正文。
 * 保持同一行，模型自己的行号仍然准确。
 */
export function buildInlineScript(body, argList = []) {
  const prelude = "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); "
    + "$OutputEncoding = [System.Text.UTF8Encoding]::new($false); "
    + "$ErrorActionPreference = 'Continue'; "
    + "$ProgressPreference = 'SilentlyContinue'; "
    + "chcp 65001 | Out-Null; ";
  const args = argList.map(psLiteral).join(",");
  return prelude + "$DSH_ARGS = @(" + args + "); " + body;
}

/** UTF-16LE base64，供 -EncodedCommand 使用。 */
export function toEncodedCommand(script) {
  return Buffer.from(String(script), "utf16le").toString("base64");
}

/** 组装 argv：默认 -Command 单参数；超长时切 -EncodedCommand。 */
export function buildPowerShellArgv(shell, script) {
  const base = [shell, "-NoLogo", "-NoProfile", "-NonInteractive"];
  if (Buffer.byteLength(script, "utf8") > MAX_INLINE_BYTES) {
    return base.concat(["-EncodedCommand", toEncodedCommand(script)]);
  }
  return base.concat(["-Command", script]);
}

export function sessionOf(exec) {
  try {
    const agent = exec && exec.agent;
    return agent && agent.session ? agent.session : undefined;
  } catch {
    return undefined;
  }
}

export function sessionCwd(exec) {
  try {
    const session = sessionOf(exec);
    const header = session && session.header;
    const cwd = header && header.cwd;
    return typeof cwd === "string" && cwd.length > 0 ? cwd : undefined;
  } catch {
    return undefined;
  }
}

/** 受管 DSH_* 环境变量，逐叶复制，避免把活对象带出去。 */
export function dshEnvironment(ctx, exec) {
  const out = {};
  try {
    const shellEnv = ctx.get("shellEnv");
    if (shellEnv === undefined) return out;
    const collected = shellEnv.collect(exec);
    if (collected === undefined || collected === null || typeof collected !== "object") return out;
    for (const key of Object.keys(collected)) {
      if (typeof collected[key] === "string") out[key] = collected[key];
    }
  } catch {
    return out;
  }
  return out;
}

/** 解析工作目录：显式 > 会话工作区 > 沙箱策略工作区根。 */
export function resolveCwd(ctx, exec, requested, hint) {
  if (typeof requested === "string" && requested.length > 0) return requested;
  const fromSession = sessionCwd(exec);
  if (fromSession !== undefined) return fromSession;
  const policyService = ctx.get("sandboxPolicy");
  if (policyService !== undefined) {
    try {
      const resolved = policyService.resolve();
      const root = resolved && resolved.workspaceRoot;
      if (typeof root === "string" && root.length > 0) return root;
    } catch {
      /* fall through */
    }
  }
  throw new Error("无法确定工作目录" + (hint ? "：" + hint : "：请显式传 cwd"));
}

/** 解析 PowerShell 可执行文件：优先 pwsh，回退到 Windows PowerShell 5.1。 */
export async function resolveShell(ctx, exec, preferred) {
  const candidates = typeof preferred === "string" && preferred.length > 0 && preferred !== "auto"
    ? [preferred]
    : DEFAULT_SHELLS;
  for (const name of candidates) {
    try {
      const resolved = await ctx.subprocess.resolveExecutable(name, undefined, exec.signal);
      if (typeof resolved === "string" && resolved.length > 0) return resolved;
    } catch {
      /* try next */
    }
  }
  throw new Error("找不到 PowerShell 可执行文件（尝试过：" + candidates.join(", ") + "）");
}
/**
 * 通过部署的沙箱包装 argv。
 * danger-full-access 不包装（ACL runner 本身拒绝该模式）；
 * 受限模式下包装失败必须 fail closed，绝不静默放开。
 */
export function confine(ctx, exec, argv) {
  const sandbox = ctx.get("sandbox");
  const policyService = ctx.get("sandboxPolicy");
  if (sandbox === undefined || policyService === undefined) return { argv, note: "" };
  let policy;
  try {
    const session = sessionOf(exec);
    policy = session !== undefined ? policyService.resolve({ session }) : policyService.resolve();
  } catch {
    policy = undefined;
  }
  if (policy === undefined) return { argv, note: "" };
  const mode = String(policy.mode);
  if (mode === "danger-full-access") return { argv, note: "" };
  try {
    const confined = sandbox.confine(argv, policy);
    const wrapped = confined && confined.argv;
    const next = Array.isArray(wrapped) && wrapped.length > 0 ? wrapped.slice() : argv;
    const enforcement = confined && confined.enforcement;
    const note = typeof enforcement === "string" && enforcement.length > 0 && enforcement !== "full"
      ? "[sandbox: enforcement '" + enforcement + "' under " + mode + " mode]"
      : "";
    return { argv: next, note };
  } catch (error) {
    const reason = error && error.message ? error.message : String(error);
    throw new Error("沙箱包装失败（" + mode + "），拒绝在未受限状态下执行：" + reason);
  }
}

function collect(reader) {
  if (reader === undefined) return { text: "", truncated: false, spillPath: undefined };
  try {
    return reader.readFrom(0);
  } catch {
    return { text: "", truncated: false, spillPath: undefined };
  }
}

/**
 * 运行一个 argv，并按官方 pwsh 工具的词表渲染结果。
 * @returns {Promise<{ text: string, exitCode: number|null }>}
 */
export async function runProcess(ctx, exec, argv, cwd, options = {}) {
  const subprocess = ctx.subprocess;
  if (subprocess === undefined) throw new Error("subprocess 服务不可用");
  const confined = options.confine === false ? { argv, note: "" } : confine(ctx, exec, argv);

  const env = { NO_COLOR: "1", PAGER: "cat", GIT_PAGER: "cat" };
  const managed = dshEnvironment(ctx, exec);
  for (const key of Object.keys(managed)) env[key] = managed[key];

  let handle;
  try {
    handle = subprocess.spawn({
      argv: confined.argv,
      cwd,
      stdio: {
        stdin: "ignore",
        stdout: { maxBytes: MAX_OUTPUT_BYTES, spill: { maxBytes: MAX_SPILL_BYTES } },
        stderr: { maxBytes: MAX_OUTPUT_BYTES, spill: { maxBytes: MAX_SPILL_BYTES } },
      },
      graceMs: GRACE_MS,
      signal: exec.signal,
      env,
    });
  } catch (error) {
    throw new Error("无法启动进程：" + (error && error.message ? error.message : String(error)));
  }

  let outcome;
  try {
    outcome = await handle.done;
  } catch (error) {
    throw new Error("进程运行失败：" + (error && error.message ? error.message : String(error)));
  }

  const stdout = collect(handle.collected && handle.collected.stdout);
  const stderr = collect(handle.collected && handle.collected.stderr);
  const outText = typeof stdout.text === "string" ? stdout.text : "";
  const errText = typeof stderr.text === "string" ? stderr.text : "";
  const parts = [];
  if (outText.length > 0) parts.push(outText);
  else if (errText.length === 0) parts.push("(no output)");
  if (errText.length > 0) parts.push("[stderr]" + NL + errText);
  if (stdout.truncated && stdout.spillPath) parts.push("[output truncated; full output: " + stdout.spillPath + "]");
  if (stderr.truncated && stderr.spillPath) parts.push("[stderr truncated; full stderr: " + stderr.spillPath + "]");
  if (confined.note.length > 0) parts.push(confined.note);
  const exitCode = outcome && typeof outcome.exitCode === "number" ? outcome.exitCode : null;
  const signalName = outcome && outcome.signal ? String(outcome.signal) : "";
  if (signalName.length > 0) parts.push("[killed by signal: " + signalName + "]");
  else if (exitCode !== null && exitCode !== 0) parts.push("[exit code: " + exitCode + "]");
  else if (exitCode === null) parts.push("[exit status unknown]");
  if (exec.signal && exec.signal.aborted) parts.push("[aborted: timeout or cancellation]");

  return { text: parts.join(NL), exitCode };
}

/** 组装一次 PowerShell 调用（前台执行与后台任务共用）。 */
export async function preparePowerShell(ctx, exec, script, argList = [], options = {}) {
  const shell = await resolveShell(ctx, exec, options.shell);
  const full = buildInlineScript(script, argList);
  const argv = buildPowerShellArgv(shell, full);
  const cwd = resolveCwd(ctx, exec, options.cwd, "用 pwsh_run 的 cwd 参数显式指定");
  return { shell, argv, cwd, encoded: argv.includes("-EncodedCommand") };
}

/** 执行一段 PowerShell 正文（UTF-8 前导 + $DSH_ARGS + 沙箱）。 */
export async function runPowerShell(ctx, exec, script, argList = [], options = {}) {
  const prepared = await preparePowerShell(ctx, exec, script, argList, options);
  const result = await runProcess(ctx, exec, prepared.argv, prepared.cwd);
  return { ...result, shell: prepared.shell, encoded: prepared.encoded };
}