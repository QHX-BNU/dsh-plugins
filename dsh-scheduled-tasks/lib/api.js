/**
 * dsh-scheduled-tasks —— 可视化页面 HTTP API（服务端）
 *
 * 在 ctx.webServer 上注册 /scheduled-tasks/api/* 路由，供设置页中的
 * "定时任务"可视化 section 调用（同源 fetch）。
 *
 * 读接口：
 *   GET  /scheduled-tasks/api/list
 * 写接口（POST，JSON body）：
 *   POST /scheduled-tasks/api/save     {task}        新增或更新
 *   POST /scheduled-tasks/api/delete   {id}
 *   POST /scheduled-tasks/api/toggle   {id, enabled}
 *   POST /scheduled-tasks/api/run-now  {id}          立即执行一次
 */
import { newTaskId, parseClock, computeNextRun } from './scheduler.js';

const MAX_BODY_BYTES = 512 * 1024;

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = MAX_BODY_BYTES) {
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
      if (!done) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

async function parseJsonBody(req) {
  const text = (await readBody(req)).trim();
  if (!text) return {};
  return JSON.parse(text);
}

const MODES = ['once', 'daily', 'weekly', 'interval'];
const ACTIONS = ['session', 'command'];
const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];

/** 校验时区名是否为合法 IANA 时区。 */
function isValidTimeZone(tz) {
  if (typeof tz !== 'string' || tz.length === 0 || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * 校验并规范化客户端提交的任务；返回可直接存储的任务对象。
 * @param input 客户端原始字段
 * @param existing 已存在的任务（更新时），用于保留 id / 计数等字段
 */
export function validateTaskInput(input, existing) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('任务数据格式不正确');
  }
  const name = String(input.name ?? '').trim();
  if (!name) throw new Error('请填写任务名称');
  if (name.length > 100) throw new Error('任务名称过长（最多 100 字）');

  const mode = String(input.mode ?? '');
  if (!MODES.includes(mode)) throw new Error('执行模式不正确');

  const timeZone = String(input.timeZone ?? '');
  if (!isValidTimeZone(timeZone)) throw new Error('时区无效，请使用浏览器默认时区');

  const action = String(input.action ?? '');
  if (!ACTIONS.includes(action)) throw new Error('动作类型不正确');

  const content = String(input.content ?? '').trim();
  if (!content) throw new Error('请填写任务内容');
  if (content.length > 20000) throw new Error('任务内容过长（最多 20000 字）');

  // 模式专属参数
  if (mode === 'once') {
    const atMs = Date.parse(String(input.at ?? ''));
    if (!Number.isFinite(atMs)) throw new Error('请填写有效的执行时间');
    if (atMs <= Date.now() - 60000) throw new Error('一次性任务的执行时间需晚于当前时间');
  } else if (mode === 'daily' || mode === 'weekly') {
    if (!parseClock(input.time)) throw new Error('请填写有效的时刻（HH:mm）');
    if (mode === 'weekly') {
      const days = Array.isArray(input.weekdays)
        ? [...new Set(input.weekdays.map(Number).filter((d) => WEEKDAYS.includes(d)))]
        : [];
      if (days.length === 0) throw new Error('请至少选择一天');
      if (days.length === 7) throw new Error('每周模式无需全选，请改用"每天"');
    }
  } else if (mode === 'interval') {
    const minutes = Number(input.intervalMinutes);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 10080) {
      throw new Error('间隔分钟数需为 1~10080 的整数');
    }
  }

  // 起止日期（仅重复模式；按任务时区的墙上日期解释，含当天）
  let startDate = null;
  let endDate = null;
  if (mode !== 'once') {
    const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
    const sd = String(input.startDate ?? '').trim();
    const ed = String(input.endDate ?? '').trim();
    if (sd && !DATE_RE.test(sd)) throw new Error('开始日期格式不正确（YYYY-MM-DD）');
    if (ed && !DATE_RE.test(ed)) throw new Error('结束日期格式不正确（YYYY-MM-DD）');
    if (sd && !isRealDate(sd)) throw new Error('开始日期不是有效的日期');
    if (ed && !isRealDate(ed)) throw new Error('结束日期不是有效的日期');
    if (sd && ed && ed < sd) throw new Error('结束日期不能早于开始日期');
    startDate = sd || null;
    endDate = ed || null;
  }

  // 动作专属参数
  if (action === 'session') {
    const sessionId = String(input.sessionId ?? '').trim();
    if (!sessionId) throw new Error('请选择目标会话');
  }

  const now = Date.now();
  const task = {
    id: existing ? String(existing.id) : newTaskId(),
    name,
    enabled: existing ? existing.enabled !== false : input.enabled !== false,
    mode,
    timeZone,
    action,
    content,
    createdAt: existing ? existing.createdAt : now,
    updatedAt: now,
    // 模式参数（仅保留当前模式所需）
    at: mode === 'once' ? new Date(Date.parse(input.at)).toISOString() : null,
    time: mode === 'daily' || mode === 'weekly' ? String(input.time).trim() : null,
    weekdays: mode === 'weekly'
      ? [...new Set(input.weekdays.map(Number).filter((d) => WEEKDAYS.includes(d)))]
      : null,
    intervalMinutes: mode === 'interval' ? Number(input.intervalMinutes) : null,
    startDate,
    endDate,
    sessionId: action === 'session' ? String(input.sessionId).trim() : null,
    // 保留既有统计字段
    runCount: existing ? existing.runCount || 0 : 0,
    lastRunAt: existing ? existing.lastRunAt ?? null : null,
    lastStatus: existing ? existing.lastStatus ?? null : null,
    lastError: existing ? existing.lastError ?? null : null,
    missed: existing ? existing.missed || 0 : 0,
    completedAt: existing ? existing.completedAt ?? null : null,
    history: existing && Array.isArray(existing.history) ? existing.history : [],
  };
  // 重新启用（toggle/save 时 enabled=true）后清除完成标记
  if (task.enabled) task.completedAt = null;
  task.nextRunAt = computeNextRun(task, now);
  return task;
}

