/**
 * dsh-retract-prompt —— 撤回核心（服务端 v2，适配 DSH 2.0.14 / 会话格式 v4）
 *
 * 撤回 = 从会话中真正移除 seq >= U 的事件（含其后的回复），并重建所有派生状态：
 *   1) 持久化：重写会话 JSONL（v4 = header zstd 帧 + 事件批 zstd 帧），
 *      同步写句柄游标 state.cursor、读水位 observedLength、清缓冲；
 *   2) 内存：截断 session.log，重建 SurfaceManager 折叠状态与各水位缓存；
 *   3) 投影：清 sessionProjections 单元 cell 与 sessionProjectionCache 记录。
 *
 * 旧版（<= 0.2.x，扁平 JSONL + persistence.readRaw/coordinator）走兼容分支。
 */
import { promises as fsp } from 'node:fs';
import { promisify } from 'node:util';
import { zstdCompress } from 'node:zlib';
import { randomBytes } from 'node:crypto';

const zstdCompressAsync = promisify(zstdCompress);
/** Zstandard 帧魔数（小端）。 */
const ZSTD_MAGIC = 0xfd2fb528;
// ------------------------------------------------------------------ 基础工具

/** 读取会话事件（兼容新版 snapshotEvents() 与旧版 events/log）。 */
function sessionEvents(session) {
  try {
    if (typeof session.snapshotEvents === 'function') {
      const snapshot = session.snapshotEvents();
      if (Array.isArray(snapshot)) return snapshot;
    }
  } catch {
    /* fallthrough */
  }
  try {
    if (Array.isArray(session.events)) return session.events;
  } catch {
    /* fallthrough */
  }
  try {
    if (Array.isArray(session.log)) return session.log.slice();
  } catch {
    /* fallthrough */
  }
  throw new Error('会话事件不可用');
}

/** 读取可选服务（不存在时返回 undefined，不抛错）。 */
function serviceOf(ctx, name) {
  try {
    if (ctx && typeof ctx.get === 'function') return ctx.get(name);
  } catch {
    /* ignore */
  }
  try {
    return ctx ? ctx[name] : undefined;
  } catch {
    return undefined;
  }
}

/** 是否为新版句柄化持久化后端（2.0.14+）。 */
function isHandlePersistence(persistence) {
  return Boolean(
    persistence &&
      persistence.tracker &&
      persistence.tracker.writers instanceof Map &&
      typeof persistence.readStoredLog === 'function' &&
      typeof persistence.encodeMaterialization === 'function' &&
      typeof persistence.findLog === 'function',
  );
}
// ------------------------------------------------------------------ 撤回边界

/**
 * 计算撤回边界：删除 seq >= U 的所有事件（含目标消息及其后的回复）。
 * 若 U 之前存在未关闭回合（turn/start 未配对），边界前移到该回合开始之前。
 * @returns 保留的最后一个事件 seq；-1 表示没有可保留内容。
 */
export function computeBoundary(events, U) {
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

/**
 * 事件流尾部是否存在未关闭回合（最后一个 turn 边界是 turn/start）。
 * Agent 正常静止时，最后一个 turn 边界必为 turn/end。
 */
export function hasOpenTurn(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const t = events[i].type;
    if (t === 'turn/start' || t === 'turn/end') return t === 'turn/start';
  }
  return false;
}

// ------------------------------------------------------------------ 内存截断

/** 截断会话日志本体（保持数组身份，surfaceManager 借用同一数组）。 */
function truncateLog(session, boundary) {
  const log = session.log;
  if (!Array.isArray(log)) throw new Error('会话日志不可用');
  log.length = boundary + 1;
}
/**
 * 新版（2.0.14+）内存缓存重置。
 * 新版 Session 的增量水位都假设单调追加：尾部变短后守卫会短路并留下幽灵节点，
 * 因此必须显式重建 surface 折叠状态与各折叠水位。
 */
