/**
 * dsh-scheduled-tasks —— 调度核心（服务端）
 *
 * 负责：
 * 1. 任务持久化（JSON 文件，原子写入）；
 * 2. 下次执行时间计算（once / daily / weekly / interval，IANA 时区，DST 校正）；
 * 3. 调度循环（setTimeout 驱动，到期批量执行后重排）；
 * 4. 动作执行：
 *    - session：向指定会话 followup 一条用户消息（唤醒 Agent 处理）；
 *    - command：通过 shell 执行命令并记录输出。
 *
 * 零外部依赖：仅使用 Node 内置模块与 DSH 注入的服务
 * （ctx.agents / ctx.sessions），消息构造复用 @deepseek-ai/dsh-llm 的
 * createUserMessage，与官方注入通道保持完全一致。
 */
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const MAX_TIMEOUT_MS = 2 ** 31 - 1; // Node setTimeout 上限（约 24.8 天）
const HISTORY_LIMIT = 10;
const MAX_HISTORY_DETAIL = 600;
const MAX_COMMAND_OUTPUT = 2000;

/** ---------- 时间计算 ---------- */

/** 取 Date 在指定 IANA 时区下的墙上时间各部分。 */
function wallParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(date).filter((p) => p.type !== 'literal').map((p) => [p.type, Number(p.value)]),
  );
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
  };
}

/** 墙上时间 → epoch（先用目标日正午估算时区偏移，再精细校正 DST 偏差）。 */
export function wallTimeToEpoch({ year, month, day, hour, minute, second }, timeZone) {
  // 第一步：用目标日正午 UTC 的墙上时间估算该时区偏移
  const noonUtc = Date.UTC(year, month - 1, day, 12, 0, 0);
  const noonWall = wallParts(new Date(noonUtc), timeZone);
  const offsetMs = (noonWall.hour - 12) * 3_600_000 + noonWall.minute * 60_000;
  let approx = noonUtc - offsetMs + (hour - 12) * 3_600_000 + minute * 60_000 + second * 1000;
  // 第二步：DST 切换日正午与目标时刻偏移可能差 30/60 分钟，精细校正
  for (const shift of [0, -30, 30, -60, 60, -90, 90, -120, 120].map((m) => m * 60_000)) {
    const w = wallParts(new Date(approx + shift), timeZone);
    if (w.year === year && w.month === month && w.day === day
      && w.hour === hour && w.minute === minute) {
      return approx + shift;
    }
  }
  // DST 跳变（gap）时刻不存在：按 approx 处墙上时间与目标的差值平移，
  // 映射到时钟跳变后的对应时刻（如 02:30 → 03:30 PDT）
  const w = wallParts(new Date(approx), timeZone);
  return approx
    + (hour - w.hour) * 3_600_000
    + (minute - w.minute) * 60_000
    + (second - w.second) * 1000;
}

