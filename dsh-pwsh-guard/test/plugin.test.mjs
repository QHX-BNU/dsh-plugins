import { test } from "node:test";
import assert from "node:assert/strict";
import { apply } from "../lib/index.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 测试默认不写真实审计日志（审计用例内部会临时解除）
process.env.DSH_GUARD_NO_AUDIT = "1";

/** 构造一个最小可用的假 ctx（不依赖真实 harness）。 */
function makeHarness(overrides = {}) {
  const state = { tools: [], gate: undefined, post: undefined, providers: [], warnings: [], infos: [], spawns: [], events: [], effects: [] };
  const subprocess = overrides.subprocess || {
    async resolveExecutable(name) {
      return "C:\\fake\\" + name;
    },
    spawn(options) {
      state.spawns.push(options);
      const stdin = options && options.stdio && options.stdio.stdin;
      const isProbe = !!(stdin && typeof stdin === "object" && typeof stdin.data === "string");
      let text;
      if (isProbe && overrides.deepPayload) text = JSON.stringify(overrides.deepPayload);
      else text = overrides.stdout === undefined ? "hello" : overrides.stdout;
      return {
        collected: {
          stdout: { readFrom: () => ({ text, truncated: false }) },
          stderr: { readFrom: () => ({ text: overrides.stderr || "", truncated: false }) },
        },
        done: Promise.resolve({ exitCode: overrides.exitCode === undefined ? 0 : overrides.exitCode }),
      };
    },
  };
  const ctx = {
    logger: { warn: (m) => state.warnings.push(String(m)), info: (m) => state.infos.push(String(m)) },
    on(event, fn) {
      state.events.push({ event, fn });
      if (event === "tools/pre-execute") state.gate = fn;
      if (event === "tools/post-execute") state.post = fn;
    },
    effect(fn) {
      const dispose = fn();
      state.effects.push(dispose);
      return dispose;
    },
    get(name) {
      return overrides.services ? overrides.services[name] : undefined;
    },
    skills: { registerProvider: (fn) => state.providers.push(fn) },
    tools: { register: (def) => state.tools.push(def) },
    subprocess,
  };
  return { ctx, state };
}

function execWith(command, cwd = "D:\\ws") {
  return {
    name: "pwsh",
    arguments: { command },
    agent: { session: { header: { cwd } } },
    signal: undefined,
  };
}

const OK_PAYLOAD = { ok: true, errors: [], pssaStatus: "skipped", pssaErrors: [], pssaWarnings: [] };
const AST_ERR_PAYLOAD = {
  ok: false,
  errors: [{ id: "MissingEndCurlyBrace", message: "缺少右 }", line: 2, column: 14, text: "{" }],
  pssaStatus: "skipped",
  pssaErrors: [],
  pssaWarnings: [],
};

test("注册：3 个工具 + 2 个钩子 + 1 个 skill provider", () => {
  const { ctx, state } = makeHarness();
  apply(ctx, {});
  assert.deepEqual(state.tools.map((t) => t.name).sort(), ["pwsh_analyzer", "pwsh_audit", "pwsh_check", "pwsh_job", "pwsh_run", "run_argv"]);
  assert.equal(typeof state.gate, "function");
  assert.equal(typeof state.post, "function");
  assert.equal(state.providers.length, 1);
  for (const tool of state.tools) {
    assert.ok(tool.description.length > 0, tool.name + " 缺描述");
    assert.ok(tool.parameters && tool.parameters.type === "object");
    assert.equal(typeof tool.execute, "function");
    assert.ok(tool.output && tool.output.render, tool.name + " 缺 output.render");
  }
});

test("skill provider 能返回 SKILL.md 内容", async () => {
  const { ctx, state } = makeHarness();
  apply(ctx, {});
  const provider = state.providers[0]();
  const list = await provider.list();
  assert.equal(list.length, 1);
  const skill = await provider.get(list[0]);
  assert.match(skill.content, /PowerShell/);
  assert.equal(skill.name, "pwsh-guard");
});

