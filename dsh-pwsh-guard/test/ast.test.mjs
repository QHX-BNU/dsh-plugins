import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { deepCheck, lastJsonLine } from "../lib/ast.js";

/** 找一个可用的 PowerShell（没有就跳过真实进程测试）。 */
function detectShell() {
  for (const name of ["powershell.exe", "pwsh.exe", "pwsh"]) {
    try {
      const r = spawnSync(name, ["-NoProfile", "-Command", "exit 0"], { windowsHide: true });
      if (r && !r.error && r.status === 0) return name;
    } catch {
      /* next */
    }
  }
  return null;
}

const SHELL = detectShell();

/** 用 node:child_process 实现一个最小 subprocess 适配器（走真实 PowerShell）。 */
function realSubprocess(shell) {
  return {
    async resolveExecutable(name) {
      if (name === shell) return shell;
      throw new Error("not found: " + name);
    },
    spawn({ argv, cwd, stdio, env }) {
      const child = spawn(argv[0], argv.slice(1), { cwd, env, windowsHide: true });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => { out += d.toString("utf8"); });
      child.stderr.on("data", (d) => { err += d.toString("utf8"); });
      child.on("error", (e) => { err += String(e && e.message ? e.message : e); });
      const stdin = stdio && stdio.stdin;
      if (stdin && typeof stdin === "object" && typeof stdin.data === "string") {
        child.stdin.write(stdin.data);
        child.stdin.end();
      } else {
        child.stdin.end();
      }
      return {
        collected: {
          stdout: { readFrom: () => ({ text: out, truncated: false }) },
          stderr: { readFrom: () => ({ text: err, truncated: false }) },
        },
        done: new Promise((resolve) => child.on("close", (code) => resolve({ exitCode: code }))),
      };
    },
  };
}

test("lastJsonLine 从混合输出里取最后一行 JSON", () => {
  assert.deepEqual(lastJsonLine('noise line\n{"a":1}\n'), { a: 1 });
  assert.deepEqual(lastJsonLine('{"a":1}\n{"b":2}\n'), { b: 2 });
  assert.equal(lastJsonLine("no json at all"), null);
  assert.equal(lastJsonLine(""), null);
});

test("deepCheck：真实 PowerShell 语法解析", { skip: !SHELL }, async () => {
  const ctx = { subprocess: realSubprocess(SHELL), get: () => undefined };
  const exec = { signal: undefined, agent: { session: { header: { cwd: process.cwd() } } } };

  const good = await deepCheck(ctx, exec, 'Get-ChildItem -Recurse -File | Select-String "中文路径"\nWrite-Output "完成"');
  assert.equal(good.status, "ok");
  assert.deepEqual(good.errors, []);

  const bad = await deepCheck(ctx, exec, 'if ($x -eq ) { Write-Output "x" }');
  assert.equal(bad.status, "ok");
  assert.ok(bad.errors.length > 0, "expected parse errors");
  assert.ok(bad.errors[0].line >= 1);
  assert.ok(bad.errors[0].column >= 1);
  assert.ok(typeof bad.errors[0].message === "string" && bad.errors[0].message.length > 0);

  const pssa = await deepCheck(ctx, exec, "$unused = 1", { pssa: true });
  assert.equal(pssa.status, "ok");
  assert.ok(["ok", "missing", "failed"].includes(pssa.pssa.status));
});

test("deepCheck：找不到 PowerShell 时降级不抛出", async () => {
  const ctx = {
    subprocess: {
      async resolveExecutable() { throw new Error("none"); },
      spawn() { throw new Error("should not spawn"); },
    },
    get: () => undefined,
  };
  const res = await deepCheck(ctx, {}, "Get-Date");
  assert.equal(res.status, "failed");
  assert.deepEqual(res.errors, []);
  assert.ok(res.detail.length > 0);
});