/** 某时区墙上日期对应的星期（0=周日）。 */
function weekdayOf({ year, month, day }) {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** 解析 "YYYY-MM-DD" → {year, month, day}；非法返回 null。 */
function parseYMD(s) {
  if (typeof s !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const ymd = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
  // 校验为真实存在的日历日期
  const d = new Date(Date.UTC(ymd.year, ymd.month - 1, ymd.day));
  if (d.getUTCFullYear() !== ymd.year || d.getUTCMonth() + 1 !== ymd.month || d.getUTCDate() !== ymd.day) {
    return null;
  }
  return ymd;
}

/** 墙上日期比较：a < b → 负数。 */
function ymdCmp(a, b) {
  return (a.year - b.year) || (a.month - b.month) || (a.day - b.day);
}

/** 墙上日期加减天数（纯日历运算，不受 DST 影响）。 */
function addDays(ymd, n) {
  const d = new Date(Date.UTC(ymd.year, ymd.month - 1, ymd.day) + n * 86_400_000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** 当前时刻在指定时区的墙上日期。 */
function wallToday(tz, now) {
  const w = wallParts(new Date(now), tz);
  return { year: w.year, month: w.month, day: w.day };
}

/** 解析 "HH:mm" → {hour, minute}；非法返回 null。 */
export function parseClock(time) {
  if (typeof time !== 'string') return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time.trim());
  if (!m) return null;
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

/** 校验 IANA 时区名是否合法。 */
export function isValidTimeZone(tz) {
  if (typeof tz !== 'string' || tz.length === 0 || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * 解析一次性任务的执行时间（供 Agent 工具使用）：
 * - 带时区偏移的 ISO 8601（含 Z 或 ±HH:MM）→ 直接使用；
 * - 无偏移的本地时间（YYYY-MM-DDTHH:mm 或 YYYY-MM-DD HH:mm）→ 按 timeZone
 *   解释墙上时间。
 * @returns UTC ISO 字符串
 */
export function parseAtInput(input, timeZone) {
  const s = String(input ?? '').trim();
  if (!s) throw new Error('请提供执行时间（at）');
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) throw new Error(`执行时间格式无效："${s}"（请使用 ISO 8601 格式）`);
  if (/(Z|[+-]\d{2}:?\d{2})$/i.test(s)) return new Date(ms).toISOString();
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(s);
  if (!m) throw new Error(`执行时间格式无效："${s}"（缺少完整日期时间）`);
  const tz = isValidTimeZone(timeZone) ? timeZone : 'UTC';
  const epoch = wallTimeToEpoch({
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: Number(m[4]),
    minute: Number(m[5]),
    second: Number(m[6] || 0),
  }, tz);
  return new Date(epoch).toISOString();
}

/**
 * 计算任务的下一次执行时间（epoch ms）。
 * 重复任务（daily/weekly/interval）支持 startDate/endDate（"YYYY-MM-DD"，
 * 按任务时区的墙上日期解释，含当天）限定执行区间：
 * - 尚未到开始日期：从开始日期起计算下一次；
 * - 已过结束日期：返回 null（调用方据此停用任务）。
 * @returns 未来时刻；一次性任务已过期、超出结束日期或无下次时返回 null。
 */
export function computeNextRun(task, now = Date.now()) {
  const tz = task.timeZone || 'UTC';
  switch (task.mode) {
    case 'once': {
      const at = Date.parse(task.at);
      return Number.isFinite(at) && at > now ? at : null;
    }
    case 'daily': {
      const clock = parseClock(task.time);
      if (!clock) return null;
      const start = parseYMD(task.startDate);
      const end = parseYMD(task.endDate);
      let day = wallToday(tz, now);
      if (start && ymdCmp(day, start) < 0) day = start;
      // 逐日推进：最多覆盖 start→end 全区间（防呆上限 8 年）
      let guard = 0;
      while (guard++ < 3000) {
        if (end && ymdCmp(day, end) > 0) return null;
        const target = wallTimeToEpoch({ ...day, ...clock, second: 0 }, tz);
        if (target > now) return target;
        day = addDays(day, 1);
      }
      return null;
    }
    case 'weekly': {
      const clock = parseClock(task.time);
      const days = Array.isArray(task.weekdays) ? task.weekdays : [];
      if (!clock || days.length === 0) return null;
      const start = parseYMD(task.startDate);
      const end = parseYMD(task.endDate);
      let day = wallToday(tz, now);
      if (start && ymdCmp(day, start) < 0) day = start;
      let guard = 0;
      while (guard++ < 3000) {
        if (end && ymdCmp(day, end) > 0) return null;
        if (days.includes(weekdayOf(day))) {
          const target = wallTimeToEpoch({ ...day, ...clock, second: 0 }, tz);
          if (target > now) return target;
        }
        day = addDays(day, 1);
      }
      return null;
    }
    case 'interval': {
      const step = Math.max(1, Number(task.intervalMinutes) || 1) * 60_000;
      const base = task.lastRunAt || task.createdAt || now;
      // 起止时刻（按任务时区的墙上日期解释；无设置则为无穷）
      const startEpoch = task.startDate
        ? wallTimeToEpoch({ ...parseYMD(task.startDate), hour: 0, minute: 0, second: 0 }, tz)
        : -Infinity;
      const endEpoch = task.endDate
        ? wallTimeToEpoch({ ...parseYMD(task.endDate), hour: 23, minute: 59, second: 59 }, tz)
        : Infinity;
      // 从 lastRunAt/createdAt 对齐；若落在开始日期之前，则从开始日期对齐
      let anchor = base;
      if (anchor < startEpoch) anchor = startEpoch;
      // 跳过错过的周期，直接对齐到 anchor + k*step > now 的自然时刻
      const k = Math.max(1, Math.floor((now - anchor) / step) + 1);
      const next = anchor + k * step;
      return next > endEpoch ? null : next;
    }
    default:
      return null;
  }
}

/** ---------- 持久化 ---------- */

/** 任务存储：JSON 文件 + 原子写。 */
export class TaskStore {
  constructor(filePath, logger) {
    this.filePath = filePath;
    this.logger = logger;
    this.tasks = [];
    this.load();
  }

  load() {
    try {
      const raw = readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      this.tasks = Array.isArray(parsed) ? parsed.filter((t) => t && typeof t === 'object') : [];
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        this.tasks = [];
        return;
      }
      // 文件损坏：备份后从空列表启动，避免插件整体不可用
      this.logger?.warn?.(
        `dsh-scheduled-tasks: 任务文件读取失败（${err.message}），备份后重新初始化`,
      );
      try {
        renameSync(this.filePath, `${this.filePath}.corrupt-${Date.now()}`);
      } catch {
        /* 备份失败忽略 */
      }
      this.tasks = [];
    }
  }

  persist() {
    const dir = this.filePath.includes('/') || this.filePath.includes('\\')
      ? this.filePath.slice(0, Math.max(this.filePath.lastIndexOf('/'), this.filePath.lastIndexOf('\\')))
      : '.';
    mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, JSON.stringify(this.tasks, null, 2), 'utf8');
    try {
      renameSync(tmp, this.filePath);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
  }

  get(id) {
    return this.tasks.find((t) => t.id === id) || null;
  }

  upsert(task) {
    const index = this.tasks.findIndex((t) => t.id === task.id);
    if (index >= 0) this.tasks[index] = task;
    else this.tasks.push(task);
    this.persist();
    return task;
  }

  remove(id) {
    const index = this.tasks.findIndex((t) => t.id === id);
    if (index < 0) return false;
    this.tasks.splice(index, 1);
    this.persist();
    return true;
  }
}

/** ---------- 动作执行 ---------- */

/** 执行 shell 命令，返回截断后的输出。 */
function runCommand(command, { timeoutMs, cwd }) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
      process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command],
      {
        cwd: cwd || undefined,
        windowsHide: true,
        timeout: Math.max(1000, Number(timeoutMs) || 120_000),
        maxBuffer: 4 * 1024 * 1024,
        encoding: 'utf8',
      },
      (err, stdout, stderr) => {
        const output = [stdout, stderr].filter(Boolean).join('\n').trim();
        if (err && !output) {
          reject(new Error(`命令执行失败：${err.message}`));
          return;
        }
        resolve(output || (err ? `命令已执行（退出码 ${err.code ?? '未知'}）` : '(无输出)'));
      },
    );
    child.on('error', reject);
  });
}