test("闸门：阻断级命令 deny，并给出规则与修复命令", async () => {
  const { ctx, state } = makeHarness();
  apply(ctx, { mode: "deny" });
  const decision = await state.gate(execWith("git add . && git commit -m x"), () => ({ kind: "allow" }));
  assert.equal(decision.kind, "deny");
  assert.match(decision.reason, /R11/);
  assert.match(decision.reason, /if \(\$\?\)/);
  assert.match(decision.reason, /pwsh_run/);
});

test("闸门：干净命令放行", async () => {
  const { ctx, state } = makeHarness();
  apply(ctx, {});
  const decision = await state.gate(execWith('Get-ChildItem -Recurse -File | Select-String "foo"'), () => ({ kind: "allow" }));
  assert.equal(decision.kind, "allow");
});

test("闸门：here-string 内容不误报", async () => {
  const { ctx, state } = makeHarness();
  apply(ctx, {});
  const script = "$c = @'\nnpm install x && echo a ? b : c\n'@\nSet-Content -Path out.txt -Value $c";
  const decision = await state.gate(execWith(script), () => ({ kind: "allow" }));
  assert.equal(decision.kind, "allow");
});

test("闸门：deepCheck=all 时 AST 语法错误被 deny", async () => {
  const { ctx, state } = makeHarness({ deepPayload: AST_ERR_PAYLOAD });
  apply(ctx, { deepCheck: "all" });
  const decision = await state.gate(execWith("Write-Output (1"), () => ({ kind: "allow" }));
  assert.equal(decision.kind, "deny");
  assert.match(decision.reason, /语法解析失败|parse error/);
  assert.match(decision.reason, /L2:C14/);
});

test("闸门：deepCheck=run（默认）时不做 AST，避免每条命令变慢", async () => {
  const { ctx, state } = makeHarness({ deepPayload: AST_ERR_PAYLOAD });
  apply(ctx, {});
  const decision = await state.gate(execWith("Write-Output (1"), () => ({ kind: "allow" }));
  assert.equal(decision.kind, "allow");
});

test("闸门：非 pwsh 工具与空命令不干预", async () => {
  const { ctx, state } = makeHarness();
  apply(ctx, {});
  const other = await state.gate({ name: "read", arguments: {} }, () => ({ kind: "allow" }));
  assert.equal(other.kind, "allow");
  const empty = await state.gate(execWith("   "), () => ({ kind: "allow" }));
  assert.equal(empty.kind, "allow");
});

test("闸门：warn 模式放行但记录日志；off 模式不检查", async () => {
  const h1 = makeHarness();
  apply(h1.ctx, { mode: "warn" });
  const d1 = await h1.state.gate(execWith("npm install x"), () => ({ kind: "allow" }));
  assert.equal(d1.kind, "allow");
  assert.ok(h1.state.warnings.some((w) => w.includes("R10")));

  const h2 = makeHarness();
  apply(h2.ctx, { mode: "off" });
  const d2 = await h2.state.gate(execWith("npm install x"), () => ({ kind: "allow" }));
  assert.equal(d2.kind, "allow");
  assert.equal(h2.state.warnings.length, 0);
});

test("闸门：disableRules 生效", async () => {
  const { ctx, state } = makeHarness();
  apply(ctx, { disableRules: ["R11"] });
  const decision = await state.gate(execWith("git add . && git commit -m x"), () => ({ kind: "allow" }));
  assert.equal(decision.kind, "allow");
});

test("输出防护：疑似乱码追加提示，正常输出放行", async () => {
  const { ctx, state } = makeHarness();
  apply(ctx, {});
  const bad = await state.post(execWith("x"), { content: [{ type: "text", text: "锟斤拷乱码" }] }, () => ({ kind: "accept" }));
  assert.equal(bad.kind, "accept");
  assert.equal(bad.content.length, 2);
  assert.match(bad.content[1].text, /pwsh_run/);

  const good = await state.post(execWith("x"), { content: [{ type: "text", text: "normal output" }] }, () => ({ kind: "accept" }));
  assert.equal(good.kind, "accept");
  assert.equal(good.content, undefined);

  const other = await state.post({ name: "read" }, { content: [{ type: "text", text: "锟斤拷" }] }, () => ({ kind: "accept" }));
  assert.equal(other.content, undefined);
});

