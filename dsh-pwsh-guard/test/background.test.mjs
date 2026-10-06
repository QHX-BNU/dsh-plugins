import { test } from "node:test";
import assert from "node:assert/strict";
import { jobsOf, startPowerShellBackground, listLocalJobs, readLocalJob, killLocalJob, clearLocalJobs } from "../lib/background.js";

function makeCtx(overrides = {}) {
  const state = { spawns: [], specs: [], terminated: 0 };
  const subprocess = {
    async resolveExecutable(name) {
      return "C:\\fake\\" + name;
    },
    spawn(options) {
      state.spawns.push(options);
      return {
        collected: {
          stdout: { readFrom: (from) => ({ text: "out", nextOffset: from + 3, lossy: false }) },
          stderr: { readFrom: (from) => ({ text: "", nextOffset: from, lossy: false }) },
        },
        done: overrides.neverSettle
          ? new Promise(() => {})
          : Promise.resolve(overrides.outcome === undefined ? { exitCode: 0 } : overrides.outcome),
        terminate() {
          state.terminated += 1;
        },
      };
    },
  };
  const jobs = overrides.jobs === undefined ? { start: (spec) => { state.specs.push(spec); return "job-1"; } } : overrides.jobs;
  const ctx = {
    subprocess,
    get(name) {
      return name === "jobs" ? jobs : undefined;
    },
  };
  return { ctx, state };
}

function execWith(cwd = "D:\\ws") {
  return { name: "pwsh_run", arguments: {}, agent: { id: "agent-1", session: { header: { cwd } } }, signal: undefined };
}

test("jobsOf：只有带 start 的服务才算可用", () => {
  const { ctx } = makeCtx();
  assert.ok(jobsOf(ctx));
  assert.equal(jobsOf({ get: () => undefined }), undefined);
  assert.equal(jobsOf({ get: () => ({}) }), undefined);
});

test("jobs 模式：注册的 spec 形状正确", async () => {
  const { ctx, state } = makeCtx();
  const started = await startPowerShellBackground(ctx, execWith(), "Get-Date", ["a"], { label: "demo" });
  assert.equal(started.mode, "jobs");
  assert.equal(started.id, "job-1");
  assert.equal(state.specs.length, 1);
  const spec = state.specs[0];
  assert.equal(spec.kind, "pwsh");
  assert.equal(spec.label, "demo");
  assert.equal(spec.owner, "agent-1");
  assert.deepEqual(spec.output.map((s) => s.channel), ["stdout", "stderr"]);
  assert.equal(typeof spec.run, "function");
});

test("jobs 模式：run() 的 done 映射为 completed / killed", async () => {
  const completed = makeCtx();
  await startPowerShellBackground(completed.ctx, execWith(), "Get-Date", []);
  const outcome = await completed.state.specs[0].run().done;
  assert.equal(outcome.status, "completed");
  assert.match(outcome.detail, /exit code: 0/);

  const killed = makeCtx({ outcome: { exitCode: null, signal: "SIGTERM" } });
  await startPowerShellBackground(killed.ctx, execWith(), "Get-Date", []);
  const outcome2 = await killed.state.specs[0].run().done;
  assert.equal(outcome2.status, "killed");
  assert.match(outcome2.detail, /SIGTERM/);
});

test("jobs 模式：输出源转发到进程读取器", async () => {
  const { ctx, state } = makeCtx();
  await startPowerShellBackground(ctx, execWith(), "Get-Date", []);
  state.specs[0].run();
  const chunk = state.specs[0].output[0].read(0);
  assert.equal(chunk.text, "out");
  assert.equal(chunk.nextOffset, 3);
});

test("降级：jobs.start 抛错（没有 controller）时用本地托管", async () => {
  const boom = { start: () => { throw new Error("no job controller serves this agent"); } };
  const { ctx, state } = makeCtx({ jobs: boom });
  const started = await startPowerShellBackground(ctx, execWith(), "Get-Date", [], { label: "fallback" });
  assert.equal(started.mode, "local");
  assert.match(started.id, /^pwshg-/);
  assert.equal(state.spawns.length, 1);
  const jobs = listLocalJobs();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].label, "fallback");
  clearLocalJobs();
});

test("降级：完全没有 jobs 服务时同样本地托管并可读可杀", async () => {
  const { ctx, state } = makeCtx({ jobs: null });
  const started = await startPowerShellBackground(ctx, execWith(), "Get-Date", []);
  assert.equal(started.mode, "local");
  assert.equal(readLocalJob("nope"), undefined);
  const text = readLocalJob(started.id);
  assert.match(text, /out/);
  await Promise.resolve();
  await Promise.resolve();
  const settled = listLocalJobs().find((j) => j.id === started.id);
  assert.equal(settled.settled, true);
  assert.equal(settled.exitCode, 0);
  assert.equal(killLocalJob("nope"), undefined);
  assert.equal(killLocalJob(started.id), true);
  assert.equal(state.terminated, 1);
  clearLocalJobs();
  assert.equal(listLocalJobs().length, 0);
});

test("降级：本地任务达到上限时明确报错", async () => {
  clearLocalJobs();
  const { ctx } = makeCtx({ jobs: null, neverSettle: true });
  const ids = [];
  for (let i = 0; i < 16; i++) ids.push((await startPowerShellBackground(ctx, execWith(), "Get-Date", [])).id);
  assert.equal(ids.length, 16);
  await assert.rejects(() => startPowerShellBackground(ctx, execWith(), "Get-Date", []), /上限/);
  clearLocalJobs();
});