/**
 * 构造"定时任务"来源的用户消息。
 * 与 @deepseek-ai/dsh-llm 的 createUserMessage 输出结构完全一致
 * （id + role:user + source），并递归冻结保证不可变，避免运行时依赖。
 */
function buildTaskMessage(content) {
  const message = {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: String(content) }],
    source: { kind: 'plugin', plugin: 'dsh-scheduled-tasks' },
  };
  return deepFreeze(message);
}

/** 递归深度冻结（用于消息对象）。 */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

/**
 * 在目标会话未打开时，挑选一个当前打开的根会话作为转投目标。
 * 优先 agents.roots()（无 owner 的根会话，排除子代理），退回 agents.list()。
 * @returns 找到的 agent，或 null
 */
function pickOpenRootAgent(agents, excludeSessionId) {
  try {
    const exclude = String(excludeSessionId || '');
    const candidates = [];
    if (typeof agents.roots === 'function') candidates.push(...(agents.roots() ?? []));
    if (typeof agents.list === 'function') {
      for (const a of agents.list() ?? []) {
        if (!candidates.includes(a)) candidates.push(a);
      }
    }
    const pick = candidates.find(
      (a) => a && typeof a.followup === 'function' && String(a.session?.id ?? a.id) !== exclude,
    );
    return pick ?? null;
  } catch {
    return null;
  }
}

