/**
 * dsh-scheduled-tasks —— Agent 定时任务工具集
 *
 * 通过 ctx.tools.register 注册，Agent 可直接调用（对话里让 Agent 帮你
 * 设置定时任务）：
 *   task_create   创建定时任务（一次性/每天/每周/间隔，可选起止日期）
 *   task_list     列出全部任务
 *   task_delete   删除任务
 *   task_toggle   启用/暂停任务
 *   task_run_now  立即执行一次任务
 *
 * 注意：defineTool 的 parameters 根节点是"属性映射"（{参数名: 值规格}），
 * 不能包 { type:'object', properties }。
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { computeNextRun, isValidTimeZone, parseAtInput, parseClock } from './scheduler.js';
import { validateTaskInput } from './api.js';

const MODE_LABELS = {
  once: '一次性',
  daily: '每天',
  weekly: '每周',
  interval: '间隔',
};
const ACTION_LABELS = {
  session: '发消息到会话',
  command: '执行命令',
};
const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function textBlock(text) {
  return [{ type: 'text', text }];
}

/** 服务器本地时区（DSH Desktop 进程时区，通常与用户一致）。 */
function localTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** 任务 → 人类可读摘要（供工具输出展示）。 */
function fmtTask(t) {
  const lines = [`【${t.name}】(${MODE_LABELS[t.mode] ?? t.mode} · ${ACTION_LABELS[t.action] ?? t.action} · ${t.enabled ? '启用' : t.completedAt ? '已结束' : '已暂停'} · id=${t.id})`];
  if (t.mode === 'once') lines.push(`  执行时间：${fmtLocal(t.at)}`);
  else if (t.mode === 'daily') lines.push(`  每天 ${t.time}`);
  else if (t.mode === 'weekly') {
    lines.push(`  每周 ${(t.weekdays || []).map((d) => WEEKDAY_LABELS[d]).join('、')} ${t.time}`);
  } else {
    lines.push(`  每 ${t.intervalMinutes} 分钟`);
  }
  if (t.startDate || t.endDate) {
    lines.push(`  有效期：${t.startDate ?? '不限'} ~ ${t.endDate ?? '长期'}`);
  }
  if (t.action === 'session') {
    lines.push(`  目标会话：${t.sessionId ?? '（未指定）'}`);
  }
  lines.push(`  内容：${String(t.content).slice(0, 120)}${String(t.content).length > 120 ? '…' : ''}`);
  if (t.nextRunAt) lines.push(`  下次执行：${fmtLocal(t.nextRunAt)}`);
  if (t.lastRunAt) lines.push(`  上次执行：${fmtLocal(t.lastRunAt)}（${t.lastStatus === 'ok' ? '成功' : t.lastStatus === 'error' ? '失败' : '未知'}）· 已执行 ${t.runCount || 0} 次`);
  return lines.join('\n');
}

function fmtLocal(ts) {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return '—';
  }
}

