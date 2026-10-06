/**
 * dsh-retract-prompt v2 离线单元测试：
 * 用复刻的 v4 zstd 帧格式 + mock 持久化后端，验证撤回编排（重写/回滚/句柄状态）。
 * 运行：node --test test/retract-v2.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompress, zstdDecompress, constants as zc } from 'node:zlib';
import { promisify } from 'node:util';

const CHECKSUM = { params: { [zc.ZSTD_c_checksumFlag]: 1 } };
const zstdCompressAsync = promisify(zstdCompress);
const zstdDecompressAsync = promisify(zstdDecompress);
const COMPRESS = (text) => zstdCompressAsync(Buffer.from(text, 'utf8'), CHECKSUM);

/** 复刻 v4 物化编码：header 帧 + 单个事件帧。 */
async function encodeV4(headerLine, events) {
  const header = await COMPRESS(headerLine + '\n');
  if (events.length === 0) return header;
  const body = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  return Buffer.concat([header, await COMPRESS(body)]);
}

/** 复刻 v4 解码：按 zstd 帧扫描；第一帧必须是单行 header。 */
async function decodeV4(buffer) {
  const MAGIC = 0xfd2fb528;
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    assert.equal(buffer.readUInt32LE(offset), MAGIC, 'bad frame magic at ' + offset);
    const start = offset;
    let end = -1;
    for (let cursor = offset + 4; cursor + 3 < buffer.length; cursor++) {
      if (buffer.readUInt32LE(cursor) !== MAGIC) continue;
      let ok = true;
      try {
        await zstdDecompressAsync(buffer.subarray(0, cursor));
      } catch {
        ok = false;
      }
      if (ok) { end = cursor; break; }
    }
    if (end < 0) end = buffer.length;
    frames.push(await zstdDecompressAsync(buffer.subarray(start, end)));
    offset = end;
  }
  const headerText = frames[0].toString('utf8');
  assert.ok(headerText.endsWith('\n') && headerText.indexOf('\n') === headerText.length - 1, 'header frame must be exactly one line');
  const events = [];
  for (const frame of frames.slice(1)) {
    const text = frame.toString('utf8');
    assert.ok(text.endsWith('\n'), 'event frame must end with newline');
    for (const line of text.slice(0, -1).split('\n')) if (line) events.push(JSON.parse(line));
  }
  return { header: JSON.parse(headerText.slice(0, -1)), events };
}
// ------------------------------------------------------------------ mock 后端

/** 生成一次会话事件序列（seq 连续）。 */
function makeEvents(seqs) {
  return seqs.map((spec) => ({ type: spec[0], seq: spec[1], time: 1700000000000 + spec[1], data: spec[2] ?? {} }));
}

/** 复刻 2.0.14 句柄化 JSONL 后端的最小行为。 */
function createBackend(root, id, header, events) {
  const dir = join(root, '--proj--', id);
  const filePath = join(dir, 'session.v4.jsonl.zstd');
  const state = {
    writer: null,
    closedWriters: 0,
    failReadOnce: false,
    coldLogMemo: new Map(),
  };
  const persistence = {
    tracker: { writers: new Map() },
    coldLogMemo: state.coldLogMemo,
    locate: (meta) => ({ kind: 'jsonl', path: join(root, '--proj--', meta.id, 'session.v4.jsonl.zstd') }),
    async findLog() {
      try { await fsp.stat(filePath); } catch { return undefined; }
      return { sourcePath: filePath, sourceVersion: 4, currentPath: filePath };
    },
    async encodeMaterialization(meta, _cut, kept) {
      return encodeV4(JSON.stringify({ type: 'session', version: 4, id: meta.id, createdAt: 1, isSeeded: false }), kept);
    },
    async readStoredLog() {
      if (state.failReadOnce) { state.failReadOnce = false; throw new Error('mock read failure'); }
      const buffer = await fsp.readFile(filePath);
      const decoded = await decodeV4(buffer);
      return { status: 'current', meta: decoded.header, events: decoded.events, inheritedEventCount: 0, tornTruncateTo: undefined, recoveredTail: [], revision: 'r' };
    },
    async open() {
      const existing = persistence.tracker.writers.get(id);
      if (existing) return existing;
      const handle = state.writer;
      persistence.tracker.writers.set(id, handle);
      return handle;
    },
  };
  const handle = {
    state: { cursor: events.length, materialized: true, inheritedEventCount: 0, primed: { events } },
    observedLength: events.length,
    buffered: [],
    batchTimer: undefined,
    drainPaused: false,
    chain: Promise.resolve(),
    drainCalls: 0,
    flushCalls: 0,
    closed: false,
    async drainLive() { this.drainCalls += 1; },
    async flush() { this.flushCalls += 1; },
    async close() { this.closed = true; state.closedWriters += 1; },
  };
  state.writer = handle;
  return { persistence, handle, state, filePath, dir, root };
}

