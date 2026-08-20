/**
 * dsh-retract-prompt 核心逻辑测试：用 fake ctx + 临时文件端到端验证
 * retractSession 的截断、文件重写、回滚与运行中守卫。
 * 运行：node test/retract-core.mjs
 */
import { promises as fsp } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { retractSession, computeBoundary, installRetractApi } from '../lib/retract.js';

let failures = 0;
function assert(cond, name, extra = '') {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures += 1;
    console.error(`  ✗ FAIL: ${name}${extra ? ' | ' + extra : ''}`);
  }
}

/** 构造带 seq 的伪事件。 */
function ev(type, seq, extra = {}) {
  return { type, seq, time: seq * 1000, data: { ...extra } };
}

/** 构造一个完整会话：header + 若干轮对话事件。 */
function buildEvents() {
  // seq 0: turn/start(turn1) 1: user/message 2-4: assistant 事件 5: turn/end
  // seq 6: turn/start(turn2) 7: user/message(目标) 8-10: assistant 9: step/end 11: turn/end
  return [
    ev('turn/start', 0, { turn: 1 }),
    ev('user/message', 1, { content: [{ type: 'text', text: '第一条指令' }], source: { kind: 'user' } }),
    ev('assistant/message', 2, { content: [{ type: 'text', text: '回答一' }] }),
    ev('turn/end', 3, { turn: 1 }),
    ev('turn/start', 4, { turn: 2 }),
    ev('user/message', 5, { content: [{ type: 'text', text: '第二条指令（要撤回）' }], source: { kind: 'user' } }),
    ev('assistant/message', 6, { content: [{ type: 'text', text: '回答二' }] }),
    ev('step/end', 7, { turn: 2, step: 1 }),
    ev('turn/end', 8, { turn: 2 }),
  ];
}

/** 构造 fake session（形态对齐 dsh-session 的 Session：log 数组 + events 快照 + 派生缓存）。 */
function makeSession(events) {
  const log = [...events];
  const session = {
    id: 'test-session',
    header: { id: 'test-session' },
    log,
    get events() {
      return Object.freeze([...log]);
    },
    eventsSnapshot: undefined,
    headerFold: undefined,
    headerFoldSeq: 0,
    contextFold: undefined,
    contextFoldSeq: 0,
    derived: [],
    derivedNodes: 0,
    derivedGeneration: -1,
    surfaceManager: {
      log,
      baseSeq: 0,
      _pendingPlan: undefined,
      _state: { nodes: [], replaceGeneration: 0 },
      _lastProcessedSeq: -1,
    },
  };
  return session;
}

/** 构造 fake ctx：sessions / sessionPersistence / agents / logger。 */
function makeCtx(session, filePath, { agentStatus } = {}) {
  const state = { cursor: 0, pendingCleared: false, flushed: false };
  const ctx = {
    sessions: {
      get: (id) => (String(id) === session.id ? session : undefined),
      flush: async () => { state.flushed = true; },
    },
    sessionPersistence: {
      readRaw: async () => ({
        content: JSON.stringify({ id: session.id, version: 1, cwd: undefined }) + '\n' +
          session.events.map((e) => JSON.stringify(e)).join('\n') + '\n',
      }),
      locate: () => ({ kind: 'jsonl', path: filePath }),
      coordinator: {
        states: new Map([[session.id, { cursor: state.cursor }]]),
        live: new Map([[session, { writes: { cancelAutomaticWait: () => {}, pending: [] } }]]),
      },
    },
    agents: {
      get: () => (agentStatus ? { status: agentStatus } : undefined),
    },
    logger: { info() {}, warn() {}, error() {} },
  };
  return { ctx, state };
}

/** 读取重写后的文件并解析出行数。 */
async function readFileLines(filePath) {
  const raw = await fsp.readFile(filePath, 'utf8');
  return raw.split('\n').filter((l) => l.length > 0);
}

console.log('== computeBoundary ==');
{
  const events = buildEvents();
  // 目标 seq=5（第二条用户指令，位于 turn2 内）：整回合撤回 → 边界 = 3（turn1 的 turn/end）
  assert(computeBoundary(events, 5) === 3, '闭合回合内撤回：整回合移除，边界 = 回合开始前一条');
  // 目标在未关闭回合内：边界前移到回合开始之前
  const open = buildEvents();
  open.push(ev('turn/start', 9, { turn: 3 }));
  open.push(ev('user/message', 10, { content: [], source: { kind: 'user' } }));
  assert(computeBoundary(open, 10) === 8, '未关闭回合：边界前移到回合开始之前');
  // 目标紧跟首个 turn/start（首条消息）：无可保留内容 → 边界 < 0
  assert(computeBoundary(events, 1) === -1, '首条消息：无可保留内容（边界 -1）');
  // 目标在回合中间（同一回合第二条用户消息）：仍移除整个回合
  const mid = [...events.slice(0, 6), ev('user/message', 6, { content: [], source: { kind: 'user' } }), ...events.slice(6)];
  assert(computeBoundary(mid, 6) === 3, '回合中间消息：整回合移除');
}