test("pwsh_check：检查 + 修复建议 + AST 结果（不执行）", async () => {
  const { ctx, state } = makeHarness({ deepPayload: OK_PAYLOAD });
  apply(ctx, {});
  const tool = state.tools.find((t) => t.name === "pwsh_check");
  const res = await tool.execute({ script: "npm install x", fix: true }, execWith(""));
  assert.match(res.text, /R10/);
  assert.match(res.text, /npm\.cmd/);
  assert.match(res.text, /AST/);
  assert.match(res.text, /语法通过/);
  assert.equal(state.spawns.length, 1);
  assert.ok(state.spawns[0].stdio.stdin.data.length > 0, "探针应通过 stdin 传脚本");
});

test("pwsh_check：干净脚本 PASS", async () => {
  const { ctx, state } = makeHarness({ deepPayload: OK_PAYLOAD });
  apply(ctx, {});
  const tool = state.tools.find((t) => t.name === "pwsh_check");
  const res = await tool.execute({ script: "Get-ChildItem . | Select-Object Name" }, execWith(""));
  assert.match(res.text, /PASS/);
});

test("pwsh_check：deepCheck=off 时不跑探针", async () => {
  const { ctx, state } = makeHarness({ deepPayload: OK_PAYLOAD });
  apply(ctx, { deepCheck: "off" });
  const tool = state.tools.find((t) => t.name === "pwsh_check");
  await tool.execute({ script: "Get-Date" }, execWith(""));
  assert.equal(state.spawns.length, 0);
});

test("pwsh_run：自动修复 + UTF-8 前导 + $DSH_ARGS + 沙箱词表", async () => {
  const { ctx, state } = makeHarness({ stdout: "installed", deepPayload: OK_PAYLOAD });
  apply(ctx, {});
  const tool = state.tools.find((t) => t.name === "pwsh_run");
  const res = await tool.execute({ script: "npm install x && ls -la .", args: ["a'b"] }, execWith(""));
  assert.match(res.text, /npm\.cmd install x/);
  assert.match(res.text, /installed/);
  const execCall = state.spawns.find((s) => !(s.stdio && s.stdio.stdin && s.stdio.stdin.data));
  assert.ok(execCall, "应有一个执行进程");
  assert.ok(execCall.argv.indexOf("-Command") >= 0);
  const script = execCall.argv[execCall.argv.length - 1];
  assert.match(script, /OutputEncoding/);
  assert.match(script, /chcp 65001/);
  assert.match(script, /\$DSH_ARGS = @\('a''b'\)/);
  assert.equal(execCall.cwd, "D:\\ws");
});

test("pwsh_run：AST 语法错误时拒绝执行（force=false）", async () => {
  const { ctx, state } = makeHarness({ deepPayload: AST_ERR_PAYLOAD });
  apply(ctx, {});
  const tool = state.tools.find((t) => t.name === "pwsh_run");
  const res = await tool.execute({ script: "Write-Output (1", fix: false }, execWith(""));
  assert.match(res.text, /未执行/);
  assert.match(res.text, /L2:C14/);
  assert.equal(state.spawns.length, 1, "只应跑过探针，不应执行脚本");
});

test("pwsh_run：阻断级命令拒绝执行（force=false）", async () => {
  const { ctx, state } = makeHarness();
  apply(ctx, { autoFix: false, deepCheck: "off" });
  const tool = state.tools.find((t) => t.name === "pwsh_run");
  const res = await tool.execute({ script: "$x: 1" }, execWith(""));
  assert.match(res.text, /未执行/);
  assert.equal(state.spawns.length, 0);
});

test("pwsh_run：force=true 跳过检查并执行", async () => {
  const { ctx, state } = makeHarness();
  apply(ctx, { autoFix: false, deepCheck: "off" });
  const tool = state.tools.find((t) => t.name === "pwsh_run");
  const res = await tool.execute({ script: "$x: 1", force: true }, execWith(""));
  assert.match(res.text, /force=true/);
  assert.equal(state.spawns.length, 1);
});

