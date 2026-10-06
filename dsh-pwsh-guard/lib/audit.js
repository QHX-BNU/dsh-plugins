/**
 * dsh-pwsh-guard — 审计日志（零依赖）
 *
 * 目的：让规则与修复器的长期维护有数据依据——拦了什么、改了什么、确认了什么。
 * 落盘：$DSH_HOME/storages/dsh-pwsh-guard/audit.jsonl（每行一条 JSON）。
 * 约束：任何写入/读取失败都不得影响主流程；命令片段截断到 300 字符。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const MAX_COMMAND = 300;

/** 审计文件路径（每次调用时解析，便于测试注入 DSH_HOME）。 */
export function auditFilePath() {
  const home = typeof process.env.DSH_HOME === "string" && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : join(homedir(), ".dsh");
  return join(home, "storages", "dsh-pwsh-guard", "audit.jsonl");
}

export function clipCommand(text) {
  const value = typeof text === "string" ? text : "";
  return value.length > MAX_COMMAND ? value.slice(0, MAX_COMMAND) + "..." : value;
}

/** 追加一条审计记录（失败静默；DSH_GUARD_NO_AUDIT=1 时跳过，供测试隔离）。 */
export function appendAudit(entry) {
  if (process.env.DSH_GUARD_NO_AUDIT === "1") return;
  try {
    const file = auditFilePath();
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n", "utf8");
  } catch {
    /* 审计失败不影响主流程 */
  }
}

/** 读取最近 limit 条记录（按写入顺序，返回数组）。 */
export function readAuditTail(limit = 50) {
  try {
    const file = auditFilePath();
    if (!existsSync(file)) return [];
    const lines = readFileSync(file, "utf8").split(/\r?\n/).filter((line) => line.trim().length > 0);
    const size = Math.min(Math.max(1, Math.floor(limit)), lines.length);
    const out = [];
    for (const line of lines.slice(-size)) {
      try {
        out.push(JSON.parse(line));
      } catch {
        /* skip malformed */
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** 聚合统计：事件计数、命中规则计数、修复转换计数。 */
export function summarizeAudit(entries) {
  const events = {};
  const rules = {};
  const transforms = {};
  const list = Array.isArray(entries) ? entries : [];
  for (const entry of list) {
    if (entry === null || typeof entry !== "object") continue;
    const name = typeof entry.event === "string" ? entry.event : "unknown";
    events[name] = (events[name] || 0) + 1;
    if (Array.isArray(entry.rules)) {
      for (const id of entry.rules) rules[String(id)] = (rules[String(id)] || 0) + 1;
    }
    if (Array.isArray(entry.transforms)) {
      for (const id of entry.transforms) transforms[String(id)] = (transforms[String(id)] || 0) + 1;
    }
    if (Array.isArray(entry.reasons)) {
      for (const id of entry.reasons) rules["danger:" + String(id)] = (rules["danger:" + String(id)] || 0) + 1;
    }
  }
  return { total: list.length, events, rules, transforms };
}