/**
 * dsh-pwsh-guard — 后台任务适配（零依赖）
 *
 * 两种模式：
 *   1. jobs  —— 部署里存在可用的 jobs 控制器（ctx.jobs）时，注册成官方后台任务，
 *               内置 job_list / job_output / job_kill 可直接操作；
 *   2. local —— 精简 profile 往往没有 job 控制器（jobs.start 会拒绝），此时
 *               退化为插件自管的本地任务，用 pwsh_job 工具读取/终止。
 * 两种模式共用同一套 spawn / 沙箱 confine / DSH_* 环境逻辑。
 */

import { confine, dshEnvironment, preparePowerShell } from "./exec.js";

const MAX_OUTPUT_BYTES = 64000;
const MAX_SPILL_BYTES = 67108864;
const GRACE_MS = 3000;
const MAX_LOCAL_JOBS = 16;

/** 本地任务表：id -> record */
const localJobs = new Map();
let localCounter = 0;

/** 取 jobs 服务（不存在或形状不符时返回 undefined）。 */
export function jobsOf(ctx) {
  try {
    const jobs = ctx.get("jobs");
    if (jobs && typeof jobs.start === "function") return jobs;
  } catch {
    /* ignore */
  }
  return undefined;
}

/** 共享的 spawn 逻辑：confine + 受管环境 + collect stdio。 */
function makeSpawner(ctx, exec, prepared) {
  const confined = confine(ctx, exec, prepared.argv);
  const env = { NO_COLOR: "1", PAGER: "cat", GIT_PAGER: "cat" };
  const managed = dshEnvironment(ctx, exec);
  for (const key of Object.keys(managed)) env[key] = managed[key];
  return (signal) => ctx.subprocess.spawn({
    argv: confined.argv,
    cwd: prepared.cwd,
    stdio: {
      stdin: "ignore",
      stdout: { maxBytes: MAX_OUTPUT_BYTES, spill: { maxBytes: MAX_SPILL_BYTES } },
      stderr: { maxBytes: MAX_OUTPUT_BYTES, spill: { maxBytes: MAX_SPILL_BYTES } },
    },
    graceMs: GRACE_MS,
    signal,
    env,
  });
}

function terminate(handle) {
  if (!handle) return;
  try {
    if (typeof handle.terminate === "function") handle.terminate();
    else if (typeof handle.kill === "function") handle.kill();
  } catch {
    /* ignore */
  }
}

function pruneLocalJobs() {
  if (localJobs.size < MAX_LOCAL_JOBS) return;
  for (const [id, record] of localJobs) {
    if (record.settled) {
      localJobs.delete(id);
      if (localJobs.size < MAX_LOCAL_JOBS) return;
    }
  }
}

/**
 * 启动一个 pwsh 后台任务。
 * @returns {Promise<{ id: string, mode: "jobs" | "local" }>}
 */
export async function startPowerShellBackground(ctx, exec, script, argList = [], options = {}) {
  const prepared = await preparePowerShell(ctx, exec, script, argList, options);
  const label = typeof options.label === "string" && options.label.length > 0 ? options.label.slice(0, 200) : "pwsh (background)";
  const jobs = jobsOf(ctx);

  if (jobs !== undefined) {
    try {
      const spawnOne = makeSpawner(ctx, exec, prepared);
      let handle;
      const output = ["stdout", "stderr"].map((channel) => ({
        channel,
        read: (fromByte) => {
          const live = handle;
          if (!live || !live.collected || !live.collected[channel]) return { text: "", nextOffset: fromByte, lossy: false };
          try {
            return live.collected[channel].readFrom(fromByte);
          } catch {
            return { text: "", nextOffset: fromByte, lossy: false };
          }
        },
      }));
      const run = () => {
        const controller = new AbortController();
        const done = (async () => {
          try {
            const proc = spawnOne(controller.signal);
            handle = proc;
            const outcome = await proc.done;
            if (outcome && outcome.signal) return { status: "killed", detail: "signal: " + String(outcome.signal) };
            const code = outcome && typeof outcome.exitCode === "number" ? outcome.exitCode : 0;
            return { status: "completed", detail: "exit code: " + String(code) };
          } catch (error) {
            return { status: "failed", detail: error && error.message ? error.message : String(error) };
          }
        })();
        return {
          cancel: () => {
            try { controller.abort(); } catch { /* ignore */ }
            terminate(handle);
          },
          done,
        };
      };
      const spec = { kind: "pwsh", label, output, run };
      if (exec && exec.agent && exec.agent.id !== undefined) spec.owner = exec.agent.id;
      const id = jobs.start(spec);
      return { id: String(id), mode: "jobs" };
    } catch {
      /* 该 agent 没有 job 控制器：落到本地托管 */
    }
  }

  return { id: startLocalJob(ctx, exec, prepared, label), mode: "local" };
}