/** 构造假 Session（含 2.0.14 的缓存字段）。 */
function makeSession(id, events, extra = {}) {
  const log = [...events];
  const session = {
    id,
    header: { id, version: 4, createdAt: 1, isSeeded: false, delegationDepth: 0 },
    inheritedEventCount: 0,
    log,
    snapshotEvents() { return Object.freeze([...log]); },
    eventsSnapshot: [1, 2, 3],
    surfaceManager: {
      _state: { nodes: [1], replaceGeneration: 2, contentGeneration: 3, projectedMessages: new Map([[1, {}]]), projections: new Set(['p']) },
      _lastProcessedSeq: 5,
      _pendingPlan: { event: {}, expectedSeq: 6 },
    },
    derived: [1],
    derivedNodes: 3,
    derivedGeneration: 1,
    headerFold: { stale: true },
    headerFoldSeq: 9,
    contextFold: { stale: true },
    contextFoldSeq: 9,
    toolHistoryProjection: { stale: true },
    toolHistorySeq: 9,
  };
  return Object.assign(session, extra);
}

function makeCtx(session, persistence) {
  return {
    sessions: { get: (id) => (String(id) === String(session.id) ? session : undefined), flush: async () => {} },
    sessionPersistence: persistence,
    get: () => undefined,
  };
}
// ------------------------------------------------------------------ 测试

import { computeBoundary, hasOpenTurn, retractSession } from '../lib/retract.js';

test('computeBoundary：边界落在完整回合之后，未关闭回合前移', () => {
  const events = makeEvents([
    ['system/message', 0],
    ['user/message', 1],
    ['turn/start', 2],
    ['assistant/message', 3],
    ['turn/end', 4],
    ['user/message', 5],
    ['turn/start', 6],
    ['assistant/message', 7],
  ]);
  assert.equal(computeBoundary(events, 5), 4);
  assert.equal(computeBoundary(events, 1), 0);
  assert.equal(computeBoundary(events, 6), 5);
  assert.equal(hasOpenTurn(events), true);
  assert.equal(hasOpenTurn(events.slice(0, 5)), false);
});