/** "YYYY-MM-DD" 是否为真实存在的日历日期。 */
function isRealDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() + 1 === mo && date.getUTCDate() === d;
}

/** 注册定时任务 API 路由；返回取消注册函数数组。 */
export function installTasksApi(ctx, store, scheduler) {
  let webServer;
  try {
    webServer = ctx.webServer;
  } catch {
    webServer = undefined;
  }
  if (!webServer || typeof webServer.register !== 'function') {
    ctx.logger.warn?.('dsh-scheduled-tasks: webServer 不可用，可视化页面 API 未注册');
    return [];
  }

  const disposers = [];
  const route = (path, handler) => {
    disposers.push(webServer.register({ kind: 'exact', path, handler }));
  };

  route('/scheduled-tasks/api/list', (_req, res) => {
    sendJson(res, 200, { ok: true, now: Date.now(), tasks: store.tasks });
  });

  route('/scheduled-tasks/api/save', async (req, res) => {
    try {
      const body = await parseJsonBody(req);
      const existing = body.id ? store.get(String(body.id)) : undefined;
      const task = validateTaskInput(body.task ?? body, existing);
      store.upsert(task);
      scheduler.schedule();
      sendJson(res, 200, { ok: true, task });
    } catch (err) {
      sendJson(res, 200, { ok: false, error: err && err.message ? err.message : String(err) });
    }
  });

  route('/scheduled-tasks/api/delete', async (req, res) => {
    try {
      const body = await parseJsonBody(req);
      const id = String(body.id ?? '');
      if (!id) throw new Error('缺少任务 ID');
      const deleted = store.remove(id);
      if (!deleted) {
        sendJson(res, 200, { ok: false, error: '任务不存在' });
        return;
      }
      scheduler.schedule();
      sendJson(res, 200, { ok: true, id });
    } catch (err) {
      sendJson(res, 200, { ok: false, error: err && err.message ? err.message : String(err) });
    }
  });

  route('/scheduled-tasks/api/toggle', async (req, res) => {
    try {
      const body = await parseJsonBody(req);
      const id = String(body.id ?? '');
      const task = store.get(id);
      if (!task) throw new Error('任务不存在');
      task.enabled = body.enabled !== false;
      task.updatedAt = Date.now();
      if (task.enabled) task.completedAt = null;
      task.nextRunAt = task.enabled ? computeNextRun(task, Date.now()) : null;
      store.persist();
      scheduler.schedule();
      sendJson(res, 200, { ok: true, task });
    } catch (err) {
      sendJson(res, 200, { ok: false, error: err && err.message ? err.message : String(err) });
    }
  });

  route('/scheduled-tasks/api/run-now', async (req, res) => {
    try {
      const body = await parseJsonBody(req);
      const id = String(body.id ?? '');
      if (!id) throw new Error('缺少任务 ID');
      const result = await scheduler.runNow(id);
      sendJson(res, 200, { ok: true, ...result });
    } catch (err) {
      sendJson(res, 200, { ok: false, error: err && err.message ? err.message : String(err) });
    }
  });

  ctx.logger.info?.('dsh-scheduled-tasks: 可视化页面 API 已注册（/scheduled-tasks/api/*）');
  return disposers;
}