/** 执行单个任务；返回执行结果摘要。 */
export async function executeTask(ctx, task, config) {
  const startedAt = Date.now();
  let status = 'ok';
  let detail = '';
  try {
    if (task.action === 'session') {
      const agents = ctx.agents;
      const sessionId = String(task.sessionId || '');
      if (!agents || typeof agents.get !== 'function') throw new Error('Agent 服务不可用');
      const agent = agents.get(sessionId);
      if (!agent) {
        // 目标会话未打开：若开启 fallback，转投到当前打开的根会话，避免提醒落空
        if (config.fallbackToOpenSession !== false) {
          const fallback = pickOpenRootAgent(agents, sessionId);
          if (fallback) {
            if (typeof fallback.followup !== 'function') throw new Error('Agent 不支持 followup 投递');
            fallback.followup(buildTaskMessage(task.content));
            detail = `目标会话未打开（${sessionId}），已转投到会话 ${String(fallback.session?.id ?? fallback.id)}`;
          } else {
            const sessions = ctx.sessions;
            const exists = sessions && typeof sessions.get === 'function' && !!sessions.get(sessionId);
            throw new Error(exists
              ? '会话已打开但 Agent 未就绪，请稍后重试'
              : `目标会话未打开（${sessionId}），且没有其他打开的会话可转投`);
          }
        } else {
          const sessions = ctx.sessions;
          const exists = sessions && typeof sessions.get === 'function' && !!sessions.get(sessionId);
          throw new Error(exists
            ? '会话已打开但 Agent 未就绪，请稍后重试'
            : `目标会话未打开（${sessionId}），无法投递消息`);
        }
      } else {
        if (typeof agent.followup !== 'function') throw new Error('Agent 不支持 followup 投递');
        agent.followup(buildTaskMessage(task.content));
        detail = `已向会话 ${sessionId} 投递消息并唤醒 Agent`;
      }
    } else {
      const output = await runCommand(String(task.content || ''), {
        timeoutMs: config.commandTimeoutMs,
        cwd: config.commandCwd,
      });
      detail = output.length > MAX_COMMAND_OUTPUT
        ? `${output.slice(0, MAX_COMMAND_OUTPUT)}…（输出已截断）`
        : output;
    }
  } catch (err) {
    status = 'error';
    detail = err && err.message ? err.message : String(err);
  }

  task.runCount = (task.runCount || 0) + 1;
  task.lastRunAt = startedAt;
  task.lastStatus = status;
  task.lastError = status === 'error' ? detail : null;
  task.history = Array.isArray(task.history) ? task.history : [];
  task.history.unshift({ at: startedAt, status, detail: detail.slice(0, MAX_HISTORY_DETAIL) });
  task.history = task.history.slice(0, HISTORY_LIMIT);
  // 一次性任务执行完毕自动停用；重复任务计算下一次（到达结束日期则停用）
  if (task.mode === 'once') {
    task.enabled = false;
    task.nextRunAt = null;
  } else {
    task.nextRunAt = computeNextRun(task, Date.now());
    if (task.nextRunAt === null) {
      // 已超出结束日期（或没有下一次），任务完成并停用
      task.enabled = false;
      task.completedAt = task.completedAt || Date.now();
    }
  }
  return { status, detail };
}

/** ---------- 调度器 ---------- */

export class TaskScheduler {
  constructor(ctx, store, config) {
    this.ctx = ctx;
    this.store = store;
    this.config = config;
    this.timer = null;
    this.running = false;
  }

  /**
   * 重启恢复：为每个启用任务重算 nextRunAt；过期的一次性任务记 missed 并停用，
   * 超出结束日期的重复任务标记完成并停用。
   * 重复任务若在"刚错过"窗口内（如系统睡眠导致定时器延迟触发、应用重启），
   * 立即补执行一次，避免提醒落空；超过窗口则跳过直接等下一次。
   */
  async restore() {
    const now = Date.now();
    const graceMs = Math.max(0, Number(this.config.missedGraceMinutes) || 0) * 60_000;
    const catchUp = [];
    for (const task of this.store.tasks) {
      if (!task.enabled) continue;
      const oldNext = task.nextRunAt;
      const next = computeNextRun(task, now);
      task.nextRunAt = next;
      if (next === null) {
        if (task.mode === 'once') {
          task.missed = (task.missed || 0) + 1;
          task.lastStatus = task.lastStatus || 'error';
          task.lastError = task.lastError || '应用重启前已过期，未执行';
          task.enabled = false;
          this.ctx.logger.warn?.(`dsh-scheduled-tasks: 一次性任务「${task.name}」已过期未执行，已停用`);
        } else if (task.endDate) {
          task.completedAt = task.completedAt || Date.now();
          task.enabled = false;
          this.ctx.logger.info?.(`dsh-scheduled-tasks: 任务「${task.name}」已超出结束日期，已停用`);
        }
        continue;
      }
      // 刚错过（旧 nextRunAt 落在 now - grace 到 now 之间）：补执行
      if (graceMs > 0 && oldNext != null && Number(oldNext) <= now && now - Number(oldNext) <= graceMs) {
        catchUp.push(task);
      }
    }
    // 补执行（复用 executeTask 的完整状态更新逻辑）
    for (const task of catchUp) {
      const scheduledFor = task.nextRunAt;
      try {
        const result = await executeTask(this.ctx, task, this.config);
        const note = `（错过原计划 ${fmtEpoch(scheduledFor)} 后补执行）`;
        task.history[0] = { ...task.history[0], detail: `${task.history[0]?.detail ?? ''}${note}`.slice(0, MAX_HISTORY_DETAIL) };
        task.lastError = result.status === 'error' ? `${result.detail}${note}`.slice(0, MAX_HISTORY_DETAIL) : null;
        this.ctx.logger.info?.(`dsh-scheduled-tasks: 任务「${task.name}」错过调度后补执行${result.status === 'ok' ? '成功' : '失败'}（原计划 ${fmtEpoch(scheduledFor)}）`);
      } catch (err) {
        this.ctx.logger.error?.(`dsh-scheduled-tasks: 任务「${task.name}」补执行异常：${err?.message ?? err}`);
      }
    }
    this.store.persist();
  }