test("pwsh_run：超长脚本切 -EncodedCommand", async () => {
  const { ctx, state } = makeHarness();
  apply(ctx, { deepCheck: "off" });
  const tool = state.tools.find((t) => t.name === "pwsh_run");
  const long = "Write-Output 'x'\n".repeat(3000);
  await tool.execute({ script: long, fix: false }, execWith(""));
  assert.ok(state.spawns[0].argv.includes("-EncodedCommand"));
});

test("run_argv：argv 逐字传递，不经 shell", async () => {
  const { ctx, state } = makeHarness();
  apply(ctx, {});
  const tool = state.tools.find((t) => t.name === "run_argv");
  await tool.execute({ program: "git", args: ["commit", "-m", 'a"b'] }, execWith(""));
  assert.deepEqual(state.spawns[0].argv, ["C:\\fake\\git", "commit", "-m", 'a"b']);
});

test("沙箱缺少时直接运行；有 sandbox 时走 confine", async () => {
  const confined = [];
  const { ctx, state } = makeHarness({
    services: {
      sandboxPolicy: { resolve: () => ({ mode: "workspace-write", workspaceRoot: "D:\\ws" }) },
      sandbox: {
        confine: (argv, policy) => {
          confined.push(policy.mode);
          return { argv: ["WRAP"].concat(argv), enforcement: "partial" };
        },
      },
    },
  });
  apply(ctx, {});
  const tool = state.tools.find((t) => t.name === "run_argv");
  await tool.execute({ program: "git", args: ["status"] }, execWith(""));
  assert.deepEqual(confined, ["workspace-write"]);
  assert.equal(state.spawns[0].argv[0], "WRAP");
});

test("接管：takeover=replace 时在 agent scope 上隐藏 pwsh（可卸载）", () => {
  const restrictCalls = [];
  const disposed = [];
  const mkAgent = (tag) => ({
    ctx: { tools: { restrict: (filter) => { restrictCalls.push(filter); return () => disposed.push(tag); } } },
  });
  const agentA = mkAgent("A");
  const { ctx, state } = makeHarness({ services: { agents: { list: () => [agentA] } } });
  apply(ctx, { takeover: "replace" });
  assert.equal(restrictCalls.length, 1, "已有 agent 应被安装接管");
  assert.deepEqual(restrictCalls[0], { deny: ["pwsh"] });

  const created = state.events.find((e) => e.event === "agent/created");
  assert.ok(created, "应监听 agent/created");
  const agentB = mkAgent("B");
  created.fn({ agent: agentB });
  assert.equal(restrictCalls.length, 2, "新 agent 也应被接管");

  const disposedEvent = state.events.find((e) => e.event === "agent/disposed");
  assert.ok(disposedEvent, "应监听 agent/disposed");
  disposedEvent.fn({ agent: agentB });
  assert.deepEqual(disposed, ["B"], "disposed 时应卸载 restriction");
});

test("接管：takeover=off（默认）不调用 restrict", () => {
  const restrictCalls = [];
  const agent = { ctx: { tools: { restrict: (f) => { restrictCalls.push(f); return () => {}; } } } };
  const { ctx } = makeHarness({ services: { agents: { list: () => [agent] } } });
  apply(ctx, {});
  assert.equal(restrictCalls.length, 0);
});

test("接管：replace 模式下 system prompt 说明已接管", () => {
  const sections = [];
  const { ctx } = makeHarness();
  ctx.get = (service) => (service === "systemPrompt" ? { section: (s) => sections.push(s) } : undefined);
  apply(ctx, { takeover: "replace" });
  assert.equal(sections.length, 1);
  assert.match(sections[0].text, /已接管/);
  assert.match(sections[0].text, /pwsh_run/);
});

test("pwsh_analyzer：status 检测已安装", async () => {
  const { ctx, state } = makeHarness({ stdout: "OK:1.23.0" });
  apply(ctx, {});
  const tool = state.tools.find((t) => t.name === "pwsh_analyzer");
  const res = await tool.execute({ action: "status" }, execWith(""));
  assert.match(res.text, /OK:1\.23\.0/);
  assert.equal(state.spawns.length, 1);
});