function resetSessionCaches(session) {
  session.eventsSnapshot = undefined;

  const sm = session.surfaceManager;
  if (sm && typeof sm === 'object') {
    try {
      sm._pendingPlan = undefined;
      let st = sm._state;
      if (!st || typeof st !== 'object') {
        st = {};
        sm._state = st;
      }
      if (Array.isArray(st.nodes)) st.nodes.length = 0;
      else st.nodes = [];
      if (st.projectedMessages && typeof st.projectedMessages.clear === 'function') st.projectedMessages.clear();
      else st.projectedMessages = new Map();
      if (st.projections && typeof st.projections.clear === 'function') st.projections.clear();
      else st.projections = new Set();
      st.replaceGeneration = 0;
      st.contentGeneration = 0;
      sm._lastProcessedSeq = -1;
    } catch {
      /* 单字段异常不阻塞撤回 */
    }
  }

  session.derived = [];
  session.derivedNodes = 0;
  session.derivedGeneration = -1;
  session.headerFold = undefined;
  session.headerFoldSeq = 0;
  session.contextFold = undefined;
  session.contextFoldSeq = 0;

  const toolProjection = session.toolHistoryProjection;
  if (toolProjection && typeof toolProjection === 'object' && typeof toolProjection.constructor === 'function') {
    try {
      session.toolHistoryProjection = new toolProjection.constructor();
    } catch {
      /* 保持原对象，仅退水位 */
    }
  }
  session.toolHistorySeq = 0;
}
/** 旧版（<= 0.2.x）内存缓存重置（保留原实现）。 */
function resetSessionCachesLegacy(session) {
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

/** 重置会话投影：清单元 cell（框架按截断后的日志惰性重建）与持久 checkpoint。 */
function resetProjectionCaches(ctx, session) {
  try {
    const registry = serviceOf(ctx, 'sessionProjections');
    const registrations = registry && registry.registrations;
    if (registrations && typeof registrations.values === 'function') {
      for (const registration of registrations.values()) {
        try {
          if (registration && registration.cells && typeof registration.cells.delete === 'function') {
            registration.cells.delete(session);
          }
        } catch {
          /* 单单元失败不影响其它单元 */
        }
      }
    }
  } catch {
    /* 投影服务未加载时跳过 */
  }

  try {
    const cache = serviceOf(ctx, 'sessionProjectionCache');
    const table = cache && cache.table;
    if (table && typeof table.delete === 'function') {
      Promise.resolve(table.delete(String(session.id))).catch(() => {});
    }
  } catch {
    /* 竞争或服务不可用：跳过 */
  }
}
// ------------------------------------------------------------------ 新版文件重写

/** 写独占临时文件并 fsync。 */
async function writeSyncedTemp(tmp, bytes) {
  const handle = await fsp.open(tmp, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * 新版：把会话存储文件重写为前 N 个事件的 v4 zstd 版本，并重置写句柄状态。
 * 步骤：排空句柄 -> 编码 -> 临时文件 -> 备份 -> 原子发布 -> 重读校验 ->
 *       删备份 -> 重置 state.cursor/observedLength/buffered（失败则回滚）。
 */
async function rewriteStoredLog(ctx, session, kept) {
  const persistence = ctx.sessionPersistence;
  const id = String(session.id);
  const tracker = persistence.tracker;

  let located = await persistence.findLog(id).catch(() => undefined);
  if (!located || !located.currentPath) return; // 未物化：只需内存截断

  let handle = tracker.writers.get(id);
  let opened = false;
  if (handle === undefined || handle === null) {
    handle = await persistence.open(id, 'write');
    opened = true;
  }
  // 历史世代（v0~v3）：open 已触发迁移，重新解析当前世代路径
  if (located.sourceVersion !== 4) {
    located = (await persistence.findLog(id).catch(() => undefined)) || located;
    if (located.sourceVersion !== 4) {
      throw new Error('会话日志尚未迁移到 v4，请先在 DSH 中打开该会话后重试');
    }
  }

  try {
    // 1) 排空缓冲并确保 header 落盘，避免旧事件被再次写回
    if (typeof handle.drainLive === 'function') await handle.drainLive();
    if (handle.chain && typeof handle.chain.then === 'function') await handle.chain.catch(() => {});
    if (typeof handle.flush === 'function') await handle.flush();
    if (Array.isArray(handle.buffered)) handle.buffered.length = 0;
    if (handle.batchTimer !== undefined) {
      try {
        clearTimeout(handle.batchTimer);
      } catch {
        /* ignore */
      }
      handle.batchTimer = undefined;
    }
    // 2) 目标路径与新内容（编码交给后端自身，保证帧格式与其读取器一致）
    const finalPath = located.currentPath;
    const isSeeded = Boolean(session.header && session.header.isSeeded === true);
    const cut = isSeeded ? Number(session.inheritedEventCount ?? 0) : 0;
    const content = await persistence.encodeMaterialization(session.header, cut, kept);

    const tmp = finalPath + '.' + randomBytes(6).toString('hex') + '.retract-tmp';
    const backup = finalPath + '.' + randomBytes(6).toString('hex') + '.retract-bak';
    let backedUp = false;
    let published = false;

    await writeSyncedTemp(tmp, content);

    try {
      // 3) 备份 -> 发布 -> 重读校验
      await fsp.rename(finalPath, backup);
      backedUp = true;
      await fsp.rename(tmp, finalPath);
      published = true;

      const memo = persistence.coldLogMemo;
      if (memo && typeof memo.delete === 'function') memo.delete(id);

      const fresh = await persistence.readStoredLog(finalPath, id);
      if (!fresh || !Array.isArray(fresh.events) || fresh.events.length !== kept.length) {
        throw new Error('重写后的会话文件校验失败（事件数不匹配）');
      }
      if (fresh.tornTruncateTo !== undefined || (Array.isArray(fresh.recoveredTail) && fresh.recoveredTail.length > 0)) {
        throw new Error('重写后的会话文件存在未完成的帧');
      }

      await fsp.rm(backup, { force: true }).catch(() => {});
      backedUp = false;
    } catch (error) {
      // 4) 回滚：恢复原文件并失效缓存
      const failures = [];
      try {
        await fsp.rm(tmp, { force: true }).catch(() => {});
        if (published) await fsp.rm(finalPath, { force: true }).catch(() => {});
        if (backedUp) {
          await fsp.rename(backup, finalPath);
          backedUp = false;
        }
      } catch (rollbackError) {
        failures.push(rollbackError);
      }
      try {
        const memo = persistence.coldLogMemo;
        if (memo && typeof memo.delete === 'function') memo.delete(id);
      } catch {
        /* ignore */
      }
      if (failures.length > 0) {
        throw new AggregateError([error, ...failures], '重写会话文件失败且回滚失败，备份保留在磁盘');
      }
      throw error;
    }
    // 5) 重置写句柄状态（游标 / 水位 / 缓冲 / 恢复位）
    const state = handle.state && typeof handle.state === 'object' ? handle.state : (handle.state = {});
    state.cursor = kept.length;
    state.materialized = true;
    state.primed = undefined;
    state.tornTruncateTo = undefined;
    state.recoveredTail = undefined;
    if (typeof handle.observedLength === 'number') handle.observedLength = kept.length;
    if (Array.isArray(handle.buffered)) handle.buffered.length = 0;
    if (handle.batchTimer !== undefined) {
      try {
        clearTimeout(handle.batchTimer);
      } catch {
        /* ignore */
      }
      handle.batchTimer = undefined;
    }
    handle.drainPaused = false;
  } finally {
    if (opened) {
      try {
        await handle.close();
      } catch {
        /* 释放失败不阻塞撤回结果 */
      }
    }
  }
}

// ------------------------------------------------------------------ 旧版文件重写

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
    /* 读不到按明文处理 */
  }
  return 'none';
}
/** 读取旧版会话持久化文件的 header 行（原样保留）。 */
async function readHeaderLine(persistence, sessionId) {
  const raw = await persistence.readRaw(sessionId);
  if (!raw || typeof raw.content !== 'string' || raw.content.length === 0) {
    throw new Error('无法读取会话持久化文件');
  }
  const first = raw.content.split('\n', 1)[0];
  if (!first) throw new Error('会话持久化文件缺少 header 行');
  return first;
}

/** 旧版：用内存事件重写持久化文件（header 原样 + 每行一个事件；原子替换）。 */
async function rewriteSessionFileLegacy(ctx, session, events, boundary) {
  const persistence = ctx.sessionPersistence;
  if (!persistence || typeof persistence.locate !== 'function' || typeof persistence.readRaw !== 'function') {
    throw new Error('会话持久化服务不可用');
  }
  const headerLine = await readHeaderLine(persistence, session.id);
  const kept = events.slice(0, boundary + 1);
  const body = headerLine + '\n' + kept.map((e) => JSON.stringify(e)).join('\n') + '\n';
  const located = persistence.locate(session.header);
  if (!located || typeof located.path !== 'string') throw new Error('无法定位会话存储文件');
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
  await writeSyncedTemp(tmp, bytes);
  try {
    await fsp.rename(tmp, filePath);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/** 旧版：同步持久化协调器的写游标与待写缓冲。 */
function resetCoordinatorLegacy(ctx, session, boundary) {
  const persistence = ctx.sessionPersistence;
  const coordinator = persistence && persistence.coordinator;
  if (!coordinator) return;
  try {
    const state = coordinator.states && coordinator.states.get(session.id);
    if (state) state.cursor = boundary + 1;
  } catch {
    /* cursor 缺失时保持原样 */
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
// ------------------------------------------------------------------ 撤回入口

/**
 * 撤回：从会话中删除 seq >= U 的所有事件，返回保留的最后一个事件 seq。
 * 调用前应确保会话已停止运行（客户端先 cancel）；服务端兜底检查 open turn。
 */
export async function retractSession(ctx, sessionId, seq) {
  const sessions = ctx.sessions;
  if (!sessions || typeof sessions.get !== 'function') throw new Error('会话服务不可用');
  const session = sessions.get(String(sessionId));
  if (!session) throw new Error('会话不存在或未打开');

  const events = sessionEvents(session);
  const U = Number(seq);
  if (!Number.isSafeInteger(U) || U < 0 || U >= events.length) throw new Error('无效的消息序号');
  if (events[U].type !== 'user/message') throw new Error('目标不是用户指令消息');
  if (hasOpenTurn(events)) throw new Error('Agent 仍在运行，请先停止当前运行再撤回');

  const boundary = computeBoundary(events, U);
  if (boundary < 0) throw new Error('无法撤回：目标之前没有可保留的内容');

  const inherited = Number(session.inheritedEventCount ?? 0);
  if (Number.isFinite(inherited) && boundary < inherited) {
    throw new Error('无法撤回：该指令位于会话分叉继承的前缀中，不能从本会话移除');
  }

  // 1) 所有缓冲事件先落盘，确保文件与内存一致
  if (typeof sessions.flush === 'function') await sessions.flush(session);

  const persistence = ctx.sessionPersistence;
  const modern = isHandlePersistence(persistence);
  const legacy = !modern && persistence && typeof persistence.locate === 'function' && typeof persistence.readRaw === 'function';

  // 2) 重写持久化文件（若已物化）
  try {
    if (modern) {
      await rewriteStoredLog(ctx, session, events.slice(0, boundary + 1));
    } else if (legacy) {
      await rewriteSessionFileLegacy(ctx, session, events, boundary);
      resetCoordinatorLegacy(ctx, session, boundary);
    } else if (persistence && (typeof persistence.open === 'function' || typeof persistence.locate === 'function')) {
      throw new Error('当前 DSH 版本的会话持久化接口不受支持，请更新 dsh-retract-prompt 插件');
    }
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    if (message.indexOf('写入会话存储失败') === 0) throw err;
    const wrapped = new Error('写入会话存储失败：' + message);
    wrapped.cause = err;
    throw wrapped;
  }

  // 3) 截断内存日志并重建派生状态
  truncateLog(session, boundary);
  if (modern || typeof session.snapshotEvents === 'function' || 'toolHistoryProjection' in session) {
    resetSessionCaches(session);
  } else {
    resetSessionCachesLegacy(session);
  }

  // 4) 重置会话投影（内存单元 + 持久 checkpoint）
  resetProjectionCaches(ctx, session);
  return boundary;
}
// ------------------------------------------------------------------ Web API

/** 注册撤回 API 路由；返回取消注册函数数组。 */
export function installRetractApi(ctx, config) {
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

  // 客户端读取插件配置（autoStop 等）
  route('/retract-prompt/api/config', async (_req, res) => {
    sendJson(res, 200, { ok: true, autoStop: config ? config.autoStop !== false : true });
  });

  route('/retract-prompt/api/retract', async (req, res) => {
    try {
      const body = await readBody(req, 64 * 1024);
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

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        done = true;
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
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