  /** 重新安排下一次唤醒。 */
  schedule() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.disposed) return;
    const now = Date.now();
    let next = null;
    for (const task of this.store.tasks) {
      if (!task.enabled || task.nextRunAt == null) continue;
      const t = Number(task.nextRunAt);
      if (!Number.isFinite(t)) continue;
      if (next === null || t < next) next = t;
    }
    if (next === null) return;
    // setTimeout 有 24.8 天上限，超出则分片等待
    const delay = Math.min(Math.max(next - now, 0), MAX_TIMEOUT_MS);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.fire().catch((err) => {
        this.ctx.logger.error?.(`dsh-scheduled-tasks: 调度触发失败：${err?.message ?? err}`);
        this.schedule();
      });
    }, delay);
  }

  /** 到期触发：串行执行所有到期任务，随后重排。 */
  async fire() {
    if (this.running) return;
    this.running = true;
    try {
      const now = Date.now();
      const due = this.store.tasks.filter(
        (t) => t.enabled && t.nextRunAt != null && Number(t.nextRunAt) <= now,
      );
      for (const task of due) {
        const scheduledFor = task.nextRunAt;
        try {
          await executeTask(this.ctx, task, this.config);
          // 定时器延迟（如系统睡眠）导致执行晚于计划时，在历史中标注原因
          const delayMs = Date.now() - Number(scheduledFor);
          if (delayMs > 60_000 && task.history && task.history[0]) {
            const note = `（原计划 ${fmtEpoch(scheduledFor)}，实际延迟 ${Math.round(delayMs / 60000)} 分钟）`;
            task.history[0] = { ...task.history[0], detail: `${task.history[0].detail ?? ''}${note}`.slice(0, MAX_HISTORY_DETAIL) };
            if (task.lastError) task.lastError = `${task.lastError}${note}`.slice(0, MAX_HISTORY_DETAIL);
          }
          this.ctx.logger.info?.(
            `dsh-scheduled-tasks: 任务「${task.name}」执行${task.lastStatus === 'ok' ? '成功' : '失败'}`,
          );
        } catch (err) {
          this.ctx.logger.error?.(`dsh-scheduled-tasks: 任务「${task.name}」执行异常：${err?.message ?? err}`);
        }
      }
      if (due.length > 0) this.store.persist();
    } finally {
      this.running = false;
      this.schedule();
    }
  }

  /** 立即执行指定任务（不影响其调度状态；once 任务执行后仍会停用）。 */
  async runNow(id) {
    const task = this.store.get(String(id));
    if (!task) throw new Error('任务不存在');
    if (task.enabled === false && task.mode !== 'once') {
      // 暂停中的任务也可手动触发一次（不改 enabled）
    }
    const result = await executeTask(this.ctx, task, this.config);
    this.store.persist();
    this.schedule();
    return result;
  }

  dispose() {
    this.disposed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

/** 创建新任务 id。 */
export function newTaskId() {
  return randomUUID();
}

/** 时间戳 → 本地可读字符串（用于日志/补执行备注）。 */
function fmtEpoch(ts) {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return String(ts);
  }
}