/** 本地托管：进程句柄存表，输出按 offset 增量读取。 */
function startLocalJob(ctx, exec, prepared, label) {
  pruneLocalJobs();
  if (localJobs.size >= MAX_LOCAL_JOBS) {
    throw new Error("本地后台任务已达上限 " + MAX_LOCAL_JOBS + " 个；先 pwsh_job { action: \"list\" } 查看并清理");
  }
  const spawnOne = makeSpawner(ctx, exec, prepared);
  let handle;
  try {
    handle = spawnOne(undefined);
  } catch (error) {
    throw new Error("后台启动失败：" + (error && error.message ? error.message : String(error)));
  }
  localCounter += 1;
  const id = "pwshg-" + localCounter + "-" + Math.random().toString(36).slice(2, 8);
  const record = {
    id,
    label,
    cwd: prepared.cwd,
    startedAt: Date.now(),
    settled: false,
    exitCode: null,
    signal: null,
    error: undefined,
    cursors: { stdout: 0, stderr: 0 },
    handle,
  };
  localJobs.set(id, record);
  Promise.resolve(handle.done).then(
    (outcome) => {
      record.settled = true;
      record.exitCode = outcome && typeof outcome.exitCode === "number" ? outcome.exitCode : null;
      record.signal = outcome && outcome.signal ? String(outcome.signal) : null;
    },
    (error) => {
      record.settled = true;
      record.error = error && error.message ? error.message : String(error);
    },
  );
  return id;
}

/** 列出本地托管任务。 */
export function listLocalJobs() {
  return [...localJobs.values()].map((record) => ({
    id: record.id,
    label: record.label,
    settled: record.settled,
    exitCode: record.exitCode,
    signal: record.signal,
    error: record.error,
    startedAt: record.startedAt,
  }));
}

function readChannel(record, channel) {
  const handle = record.handle;
  if (!handle || !handle.collected || !handle.collected[channel]) return "";
  try {
    const read = handle.collected[channel].readFrom(record.cursors[channel]);
    if (read && typeof read.nextOffset === "number") record.cursors[channel] = read.nextOffset;
    return read && typeof read.text === "string" ? read.text : "";
  } catch {
    return "";
  }
}

/**
 * 读取本地任务的增量输出；未知 id 返回 undefined（调用方据此提示官方工具）。
 */
export function readLocalJob(id) {
  const record = localJobs.get(id);
  if (record === undefined) return undefined;
  const stdout = readChannel(record, "stdout");
  const stderr = readChannel(record, "stderr");
  const parts = [];
  if (stdout.length > 0) parts.push(stdout);
  if (stderr.length > 0) parts.push("[stderr]\n" + stderr);
  if (parts.length === 0) parts.push("(no new output)");
  const status = record.settled
    ? (record.error !== undefined
        ? "failed: " + record.error
        : "exited: " + (record.exitCode === null ? "unknown" : String(record.exitCode)) + (record.signal ? " (signal " + record.signal + ")" : ""))
    : "running";
  parts.push("[job " + id + " " + status + "]");
  return parts.join("\n");
}

/** 终止本地任务；未知 id 返回 undefined。 */
export function killLocalJob(id) {
  const record = localJobs.get(id);
  if (record === undefined) return undefined;
  terminate(record.handle);
  return true;
}

/** 插件卸载/热更新时清理全部本地任务。 */
export function clearLocalJobs() {
  for (const record of localJobs.values()) terminate(record.handle);
  localJobs.clear();
}