test("pwsh_analyzer：status 未安装时提示一键安装", async () => {
  const { ctx, state } = makeHarness({ stdout: "MISSING" });
  apply(ctx, {});
  const tool = state.tools.find((t) => t.name === "pwsh_analyzer");
  const res = await tool.execute({ action: "status" }, execWith(""));
  assert.match(res.text, /未安装/);
  assert.match(res.text, /install/);
});

test("pwsh_analyzer：install 执行安装脚本并回报结果", async () => {
  const { ctx, state } = makeHarness({ stdout: "INSTALLED\nOK:1.24.0" });
  apply(ctx, {});
  const tool = state.tools.find((t) => t.name === "pwsh_analyzer");
  const res = await tool.execute({ action: "install" }, execWith(""));
  assert.match(res.text, /安装完成/);
  const argv = state.spawns[0].argv;
  const script = argv[argv.length - 1];
  assert.match(script, /Install-Module PSScriptAnalyzer/);
  assert.match(script, /-Scope CurrentUser/);
  assert.match(script, /-Confirm:\$false/);
  assert.match(script, /Install-PackageProvider -Name NuGet/);
});

test("pwsh_check：PSSA 未安装时给出一键安装指引", async () => {
  const { ctx, state } = makeHarness({ deepPayload: { ok: true, errors: [], pssaStatus: "missing", pssaErrors: [], pssaWarnings: [] } });
  apply(ctx, { analyzer: "psscriptanalyzer" });
  const tool = state.tools.find((t) => t.name === "pwsh_check");
  const res = await tool.execute({ script: "Get-Date" }, execWith(""));
  assert.match(res.text, /pwsh_analyzer/);
});

test("pwsh_run：background=true 在有 job 控制器时注册到 jobs", async () => {
  const specs = [];
  const { ctx, state } = makeHarness({
    services: { jobs: { start: (spec) => { specs.push(spec); return "job-42"; } } },
  });
  apply(ctx, { deepCheck: "off" });
  const tool = state.tools.find((t) => t.name === "pwsh_run");
  const res = await tool.execute({ script: "Get-Date", background: true }, execWith(""));
  assert.match(res.text, /job-42/);
  assert.match(res.text, /job_output/);
  assert.equal(specs.length, 1);
  assert.equal(specs[0].kind, "pwsh");
  assert.equal(state.spawns.length, 0, "注册阶段不应 spawn，由 jobs 的 run() 决定");
});

test("pwsh_run：background=true 且无 job 控制器时降级为本地托管", async () => {
  const { ctx, state } = makeHarness();
  apply(ctx, { deepCheck: "off" });
  const tool = state.tools.find((t) => t.name === "pwsh_run");
  const res = await tool.execute({ script: "Get-Date", background: true }, execWith(""));
  assert.match(res.text, /pwsh_job/);
  const jobId = (res.text.match(/jobId=(pwshg-[^\s]+)/) || [])[1];
  assert.ok(jobId, "应返回本地 jobId");
  assert.equal(state.spawns.length, 1, "本地模式应立即 spawn");

  const jobTool = state.tools.find((t) => t.name === "pwsh_job");
  const list = await jobTool.execute({ action: "list" }, execWith(""));
  assert.match(list.text, new RegExp(jobId));
  const read = await jobTool.execute({ action: "read", jobId }, execWith(""));
  assert.match(read.text, /hello/);
  const kill = await jobTool.execute({ action: "kill", jobId }, execWith(""));
  assert.match(kill.text, /已终止/);
});

test("pwsh_job：未知 id 时提示官方工具", async () => {
  const { ctx, state } = makeHarness();
  apply(ctx, { deepCheck: "off" });
  const jobTool = state.tools.find((t) => t.name === "pwsh_job");
  const read = await jobTool.execute({ action: "read", jobId: "nope" }, execWith(""));
  assert.match(read.text, /job_output/);
  const kill = await jobTool.execute({ action: "kill", jobId: "nope" }, execWith(""));
  assert.match(kill.text, /job_kill/);
});