console.log('== retractSession 端到端 ==');
{
  const dir = mkdtempSync(join(tmpdir(), 'drp-test-'));
  const filePath = join(dir, 'session.jsonl');
  const events = buildEvents();
  await fsp.writeFile(filePath, 'HEADER\n' + events.map((e) => JSON.stringify(e)).join('\n') + '\n');

  const session = makeSession(events);
  const { ctx, state } = makeCtx(session, filePath);

  const boundary = await retractSession(ctx, 'test-session', 5);
  assert(boundary === 3, `撤回返回边界 3（实际 ${boundary}）`);
  assert(session.log.length === 4, `内存 log 截断到 4 条（实际 ${session.log.length}）`);
  assert(session.log[3].seq === 3 && session.log[3].type === 'turn/end', '保留的最后事件是前一回合的 turn/end');
  assert(state.flushed, 'flush 被调用（文件与内存先一致）');

  const lines = await readFileLines(filePath);
  assert(lines.length === 1 + 4, `文件重写为 header + 4 行（实际 ${lines.length} 行）`);
  const parsed = lines.slice(1).map((l) => JSON.parse(l));
  assert(parsed.every((e, i) => e.seq === i), '文件事件 seq 连续且从 0 开始');
  assert(parsed[3].type === 'turn/end', '文件末尾是完整回合的 turn/end（无未闭合回合）');

  // coordinator 游标同步
  const coordState = ctx.sessionPersistence.coordinator.states.get('test-session');
  assert(coordState.cursor === 4, `写游标同步为 4（实际 ${coordState.cursor}）`);
  const live = ctx.sessionPersistence.coordinator.live.get(session);
  assert(live.writes.pending.length === 0, '待写缓冲已清空');

  // 后续 append 的 seq 应该从 4 继续（与文件一致）
  session.log.push(ev('turn/start', 4, { turn: 3 }));
  session.log.push(ev('user/message', 5, { content: [{ type: 'text', text: '新指令' }] }));
  session.log.push(ev('turn/end', 6, { turn: 3 }));
  const appended = await retractSession(ctx, 'test-session', 5);
  assert(appended === 3, '对新消息再次撤回成功');
  const lines2 = await readFileLines(filePath);
  assert(lines2.length === 1 + 4, '再次撤回后文件仍为 4 行');

  // 首条消息无法撤回
  let threw = null;
  try {
    await retractSession(ctx, 'test-session', 1);
  } catch (err) {
    threw = err.message;
  }
  assert(threw !== null && threw.includes('没有可保留'), `首条消息撤回被拒绝（${threw}）`);

  rmSync(dir, { recursive: true, force: true });
}

console.log('== 守卫与错误路径 ==');
{
  const dir = mkdtempSync(join(tmpdir(), 'drp-test2-'));
  const filePath = join(dir, 'session.jsonl');
  const events = buildEvents();
  await fsp.writeFile(filePath, 'HEADER\n' + events.map((e) => JSON.stringify(e)).join('\n') + '\n');

  // Agent 正在运行（事件流尾部存在未关闭回合）→ 拒绝
  {
    const runningEvents = [...events, ev('turn/start', 9, { turn: 3 })];
    const session = makeSession(runningEvents);
    const { ctx } = makeCtx(session, filePath);
    let threw = null;
    try {
      await retractSession(ctx, 'test-session', 5);
    } catch (err) {
      threw = err.message;
    }
    assert(threw !== null && threw.includes('仍在运行'), `运行中撤回被拒绝（${threw}）`);
    assert(session.log.length === runningEvents.length, '被拒绝时内存未截断');
  }

  // 目标不是用户指令 → 拒绝
  {
    const session = makeSession(events);
    const { ctx } = makeCtx(session, filePath);
    let threw = null;
    try {
      await retractSession(ctx, 'test-session', 6); // assistant/message
    } catch (err) {
      threw = err.message;
    }
    assert(threw !== null && threw.includes('不是用户指令'), `非用户指令被拒绝（${threw}）`);
  }

  // 会话不存在 → 拒绝
  {
    const { ctx } = makeCtx(makeSession(events), filePath);
    let threw = null;
    try {
      await retractSession(ctx, 'no-such-session', 5);
    } catch (err) {
      threw = err.message;
    }
    assert(threw !== null, `会话不存在被拒绝（${threw}）`);
  }

  // 文件写入失败 → 内存回滚
  {
    const session = makeSession(events);
    const badCtx = {
      sessions: { get: () => session, flush: async () => {} },
      sessionPersistence: {
        readRaw: async () => { throw new Error('磁盘坏了'); },
        locate: () => ({ path: join(dir, 'x.jsonl') }),
        coordinator: { states: new Map(), live: new Map() },
      },
      agents: { get: () => undefined },
      logger: { info() {}, warn() {}, error() {} },
    };
    let threw = null;
    try {
      await retractSession(badCtx, 'test-session', 5);
    } catch (err) {
      threw = err.message;
    }
    assert(threw !== null && threw.includes('写入会话存储失败'), `文件失败抛出（${threw}）`);
    assert(session.log.length === events.length, '文件失败后内存回滚为完整日志');
  }

  rmSync(dir, { recursive: true, force: true });
}

console.log('== installRetractApi 路由 ==');
{
  const routes = [];
  const webServer = {
    register: (route) => {
      routes.push(route);
      return () => {};
    },
  };
  const logger = { info() {}, warn() {}, error() {} };
  const ctx = { webServer, logger };
  const disposers = installRetractApi(ctx, { autoStop: false });
  const paths = routes.map((r) => r.path);
  assert(paths.includes('/retract-prompt/api/config') && paths.includes('/retract-prompt/api/retract'), `注册 2 条路由（${paths.join(', ')}）`);
  assert(typeof disposers[0] === 'function', '返回取消注册函数');

  // config 路由返回 autoStop
  const configRoute = routes.find((r) => r.path === '/retract-prompt/api/config');
  let configRes = null;
  await configRoute.handler({ url: '/' }, { writeHead: (s, h) => {}, end: (b) => { configRes = JSON.parse(b); } });
  assert(configRes.ok === true && configRes.autoStop === false, `config 路由返回 autoStop=false（${JSON.stringify(configRes)}）`);
}

console.log(failures === 0 ? '\n== 全部通过 ==' : `\n== ${failures} 项失败 ==`);
process.exit(failures === 0 ? 0 : 1);
