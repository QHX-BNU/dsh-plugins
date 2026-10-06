import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendAudit, readAuditTail, summarizeAudit, auditFilePath, clipCommand } from "../lib/audit.js";

function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), "guard-audit-"));
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    return fn(home);
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
}

test("审计：追加、读取、聚合", () => {
  withHome((home) => {
    appendAudit({ event: "deny", rules: ["R11", "R10"], command: "a && b" });
    appendAudit({ event: "deny", rules: ["R11"] });
    appendAudit({ event: "fix", transforms: ["AND_OR_CHAIN"] });
    appendAudit({ event: "danger-block", reasons: ["recursiveDelete"] });

    const entries = readAuditTail(10);
    assert.equal(entries.length, 4);
    assert.ok(typeof entries[0].ts === "string" && entries[0].ts.length > 0);

    const summary = summarizeAudit(entries);
    assert.equal(summary.total, 4);
    assert.equal(summary.events.deny, 2);
    assert.equal(summary.events.fix, 1);
    assert.equal(summary.rules.R11, 2);
    assert.equal(summary.rules["danger:recursiveDelete"], 1);
    assert.equal(summary.transforms.AND_OR_CHAIN, 1);

    assert.match(auditFilePath(), /dsh-pwsh-guard/);
    assert.ok(auditFilePath().startsWith(home));
  });
});

test("审计：无文件时返回空数组", () => {
  withHome(() => {
    assert.deepEqual(readAuditTail(5), []);
    assert.deepEqual(summarizeAudit([]), { total: 0, events: {}, rules: {}, transforms: {} });
  });
});

test("审计：命令片段截断到 300 字符", () => {
  const long = "x".repeat(500);
  assert.equal(clipCommand(long).length, 303);
  assert.equal(clipCommand("short"), "short");
});