test('撤回：重写文件、截断内存、重置句柄与缓存', async () => {
  const root = await fsp.mkdtemp(join(tmpdir(), 'retract-v2-'));
  const id = 'sess-1';
  const events = makeEvents([
    ['session/end-seed', 0],
    ['user/message', 1, { content: [{ type: 'text', text: 'hi' }] }],
    ['turn/start', 2],
    ['assistant/message', 3],
    ['turn/end', 4],
    ['user/message', 5, { content: [{ type: 'text', text: 'retract me' }] }],
    ['turn/start', 6],
    ['assistant/message', 7],
    ['turn/end', 8],
  ]);
  const backend = createBackend(root, id, { id }, events);
  await fsp.mkdir(backend.dir, { recursive: true });
  await fsp.writeFile(backend.filePath, await backend.persistence.encodeMaterialization({ id }, 0, events));
  backend.persistence.tracker.writers.set(id, backend.handle);
  const session = makeSession(id, events);
  const ctx = makeCtx(session, backend.persistence);

  const boundary = await retractSession(ctx, id, 5);

  assert.equal(boundary, 4);
  assert.equal(session.log.length, 5);
  assert.equal(session.eventsSnapshot, undefined);
  assert.deepEqual(session.surfaceManager._state.nodes, []);
  assert.equal(session.surfaceManager._state.replaceGeneration, 0);
  assert.equal(session.surfaceManager._state.contentGeneration, 0);
  assert.equal(session.surfaceManager._state.projectedMessages.size, 0);
  assert.equal(session.surfaceManager._state.projections.size, 0);
  assert.equal(session.surfaceManager._lastProcessedSeq, -1);
  assert.equal(session.surfaceManager._pendingPlan, undefined);
  assert.equal(session.derivedGeneration, -1);
  assert.equal(session.headerFoldSeq, 0);
  assert.equal(session.contextFoldSeq, 0);
  assert.equal(session.toolHistorySeq, 0);

  const reread = await backend.persistence.readStoredLog(backend.filePath, id);
  assert.equal(reread.events.length, 5);
  assert.equal(reread.events[4].seq, 4);
  assert.equal(reread.meta.version, 4);

  assert.equal(backend.handle.state.cursor, 5);
  assert.equal(backend.handle.observedLength, 5);
  assert.equal(backend.handle.state.primed, undefined);
  assert.equal(backend.handle.buffered.length, 0);
  assert.equal(backend.handle.flushCalls, 1);
  assert.equal(backend.handle.closed, false);
  await fsp.rm(root, { recursive: true, force: true });
});
test('撤回：写后校验失败时回滚原文件且不改内存与句柄', async () => {
  const root = await fsp.mkdtemp(join(tmpdir(), 'retract-v2-'));
  const id = 'sess-2';
  const events = makeEvents([
    ['user/message', 0],
    ['turn/start', 1],
    ['turn/end', 2],
    ['user/message', 3],
    ['turn/start', 4],
    ['turn/end', 5],
  ]);
  const backend = createBackend(root, id, { id }, events);
  await fsp.mkdir(backend.dir, { recursive: true });
  await fsp.writeFile(backend.filePath, await backend.persistence.encodeMaterialization({ id }, 0, events));
  backend.persistence.tracker.writers.set(id, backend.handle);
  const session = makeSession(id, events);
  const ctx = makeCtx(session, backend.persistence);

  backend.state.failReadOnce = true;
  await assert.rejects(() => retractSession(ctx, id, 3), /mock read failure/);

  const onDisk = await backend.persistence.readStoredLog(backend.filePath, id);
  assert.equal(onDisk.events.length, events.length);
  assert.equal(backend.handle.state.cursor, events.length);
  assert.equal(backend.handle.observedLength, events.length);
  assert.equal(session.log.length, events.length);
  await fsp.rm(root, { recursive: true, force: true });
});

test('撤回：目标落在 fork 继承前缀内时拒绝', async () => {
  const events = makeEvents([['session/end-seed', 0], ['user/message', 1], ['turn/start', 2], ['turn/end', 3]]);
  const session = makeSession('sess-3', events, { inheritedEventCount: 2 });
  const ctx = makeCtx(session, null);
  await assert.rejects(() => retractSession(ctx, 'sess-3', 1), /分叉继承/);
});

test('撤回：Agent 仍在运行时拒绝', async () => {
  const events = makeEvents([['user/message', 0], ['turn/start', 1]]);
  const session = makeSession('sess-4', events);
  const ctx = makeCtx(session, null);
  await assert.rejects(() => retractSession(ctx, 'sess-4', 0), /仍在运行/);
});