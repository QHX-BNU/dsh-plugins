#!/usr/bin/env node
/**
 * fix-legacy-sessions.mjs —— 修复历史会话中会阻断 DSH v0→v4 迁移的两类数据
 *
 * 背景（2026-10 实测）：
 *   1) dsh-memory-admin <= 0.1.1 注入的「记忆加载」消息用了 source.kind = 'memory-admin'。
 *      该 kind 不在 @deepseek-ai/dsh-session-format-v2-to-v3 的来源白名单中，导致任何
 *      含记忆注入的旧会话在迁移到 v4 时被整份拒绝：
 *        SessionFormatUnsupportedMigrationError: cannot safely transform unclassified message source
 *      修复：改写为历史插件来源形态 { kind: 'plugin', plugin: 'dsh-memory-admin' }；
 *      V3→V4 迁移会自动把它重写为 { kind: 'plugin:dsh-memory-admin' }。
 *   2) 部分 v0 会话里 subagent/descriptor 的 version = 2；v0→v1 边只接受 version 3：
 *        SessionFormatUnsupportedMigrationError: subagent/descriptor N uses unsupported descriptor version 2
 *      修复：仅对 v0 日志把 version 2 提升为 3（字段集一致，整链迁移验证通过）。
 *   3) 个别会话的 turn 编号有空洞（例如 1,2,3,5,6...，多半是撤回/删除 turn 留下的）。
 *      v3→v4 校验要求 turn 连续，否则拒绝：turn/start does not open the expected turn。
 *      修复：把空洞之后的 turn 编号整体前移恢复连续（只改 turn 字段，不动 seq 与引用），
 *      默认开启，可用 --no-fix-turns 关闭。
 *
 * 安全设计：默认 dry-run（只报告），--apply 才写盘；写盘前先用 DSH 自己的迁移 catalog
 * 验证改写后的数据能完整恢复为 v4（验证在独立的文本快照副本上进行，因为迁移解码会原地
 * 合并 packed run 行对象），验证失败的文件会被跳过；改前备份到
 * <sessions 同级目录>/session-backups-<时间戳>/ 下（放在 sessions 树之外，避免被 DSH 当成重复会话）。
 *
 * 用法（用 DSH 自带的 Electron 运行，才能 import 它的迁移库做验证）：
 *   $env:ELECTRON_RUN_AS_NODE="1"
 *   & "C:\Users\you\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe" tools\fix-legacy-sessions.mjs            # 试运行
 *   & "...\DeepSeek Harness.exe" tools\fix-legacy-sessions.mjs --apply                                                     # 实际写入
 * 可选参数：--sessions <目录>（默认 %USERPROFILE%\.dsh\sessions）、--asar <app.asar 路径>、--no-verify、--include-v4
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';

const PLUGIN_NAME = 'dsh-memory-admin';
const LEGACY_KIND = 'memory-admin';
const FIXED_SOURCE = { kind: 'plugin', plugin: PLUGIN_NAME };

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
}
const APPLY = process.argv.includes('--apply');
const VERIFY = !process.argv.includes('--no-verify');
const INCLUDE_V4 = process.argv.includes('--include-v4');
const FIX_TURNS = !process.argv.includes('--no-fix-turns');
const SESSIONS = path.resolve(arg('--sessions', path.join(os.homedir(), '.dsh', 'sessions')));

// ---------------- zstd 会话日志读写（DSH 日志 = 标准 zstd 帧拼接，header 单独一帧） ----------------
const MAGIC = 0xFD2FB528;
function scanFrames(buf) {
  const frames = [];
  let pos = 0;
  while (pos + 4 <= buf.length) {
    if (buf.readUInt32LE(pos) !== MAGIC) throw new Error('bad zstd magic at byte ' + pos);
    const start = pos;
    pos += 4;
    const fhd = buf[pos++];
    const fcsFlag = fhd >> 6, single = (fhd >> 5) & 1, checksum = (fhd >> 2) & 1, dictFlag = fhd & 3;
    if (!single) pos += 1;
    pos += dictFlag === 0 ? 0 : dictFlag === 1 ? 1 : dictFlag === 2 ? 2 : 4;
    pos += fcsFlag === 0 ? (single ? 1 : 0) : fcsFlag === 1 ? 2 : fcsFlag === 2 ? 4 : 8;
    for (;;) {
      const bh = buf.readUIntLE(pos, 3);
      pos += 3;
      const last = bh & 1, type = (bh >> 1) & 3, size = bh >> 3;
      if (type === 0 || type === 2) pos += size;
      else if (type === 1) pos += 1;
      else throw new Error('reserved zstd block type');
      if (last) break;
    }
    if (checksum) pos += 4;
    frames.push([start, pos]);
  }
  return frames;
}
/**
 * 只读出原始 JSONL 文本行（不解析为对象）。
 * 注意：DSH 的迁移/解码器会原地修改传入的事件对象（把同一 packed run 的增量行
 * 合并进首个行对象），所以写回必须使用独立的字符串快照，绝不能复用被验证过的对象。
 */