/** 注册全部定时任务工具；返回取消注册函数。 */
export function registerTaskTools(ctx, store, scheduler) {
  const disposers = [];
  const register = (tool) => {
    disposers.push(ctx.tools.register(tool));
  };

  register(
    defineTool({
      name: 'task_create',
      description:
        '创建定时任务。四种模式：\n' +
        '- once 一次性：at 指定执行时刻。可传带时区偏移的 ISO 8601（如 "2026-08-21T09:00:00+08:00" 或带 Z 的 UTC 时间）；也可传不带偏移的本地时间（如 "2026-08-21T09:00"），此时按 timeZone 参数解释（默认服务器本地时区）。\n' +
        '- daily 每天：time 传 "HH:mm"（如 "09:00"）。\n' +
        '- weekly 每周：weekdays 传星期数字数组（0=周日，1=周一 … 6=周六）+ time "HH:mm"。\n' +
        '- interval 间隔：intervalMinutes 传间隔分钟数（1~10080）。\n' +
        '可选 startDate/endDate（"YYYY-MM-DD"）限定执行区间（含当天），到达结束日期后任务自动停用。\n' +
        'action 为 session 时，到点向 sessionId 指定的会话投递 content 消息并唤醒 Agent（sessionId 不填默认当前会话）；action 为 command 时，到点通过系统 shell 执行 content 命令。\n' +
        '用户用自然语言描述时间时，请先换算成具体时间值再调用；换算时优先使用用户明确给出的日期/时刻，时区默认与服务器本地一致，可用 timeZone 参数指定（IANA 名称，如 "Asia/Shanghai"）。',
      parameters: {
        name: { type: 'string', required: true, description: '任务名称（简短，如"早上提醒写日报"）' },
        mode: { type: 'string', required: true, description: '执行模式：once/daily/weekly/interval' },
        at: { type: 'string', description: 'once 模式的执行时间（ISO 8601；带偏移或用 timeZone 解释的本地时间）' },
        time: { type: 'string', description: 'daily/weekly 模式的时刻 "HH:mm"' },
        weekdays: { type: 'array', items: { type: 'integer' }, description: 'weekly 模式的星期数组（0=周日…6=周六）' },
        intervalMinutes: { type: 'integer', description: 'interval 模式的间隔分钟数（1~10080）' },
        startDate: { type: 'string', description: '可选，开始日期 "YYYY-MM-DD"（含当天）' },
        endDate: { type: 'string', description: '可选，结束日期 "YYYY-MM-DD"（含当天，到达后自动停用）' },
        timeZone: { type: 'string', description: '可选，IANA 时区名（默认服务器本地时区），用于解释无偏移的时间' },
        action: { type: 'string', required: true, description: '动作：session（发消息到会话）/command（执行命令）' },
        sessionId: { type: 'string', description: 'session 动作的目标会话 id（不填默认当前会话）' },
        content: { type: 'string', required: true, description: '消息内容或要执行的命令' },
      },
      output: {
        schema: { type: 'json' },
        render(_args, value) {
          if (!value.ok) return textBlock(`创建失败：${value.error}`);
          return textBlock(`定时任务已创建：\n\n${fmtTask(value.task)}`);
        },
      },
      isConcurrencySafe: () => true,
      execute(args, exec) {
        const mode = String(args.mode ?? '');
        const input = {
          name: args.name,
          mode,
          timeZone: isValidTimeZone(args.timeZone) ? args.timeZone : localTimeZone(),
          action: String(args.action ?? ''),
          content: args.content,
          enabled: true,
          startDate: args.startDate ?? null,
          endDate: args.endDate ?? null,
        };
        if (mode === 'once') {
          input.at = parseAtInput(args.at, input.timeZone);
        } else if (mode === 'daily' || mode === 'weekly') {
          input.time = String(args.time ?? '').trim();
          if (!parseClock(input.time)) throw new Error('请提供有效的时刻 time（"HH:mm"）');
          if (mode === 'weekly') {
            input.weekdays = Array.isArray(args.weekdays) ? args.weekdays : [];
          }
        } else if (mode === 'interval') {
          input.intervalMinutes = args.intervalMinutes;
        } else {
          throw new Error('mode 必须是 once/daily/weekly/interval 之一');
        }
        if (input.action === 'session') {
          // 未指定会话时默认当前会话
          input.sessionId = args.sessionId ?? exec.agent?.session?.id ?? undefined;
        } else if (input.action !== 'command') {
          throw new Error('action 必须是 session/command 之一');
        }
        const task = validateTaskInput(input);
        store.upsert(task);
        scheduler.schedule();
        return { ok: true, task };
      },
    }),
  );

  register(
    defineTool({
      name: 'task_list',
      description: '列出全部定时任务（含启用状态、调度时间、下次执行时间、执行次数）。',
      parameters: {
        includeDisabled: { type: 'boolean', description: '是否包含已暂停/已结束的任务，默认 true' },
      },
      output: {
        schema: { type: 'json' },
        render(_args, value) {
          if (!value.tasks || value.tasks.length === 0) return textBlock('（当前没有任何定时任务）');
          return textBlock(`共 ${value.tasks.length} 个定时任务：\n\n` + value.tasks.map((t) => fmtTask(t)).join('\n\n'));
        },
      },
      isConcurrencySafe: () => true,
      execute(args) {
        const tasks = store.tasks.filter((t) => args.includeDisabled === false ? t.enabled : true);
        return { count: tasks.length, tasks };
      },
    }),
  );

  register(
    defineTool({
      name: 'task_delete',
      description: '删除一个定时任务（不可恢复）。',
      parameters: {
        id: { type: 'string', required: true, description: '任务 id' },
      },
      output: {
        schema: { type: 'json' },
        render(_args, value) {
          return textBlock(value.deleted ? `已删除任务 ${value.id}` : `（未找到任务 ${value.id}）`);
        },
      },
      isConcurrencySafe: () => true,
      execute(args) {
        const id = String(args.id ?? '');
        const deleted = store.remove(id);
        if (deleted) scheduler.schedule();
        return { deleted, id };
      },
    }),
  );

  register(
    defineTool({
      name: 'task_toggle',
      description: '启用或暂停一个定时任务。',
      parameters: {
        id: { type: 'string', required: true, description: '任务 id' },
        enabled: { type: 'boolean', description: '目标状态；不传则取反' },
      },
      output: {
        schema: { type: 'json' },
        render(_args, value) {
          if (!value.task) return textBlock('（未找到任务）');
          return textBlock(`任务「${value.task.name}」已${value.task.enabled ? '启用' : '暂停'}：\n\n${fmtTask(value.task)}`);
        },
      },
      isConcurrencySafe: () => true,
      execute(args) {
        const id = String(args.id ?? '');
        const task = store.get(id);
        if (!task) return { found: false, task: null };
        task.enabled = args.enabled !== undefined ? args.enabled === true : !task.enabled;
        task.updatedAt = Date.now();
        if (task.enabled) task.completedAt = null;
        task.nextRunAt = task.enabled ? computeNextRun(task, Date.now()) : null;
        store.persist();
        scheduler.schedule();
        return { found: true, task };
      },
    }),
  );

  register(
    defineTool({
      name: 'task_run_now',
      description: '立即执行一次定时任务（不影响其调度；一次性任务执行后仍会停用）。',
      parameters: {
        id: { type: 'string', required: true, description: '任务 id' },
      },
      output: {
        schema: { type: 'json' },
        render(_args, value) {
          if (!value.ok) return textBlock(`执行失败：${value.error}`);
          return textBlock(`立即执行完成（${value.status === 'ok' ? '成功' : '失败'}）` + (value.detail ? `\n${String(value.detail).slice(0, 300)}` : ''));
        },
      },
      isConcurrencySafe: () => true,
      execute(args) {
        return scheduler.runNow(String(args.id ?? '')).then(
          (result) => ({ ok: true, ...result }),
          (err) => ({ ok: false, error: err && err.message ? err.message : String(err) }),
        );
      },
    }),
  );

  ctx.logger.info?.('dsh-scheduled-tasks: Agent 工具已注册（task_create / task_list / task_delete / task_toggle / task_run_now）');
  return () => {
    for (const dispose of disposers) dispose();
  };
}