test("危险闸：自动修复出的破坏性命令默认拒绝执行", async () => {
  const { ctx, state } = makeHarness();
  apply(ctx, { deepCheck: "off" });
  const tool = state.tools.find((t) => t.name === "pwsh_run");
  const res = await tool.execute({ script: "rm -rf /" }, execWith(""));
  assert.match(res.text, /未执行/);
  assert.match(res.text, /recursiveDelete/);
  assert.equal(state.spawns.length, 0);
});

test("危险闸：dangerous=true 确认后放行", async () => {
  const { ctx, state } = makeHarness();
  apply(ctx, { deepCheck: "off" });
  const tool = state.tools.find((t) => t.name === "pwsh_run");
  const res = await tool.execute({ script: "rm -rf /", dangerous: true }, execWith(""));
  assert.match(res.text, /已确认/);
  assert.equal(state.spawns.length, 1);
});

test("危险闸：项目内递归删除不受影响", async () => {
  const { ctx, state } = makeHarness();
  apply(ctx, { deepCheck: "off" });
  const tool = state.tools.find((t) => t.name === "pwsh_run");
  const res = await tool.execute({ script: "rm -rf ./dist" }, execWith(""));
  assert.equal(state.spawns.length, 1);
  assert.match(res.text, /Remove-Item \.\/dist -Recurse -Force/);
});

test("危险闸：未经修复的原生命令不拦", async () => {
  const { ctx, state } = makeHarness();
  apply(ctx, { deepCheck: "off" });
  const tool = state.tools.find((t) => t.name === "pwsh_run");
  const res = await tool.execute({ script: "Remove-Item C:\\ -Recurse -Force", fix: false }, execWith(""));
  assert.equal(state.spawns.length, 1, "未经修复的原命令应放行");
  assert.match(res.text, /hello/);
});

test("pwsh_check：报告破坏性操作", async () => {
  const { ctx, state } = makeHarness();
  apply(ctx, { deepCheck: "off" });
  const tool = state.tools.find((t) => t.name === "pwsh_check");
  const res = await tool.execute({ script: "Format-Volume -DriveLetter D" }, execWith(""));
  assert.match(res.text, /破坏性/);
  assert.match(res.text, /disk/);
});

test("审计：闸门拒绝 / 自动修复 / 危险拦截都会落盘，pwsh_audit 可读", async () => {
  const home = mkdtempSync(join(tmpdir(), "guard-audit-"));
  const prev = process.env.DSH_HOME;
  const prevNoAudit = process.env.DSH_GUARD_NO_AUDIT;
  delete process.env.DSH_GUARD_NO_AUDIT;
  process.env.DSH_HOME = home;
  try {
    const { ctx, state } = makeHarness();
    apply(ctx, { deepCheck: "off" });

    await state.gate(execWith("npm install x"), () => ({ kind: "allow" }));
    const runTool = state.tools.find((t) => t.name === "pwsh_run");
    await runTool.execute({ script: "npm install x && ls -la" }, execWith(""));
    await runTool.execute({ script: "rm -rf /" }, execWith(""));

    const file = join(home, "storages", "dsh-pwsh-guard", "audit.jsonl");
    const lines = readFileSync(file, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
    const events = lines.map((entry) => entry.event);
    assert.ok(events.includes("deny"), events.join(","));
    assert.ok(events.includes("fix"), events.join(","));
    assert.ok(events.includes("danger-block"), events.join(","));

    const auditTool = state.tools.find((t) => t.name === "pwsh_audit");
    const stats = await auditTool.execute({ action: "stats" }, execWith(""));
    assert.match(stats.text, /deny: 1/);
    assert.match(stats.text, /R10/);
    assert.match(stats.text, /AND_OR_CHAIN/);
    const tail = await auditTool.execute({ action: "tail", limit: 2 }, execWith(""));
    assert.equal(tail.text.trim().split(/\r?\n/).length, 2);
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
    if (prevNoAudit === undefined) delete process.env.DSH_GUARD_NO_AUDIT;
    else process.env.DSH_GUARD_NO_AUDIT = prevNoAudit;
    rmSync(home, { recursive: true, force: true });
  }
});