function readRawLines(file) {
  const buf = fs.readFileSync(file);
  const lines = [];
  for (const [s, e] of scanFrames(buf)) {
    const text = zlib.zstdDecompressSync(buf.subarray(s, e)).toString('utf8');
    for (const line of text.split('\n')) if (line.trim() !== '') lines.push(line);
  }
  return lines;
}
function writeLines(file, lines) {
  const header = zlib.zstdCompressSync(Buffer.from(lines[0] + '\n'));
  const body = lines.length > 1 ? zlib.zstdCompressSync(Buffer.from(lines.slice(1).join('\n') + '\n')) : Buffer.alloc(0);
  fs.writeFileSync(file, Buffer.concat([header, body]));
}// ---------------- 数据改写 ----------------
function visitMessages(event, fn) {
  const data = event && event.data;
  if (!data || typeof data !== 'object') return;
  if (event.type === 'user/message') fn(data);
  else if (['assistant/message', 'tool/result', 'system/message', 'developer/message'].includes(event.type) && data.message) fn(data.message);
  else if (event.type === 'agent/inbox/spliced' && Array.isArray(data.inserted)) data.inserted.forEach(fn);
  else if (event.type === 'session/title-llm-request' && Array.isArray(data.messages)) data.messages.forEach(fn);
}
function rewriteRecords(records, opts) {
  let memFixed = 0, memMissingPlugin = 0, descFixed = 0, v4KindFixed = 0;
  const version = Number(records[0] && records[0].version);
  for (const event of records) {
    if (opts.fixDescriptor && version === 0 && event.type === 'subagent/descriptor' && event.data && event.data.version === 2) {
      event.data = { ...event.data, version: 3 };
      descFixed += 1;
    }
    visitMessages(event, (message) => {
      const source = message && message.source;
      if (!source || typeof source !== 'object' || source.kind !== LEGACY_KIND) return;
      if (opts.fixV4Kind) {
        message.source = { kind: 'plugin:' + PLUGIN_NAME };
        v4KindFixed += 1;
        return;
      }
      if (typeof source.plugin !== 'string' || source.plugin.length === 0) {
        memMissingPlugin += 1;
        message.source = { ...source, kind: FIXED_SOURCE.kind, plugin: PLUGIN_NAME };
      } else {
        message.source = { ...source, kind: FIXED_SOURCE.kind };
      }
      memFixed += 1;
    });
  }
  return { memFixed, memMissingPlugin, descFixed, v4KindFixed, changed: memFixed + descFixed + v4KindFixed };
}

/**
 * 修复 turn 编号空洞：v3→v4 要求 turn 从 1 连续递增，撤回/删除 turn 留下的空洞会被拒绝。
 * 仅把空洞之后的 turn 值整体前移（step 是 turn 内序号，保持不变；seq 与各类引用不动）。
 */
