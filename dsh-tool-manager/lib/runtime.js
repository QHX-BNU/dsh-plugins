/**
 * dsh-tool-manager —— 自定义工具执行器（node:vm 沙箱）
 *
 * 用户在面板/Agent 中填写的工具逻辑是一段 JS 函数体：
 *
 *   async (args, helpers) => { ...; return value; }
 *
 * 执行器用 node:vm 的 Script + 独立 context 运行：
 * - 沙箱只暴露 args/helpers 与少量标准全局（JSON/Math/Date/URL/Promise 等），
 *   没有 process / require / module，宿主能力只能通过 helpers 显式获得；
 * - helpers.require = createRequire(插件目录) —— 需要 Node 内置模块或本地包时
 *   显式声明使用（与 pwsh/bash 工具同级权限，README 中有安全说明）；
 * - helpers.fetch = 全局 fetch（Node 18+），可用于调用外部 HTTP 服务；
 * - 超时保护：默认 30s，超时抛错；面板测试运行支持中止信号。
 *
 * 返回值必须是可 JSON 序列化的值（字符串/对象/数组/标量），否则报错。
 */
import vm from 'node:vm';
import { createRequire } from 'node:module';

/** 单次运行默认超时（毫秒）。 */
export const DEFAULT_RUN_TIMEOUT_MS = 30 * 1000;

/** 构建注入自定义工具代码的宿主 helpers（registry 与面板测试共用）。 */
export function buildHelpers() {
  const requireFn = createRequire(import.meta.url);
  let envSnapshot;
  try {
    envSnapshot = Object.freeze({ ...process.env });
  } catch {
    envSnapshot = Object.freeze({});
  }
  return {
    /** 记录到工具运行日志（面板与模型输出可见）。 */
    log: () => {},
    /** Node require（相对插件目录解析）：按需引入内置模块或本地依赖。 */
    require: requireFn,
    /** 全局 fetch（Node 18+）。 */
    fetch: typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined,
    /** 当前时间戳。 */
    now: () => Date.now(),
    /** 只读环境变量快照。 */
    env: envSnapshot,
  };
}

/** 沙箱内可用的标准全局（白名单复制，避免继承宿主全局对象）。 */
const SANDBOX_GLOBALS = {
  JSON, Math, Date, RegExp, Error, TypeError, RangeError, SyntaxError,
  Promise, Array, Object, String, Number, Boolean, Map, Set, WeakMap, WeakSet,
  Symbol, BigInt, parseInt, parseFloat, isNaN, isFinite,
  encodeURIComponent, decodeURIComponent, encodeURI, decodeURI,
  URL, URLSearchParams, TextEncoder, TextDecoder, AbortController, AbortSignal,
  setTimeout, clearTimeout, setInterval, clearInterval,
};

/** 仅编译校验一段工具代码的语法（不执行），供保存/创建时预检。 */
export function checkToolCodeSyntax(code) {
  try {
    new vm.Script(`(async function (__args, __helpers) {\n${code}\n})`, { filename: 'custom-tool.js' });
    return undefined;
  } catch (err) {
    return err && err.message ? err.message : String(err);
  }
}

/** 把任意值转成可读文本（用于 console 日志）。 */
function fmtValue(value) {
  try {
    if (typeof value === 'string') return value;
    if (value === undefined) return 'undefined';
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * 编译并执行一段工具代码。
 * @param code      工具逻辑（async (args, helpers) => { ... } 的函数体）
 * @param args      工具参数（已通过 schema 校验的 JSON 值）
 * @param helpers   注入的宿主能力 { log, require, fetch, now, env }
 * @param opts      { timeoutMs, signal }
 * @returns Promise<{ value, logs }>
 */
export async function runToolCode(code, args, helpers, opts = {}) {
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
    ? opts.timeoutMs
    : DEFAULT_RUN_TIMEOUT_MS;
  const logs = [];
  const log = (...parts) => logs.push(parts.map(fmtValue).join(' '));

  const sandbox = {
    ...SANDBOX_GLOBALS,
    args,
    helpers,
    console: {
      log,
      info: log,
      warn: log,
      error: log,
      debug: log,
    },
  };
  sandbox.globalThis = sandbox;

  let fn;
  try {
    const script = new vm.Script(
      `(async function (__args, __helpers) {\n${code}\n})`,
      { filename: 'custom-tool.js' },
    );
    const context = vm.createContext(sandbox);
    fn = script.runInContext(context);
  } catch (err) {
    throw new Error(`工具代码编译失败：${err && err.message ? err.message : String(err)}`);
  }

  const run = async () => {
    const value = await fn(args, helpers);
    // 验证返回值可 JSON 序列化
    try {
      JSON.stringify(value === undefined ? null : value);
    } catch {
      throw new Error('工具返回值必须是可 JSON 序列化的值（字符串/数字/布尔/对象/数组）');
    }
    return value;
  };

  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`工具执行超时（${Math.round(timeoutMs / 1000)}s）`)), timeoutMs);
  });
  const abort = opts.signal
    ? new Promise((_, reject) => {
        const onAbort = () => reject(new Error(`执行已中止：${String(opts.signal.reason || '用户取消')}`));
        if (opts.signal.aborted) onAbort();
        else opts.signal.addEventListener('abort', onAbort, { once: true });
      })
    : undefined;

  try {
    const value = await Promise.race([run(), timeout, ...(abort ? [abort] : [])]);
    return { value, logs };
  } finally {
    clearTimeout(timer);
  }
}
