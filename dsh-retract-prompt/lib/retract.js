/**
 * dsh-retract-prompt —— 撤回核心（服务端）
 *
 * 真正把选中的用户指令从会话中移除（不再参与对话），并让会话回到该指令
 * 之前的状态，用户修改后重新发送。
 *
 * 实现：DSH 会话事件日志是 append-only（内存 log + JSONL/zstd 持久化），官方
 * 没有删除 API。本模块在会话静止（已停止运行）后：
 *   1. flush 所有缓冲事件落盘，保证文件与内存一致；
 *   2. 截断内存 Session.log 到目标消息之前，并重置所有派生缓存
 *      （surface 折叠、request/header 与 context 折叠、派生消息缓存）；
 *   3. 用内存事件重写持久化文件（header 原样 + 每行一个事件，读取端对
 *      打包布局不敏感，兼容）；失败时回滚内存，保持状态一致；
 *   4. 同步持久化协调器的写游标（cursor）与待写缓冲，保证后续 append
 *      正确落盘。
 *
 * 若目标消息之前存在未关闭的回合（运行中输入的消息），撤回边界自动前移
 * 到该回合开始之前（连同该回合一起撤回）。
 */
import { promises as fsp } from 'node:fs';
import { promisify } from 'node:util';
import { zstdCompress } from 'node:zlib';

const zstdCompressAsync = promisify(zstdCompress);
/** Zstandard 帧魔数（小端 28 B5 2F FD）。 */
const ZSTD_MAGIC = 0xfd2fb528;

/** 重置 Session 的所有派生缓存（截断/恢复后强制按新 log 重建）。 */
function resetSessionCaches(session) {
  session.eventsSnapshot = undefined;
  session.headerFold = undefined;
  session.headerFoldSeq = 0;
  session.contextFold = undefined;
  session.contextFoldSeq = 0;
  session.derived = [];
  session.derivedNodes = 0;
  session.derivedGeneration = -1;
  const sm = session.surfaceManager;
  if (sm) {
    sm._pendingPlan = undefined;
    sm._state = { nodes: [], replaceGeneration: 0 };
    sm._lastProcessedSeq = (sm.baseSeq || 0) - 1;
  }
}

/** 用给定事件序列整体替换内存 log（截断或恢复）。 */
function replaceSessionLog(session, events) {
  session.log.length = 0;
  for (const event of events) session.log.push(event);
  resetSessionCaches(session);
}

/**
 * 计算撤回边界：删除 seq >= U 的所有事件（含目标消息及其后的回复）。
 * 若 U 之前存在未关闭回合（turn/start 未配对），边界前移到该回合开始之前。
 * @returns 保留的最后一个事件 seq；< 0 表示无可保留内容。
 */
function computeBoundary(events, U) {
  let boundary = U - 1;
  for (let i = boundary; i >= 0; i--) {
    const t = events[i].type;
    if (t === 'turn/start') {
      boundary = i - 1;
      break;
    }
    if (t === 'turn/end') break;
  }
  return boundary;
}

/** 判断持久化文件是否为 zstd 压缩。 */
async function detectCompression(filePath) {
  try {
    const fd = await fsp.open(filePath, 'r');
    try {
      const buf = Buffer.alloc(4);
      const { bytesRead } = await fd.read(buf, 0, 4, 0);
      if (bytesRead >= 4 && buf.readUInt32LE(0) === ZSTD_MAGIC) return 'zstd';
    } finally {
      await fd.close();
    }
  } catch {
    /* 读不到就按明文处理 */
  }
  return 'none';
}

/** 读取会话日志的 header 行（原样保留，不改动）。 */
async function readHeaderLine(persistence, sessionId) {
  const raw = await persistence.readRaw(sessionId);
  if (!raw || typeof raw.content !== 'string' || raw.content.length === 0) {
    throw new Error('无法读取会话持久化文件');
  }
  const first = raw.content.split('\n', 1)[0];
  if (!first) throw new Error('会话持久化文件缺少 header 行');
  return first;
}