function fixTurnGaps(records) {
  const starts = records
    .filter((event) => event.type === 'turn/start')
    .map((event) => (event.data ? event.data.turn : undefined))
    .filter((turn) => typeof turn === 'number' && Number.isSafeInteger(turn) && turn > 0);
  if (starts.length === 0) return { gaps: [], renamed: 0 };
  const present = new Set(starts);
  const max = Math.max(...present);
  const gaps = [];
  for (let turn = 1; turn <= max; turn += 1) if (!present.has(turn)) gaps.push(turn);
  if (gaps.length === 0) return { gaps: [], renamed: 0 };
  let renamed = 0;
  for (const event of records) {
    const data = event && event.data;
    if (!data || typeof data !== 'object' || typeof data.turn !== 'number' || data.turn <= 0) continue;
    const shift = gaps.filter((gap) => gap < data.turn).length;
    if (shift > 0) {
      data.turn -= shift;
      renamed += 1;
    }
  }
  return { gaps, renamed };
}

// ---------------- DSH 迁移库验证（改写后的数据必须能完整恢复为 v4） ----------------
let catalogPromise;
function asarCandidates(explicit) {
  const list = [];
  if (explicit) list.push(explicit);
  if (process.env.DSH_ASAR) list.push(process.env.DSH_ASAR);
  list.push(path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'DeepSeek Harness', 'resources', 'app.asar'));
  list.push('D:/Program Files/deepseek harness/DSH Desktop/resources/app.asar');
  return list;
}
async function loadCatalog(explicit) {
  if (!catalogPromise) {
    catalogPromise = (async () => {
      const errors = [];
      for (const asar of asarCandidates(explicit)) {
        try {
          if (!fs.existsSync(asar)) continue;
          const url = pathToFileURL(path.join(asar, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-session-format-catalog', 'lib', 'index.js')).href;
          const mod = await import(url);
          return { mod, asar };
        } catch (error) {
          errors.push(asar + ': ' + error.message);
        }
      }
      throw new Error('无法加载 DSH 迁移库（请用 DSH 自带 Electron 运行本脚本）: ' + (errors.join(' | ') || '未找到 app.asar'));
    })();
  }
  return catalogPromise;
}
async function verifyMigrate(records, asar) {
  const { mod } = await loadCatalog(asar);
  const catalog = mod.createSessionFormatCatalogWithChildren([]);
  const restore = catalog.createRestore(records[0], { recovery: 'strict', validation: 'current' });
  for (let i = 1; i < records.length; i += 1) restore.decodeRow(records[i]);
  return restore.finish();
}// ---------------- 主流程 ----------------
function sessionFiles(root) {
  const out = [];
  for (const project of fs.readdirSync(root)) {
    const p1 = path.join(root, project);
    if (!fs.statSync(p1).isDirectory()) continue;
    for (const session of fs.readdirSync(p1)) {
      const p2 = path.join(p1, session);
      if (!fs.statSync(p2).isDirectory()) continue;
      for (const name of fs.readdirSync(p2)) {
        const m = /^session(\.v(\d+))?\.jsonl(\.zstd)?$/.exec(name);
        if (!m) continue;
        const fileVersion = m[2] === undefined ? 0 : Number(m[2]);
        if (fileVersion >= 4 && !INCLUDE_V4) continue;
        out.push({ file: path.join(p2, name), project, session, name, fileVersion });
      }
    }
  }
  return out;
}

if (!fs.existsSync(SESSIONS)) {
  console.error('sessions 目录不存在: ' + SESSIONS);
  process.exit(1);
}
const asarArg = arg('--asar', undefined);
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const backupRoot = path.join(path.dirname(SESSIONS), 'session-backups-' + ts);
const stats = { scanned: 0, skipped: 0, changed: 0, applied: 0, failed: 0, memFixed: 0, memMissingPlugin: 0, descFixed: 0, v4KindFixed: 0, turnGapFiles: 0, turnRenamed: 0 };
const failures = [];

console.log('[dsh-memory-admin] 历史会话修复' + (APPLY ? '（APPLY：将写入文件）' : '（DRY-RUN：只报告）'));
console.log('sessions:', SESSIONS);
if (VERIFY) {
  try {
    const loaded = await loadCatalog(asarArg);
    console.log('迁移库:', loaded.asar);
  } catch (error) {
    console.error(error.message);
    console.error('提示：请设置 ELECTRON_RUN_AS_NODE=1 并用 DSH 的 DeepSeek Harness.exe 运行本脚本；或加 --no-verify 跳过验证。');
    process.exit(1);
  }
}

for (const item of sessionFiles(SESSIONS)) {
  stats.scanned += 1;
  let records;
  try {
    records = readRawLines(item.file).map((line) => JSON.parse(line));
  } catch (error) {
    stats.failed += 1;
    failures.push([item.file, '读取失败: ' + error.message]);
    continue;
  }

  const isV4 = Number(records[0] && records[0].version) >= 4;
  const rewrite = rewriteRecords(records, { fixDescriptor: !isV4, fixV4Kind: isV4 && INCLUDE_V4 });
  if (!isV4 && FIX_TURNS) {
    const turns = fixTurnGaps(records);
    rewrite.turnGaps = turns.gaps;
    rewrite.turnRenamed = turns.renamed;
  }
  if ((rewrite.changed || 0) === 0 && !(rewrite.turnGaps && rewrite.turnGaps.length)) {
    stats.skipped += 1;
    continue;
  }
  stats.changed += 1;
  if (rewrite.turnGaps && rewrite.turnGaps.length) {
    stats.turnGapFiles += 1;
    stats.turnRenamed += rewrite.turnRenamed;
  }
  stats.memFixed += rewrite.memFixed;
  stats.memMissingPlugin += rewrite.memMissingPlugin;
  stats.descFixed += rewrite.descFixed;
  stats.v4KindFixed += rewrite.v4KindFixed;

  // 先冻结写回用的文本行；验证用另一份独立副本（验证会原地改写 packed run 对象）。
  const outLines = records.map((record) => JSON.stringify(record));
  if (VERIFY) {
    try {
      await verifyMigrate(outLines.map((line) => JSON.parse(line)), asarArg);
    } catch (error) {
      stats.failed += 1;
      failures.push([item.file, '改写后仍无法迁移（已跳过，未写入）: ' + String(error.message || error).slice(0, 160)]);
      continue;
    }
  }
  if (APPLY) {
    const backupFile = path.join(backupRoot, item.project, item.session, item.name);
    fs.mkdirSync(path.dirname(backupFile), { recursive: true });
    fs.copyFileSync(item.file, backupFile);
    writeLines(item.file, outLines);
    stats.applied += 1;
  }
  console.log('  ' + (APPLY ? '已修复' : '待修复') + '  ' + item.project + '/' + item.session + '/' + item.name +
    '  [memory ' + rewrite.memFixed + (rewrite.memMissingPlugin ? '(+补 plugin 字段 ' + rewrite.memMissingPlugin + ')' : '') +
    ', descriptor ' + rewrite.descFixed + (rewrite.v4KindFixed ? ', v4-kind ' + rewrite.v4KindFixed : '') +
    (rewrite.turnGaps && rewrite.turnGaps.length ? ', turn 空洞 ' + JSON.stringify(rewrite.turnGaps) + '（重编号 ' + rewrite.turnRenamed + ' 个字段）' : '') + ']');
}

console.log('\n================ 汇总 ================');
console.log('扫描 ' + stats.scanned + ' 个会话文件；需修复 ' + stats.changed + '；无需修复 ' + stats.skipped + '；失败/跳过 ' + stats.failed + '；' + (APPLY ? '已写入 ' + stats.applied : '未写入（dry-run）'));
console.log('改写统计：memory 来源 ' + stats.memFixed + ' 条（补 plugin 字段 ' + stats.memMissingPlugin + '），descriptor version 2->3 ' + stats.descFixed + ' 个' + (stats.v4KindFixed ? '，v4 kind 归一 ' + stats.v4KindFixed + ' 条' : '') + (stats.turnGapFiles ? '；turn 空洞 ' + stats.turnGapFiles + ' 个文件（重编号 ' + stats.turnRenamed + ' 个字段）' : ''));
if (APPLY) {
  console.log('备份目录: ' + backupRoot);
  console.log('接下来：重启 DSH（或重载插件）后打开这些旧会话，DSH 会自行完成 v0->v4 迁移并生成 session.v4.jsonl.zstd。');
} else if (stats.changed > 0) {
  console.log('这是试运行。确认无异常后加 --apply 实际写入（会先备份）。');
}
if (failures.length) {
  console.log('\n---- 需要人工处理的文件 ----');
  for (const [file, message] of failures) console.log('  ' + file + '\n      ' + message);
}