/** 用内存事件重写持久化文件（header 原样 + 每行一个事件；原子替换）。 */
async function rewriteSessionFile(ctx, session, events, boundary) {
  const persistence = ctx.sessionPersistence;
  if (!persistence || typeof persistence.locate !== 'function' || typeof persistence.readRaw !== 'function') {
    throw new Error('会话持久化服务不可用');
  }
  const headerLine = await readHeaderLine(persistence, session.id);
  const kept = events.slice(0, boundary + 1);
  const body = headerLine + '\n' + kept.map((e) => JSON.stringify(e)).join('\n') + '\n';
  const located = persistence.locate(session.header);
  if (!located || typeof located.path !== 'string') {
    throw new Error('无法定位会话存储文件');
  }
  const filePath = located.path;
  const compression = await detectCompression(filePath);
  let bytes;
  if (compression === 'zstd') {
    if (typeof zstdCompress !== 'function') throw new Error('当前 Node 运行时不支持 zstd 压缩');
    const nl = body.indexOf('\n');
    const headerFrame = await zstdCompressAsync(Buffer.from(body.slice(0, nl + 1), 'utf8'));
    const eventFrame = await zstdCompressAsync(Buffer.from(body.slice(nl + 1), 'utf8'));
    bytes = Buffer.concat([headerFrame, eventFrame]);
  } else {
    bytes = Buffer.from(body, 'utf8');
  }
  const tmp = filePath + '.retract-' + process.pid + '-' + Date.now() + '.tmp';
  await fsp.writeFile(tmp, bytes, { flag: 'wx' });
  try {
    await fsp.rename(tmp, filePath);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/** 同步持久化协调器的写游标与待写缓冲（防止后续 append 被过滤或回写旧事件）。 */
function resetCoordinator(ctx, session, boundary) {
  const persistence = ctx.sessionPersistence;
  const coordinator = persistence && persistence.coordinator;
  if (!coordinator) return;
  try {
    const state = coordinator.states && coordinator.states.get(session.id);
    if (state) state.cursor = boundary + 1;
  } catch {
    /* cursor 缺失时保持原样（极端情况） */
  }
  try {
    const live = coordinator.live && coordinator.live.get(session);
    const writes = live && live.writes;
    if (writes) {
      if (typeof writes.cancelAutomaticWait === 'function') writes.cancelAutomaticWait();
      if (Array.isArray(writes.pending)) writes.pending.length = 0;
    }
  } catch {
    /* 缓冲清理失败不影响主流程 */
  }
}

/**
 * 撤回：从会话中删除 seq >= U 的所有事件，返回保留的最后一个事件 seq。
 * 调用前应确保会话已停止运行（客户端负责 cancel）。
 */
export async function retractSession(ctx, sessionId, seq) {
  const sessions = ctx.sessions;
  if (!sessions || typeof sessions.get !== 'function') throw new Error('会话服务不可用');
  const session = sessions.get(String(sessionId));
  if (!session) throw new Error('会话不存在或未打开');
  const events = session.events;
  const U = Number(seq);
  if (!Number.isSafeInteger(U) || U < 0 || U >= events.length) throw new Error('无效的消息序号');
  if (events[U].type !== 'user/message') throw new Error('目标不是用户指令消息');

  const boundary = computeBoundary(events, U);
  if (boundary < 0) throw new Error('无法撤回：目标之前没有可保留的内容');

  // 1) 所有缓冲事件先落盘，确保文件与内存一致
  if (typeof sessions.flush === 'function') await sessions.flush(session);

  // 2) 截断内存（保留原始快照，文件失败时回滚）
  const originalEvents = session.events;
  replaceSessionLog(session, originalEvents.slice(0, boundary + 1));

  try {
    // 3) 重写持久化文件
    await rewriteSessionFile(ctx, session, originalEvents, boundary);
  } catch (err) {
    // 文件写入失败 → 恢复内存，保持状态一致
    replaceSessionLog(session, originalEvents);
    throw new Error('写入会话存储失败：' + (err && err.message ? err.message : String(err)));
  }

  // 4) 同步后端写游标与待写缓冲
  resetCoordinator(ctx, session, boundary);
  return boundary;
}

/** 注册撤回 API 路由；返回取消注册函数数组。 */
export function installRetractApi(ctx) {
  let webServer;
  try {
    webServer = ctx.webServer;
  } catch {
    webServer = undefined;
  }
  if (!webServer || typeof webServer.register !== 'function') {
    ctx.logger.warn('dsh-retract-prompt: webServer 不可用，撤回 API 未注册');
    return [];
  }

  const disposers = [];
  const route = (pathname, handler) => {
    disposers.push(webServer.register({ kind: 'exact', path: pathname, handler }));
  };

  route('/retract-prompt/api/retract', async (req, res) => {
    try {
      const body = await readBody(req);
      const boundary = await retractSession(ctx, String(body.sessionId ?? ''), body.seq);
      sendJson(res, 200, { ok: true, truncatedTo: boundary });
    } catch (err) {
      sendJson(res, 200, { ok: false, error: err && err.message ? err.message : String(err) });
    }
  });

  return disposers;
}

function sendJson(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('请求体不是有效 JSON'));
      }
    });
    req.on('error', reject);
  });
}
