/**
 * API 集成冒烟测试：用 fake webServer 验证路由注册与 CRUD 主流程。
 * 运行：node test/api.test.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore, TaskScheduler } from '../lib/scheduler.js';
import { installTasksApi, validateTaskInput } from '../lib/api.js';

let failed = 0;
function check(name, cond, extra = '') {
  if (!cond) failed++;
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' ' + extra : ''}`);
}

const dir = mkdtempSync(join(tmpdir(), 'dsh-tasks-api-'));
const file = join(dir, 'tasks.json');

// fake webServer：捕获注册的路由
const routes = new Map();
const fakeWebServer = {
  register(route) {
    if (routes.has(route.path)) throw new Error('duplicate route ' + route.path);
    routes.set(route.path, route.handler);
    return () => routes.delete(route.path);
  },
};

const ctx = {
  logger: console,
  agents: { get: () => null },
  sessions: { get: () => null },
  webServer: fakeWebServer,
};

const store = new TaskStore(file, console);
const scheduler = new TaskScheduler(ctx, store, { commandTimeoutMs: 15000, commandCwd: '' });
const disposers = installTasksApi(ctx, store, scheduler);
check('routes registered', routes.size === 5, String(routes.size));

// 模拟 HTTP 请求
function call(path, body) {
  return new Promise((resolve) => {
    const handler = routes.get(path);
    check(`route exists ${path}`, typeof handler === 'function');
    const req = {
      url: path,
      on(ev, cb) {
        if (ev === 'data' && body !== undefined) cb(Buffer.from(JSON.stringify(body)));
        if (ev === 'end') cb();
        if (ev === 'error') cb();
      },
      destroy() {},
    };
    let resData = '';
    const res = {
      writeHead(status, headers) {
        resData += `STATUS:${status} `;
      },
      end(payload) {
        resolve({ statusText: resData, payload: payload ? JSON.parse(payload) : null });
      },
    };
    handler(req, res);
  });
}

// 校验函数
const valid = validateTaskInput({
  name: '测试',
  mode: 'once',
  at: new Date(Date.now() + 3600000).toISOString(),
  timeZone: 'Asia/Shanghai',
  action: 'session',
  sessionId: 'sess-1',
  content: '你好',
});
check('validate ok', valid.id && valid.name === '测试' && valid.nextRunAt > Date.now());

// 起止日期校验
const ranged = validateTaskInput({
  name: '范围任务',
  mode: 'daily',
  time: '09:00',
  timeZone: 'Asia/Shanghai',
  action: 'command',
  content: 'echo hi',
  startDate: '2026-09-01',
  endDate: '2026-12-31',
});
check('validate range ok', ranged.startDate === '2026-09-01' && ranged.endDate === '2026-12-31' && ranged.nextRunAt !== null);

const rejects = (fn) => { try { fn(); return false; } catch { return true; } };
check('validate rejects fake date', rejects(() => validateTaskInput({ name: 'x', mode: 'daily', time: '09:00', timeZone: 'UTC', action: 'command', content: 'x', startDate: '2026-02-30' })));
check('validate rejects end before start', rejects(() => validateTaskInput({ name: 'x', mode: 'daily', time: '09:00', timeZone: 'UTC', action: 'command', content: 'x', startDate: '2026-12-31', endDate: '2026-01-01' })));
check('validate rejects bad date format', rejects(() => validateTaskInput({ name: 'x', mode: 'daily', time: '09:00', timeZone: 'UTC', action: 'command', content: 'x', endDate: '2026/12/31' })));

let threw = false;
try {
  validateTaskInput({ name: '', mode: 'once', at: 'x', timeZone: 'UTC', action: 'session', sessionId: 'a', content: 'x' });
} catch { threw = true; }
check('validate rejects bad input', threw);

threw = false;
try {
  validateTaskInput({ name: 'x', mode: 'weekly', time: '9:00', weekdays: [], timeZone: 'UTC', action: 'command', content: 'x' });
} catch { threw = true; }
check('validate rejects empty weekdays', threw);

threw = false;
try {
  validateTaskInput({ name: 'x', mode: 'daily', time: '25:99', timeZone: 'UTC', action: 'command', content: 'x' });
} catch { threw = true; }
check('validate rejects bad clock', threw);

threw = false;
try {
  validateTaskInput({ name: 'x', mode: 'daily', time: '09:00', timeZone: 'Mars/Olympus', action: 'command', content: 'x' });
} catch { threw = true; }
check('validate rejects bad tz', threw);

threw = false;
try {
  validateTaskInput({ name: 'x', mode: 'once', at: new Date(Date.now() - 3600000).toISOString(), timeZone: 'UTC', action: 'session', sessionId: 'a', content: 'x' });
} catch { threw = true; }
check('validate rejects past once time', threw);

threw = false;
try {
  validateTaskInput({ name: 'x', mode: 'once', at: new Date().toISOString(), timeZone: 'UTC', action: 'session', content: 'x' });
} catch { threw = true; }
check('validate rejects session without id', threw);

// save → list → toggle → run-now(命令) → delete 主流程
const saved = await call('/scheduled-tasks/api/save', {
  task: {
    name: '命令任务',
    mode: 'interval',
    intervalMinutes: 5,
    timeZone: 'Asia/Shanghai',
    action: 'command',
    content: process.platform === 'win32' ? 'echo api-test-ok' : 'echo api-test-ok',
  },
});
check('save ok', saved.payload && saved.payload.ok === true, JSON.stringify(saved.payload));
const taskId = saved.payload.task.id;

const listed = await call('/scheduled-tasks/api/list');
check('list has task', listed.payload.ok && listed.payload.tasks.length === 1);
check('nextRunAt computed', typeof listed.payload.tasks[0].nextRunAt === 'number');

const toggled = await call('/scheduled-tasks/api/toggle', { id: taskId, enabled: false });
check('toggle off', toggled.payload.ok && toggled.payload.task.enabled === false);
check('toggle clears nextRunAt', toggled.payload.task.nextRunAt === null);

const toggled2 = await call('/scheduled-tasks/api/toggle', { id: taskId, enabled: true });
check('toggle on recomputes', toggled2.payload.ok && toggled2.payload.task.nextRunAt !== null);

const runNow = await call('/scheduled-tasks/api/run-now', { id: taskId });
check('run-now ok', runNow.payload.ok === true && runNow.payload.status === 'ok', JSON.stringify(runNow.payload));

const rerun = await call('/scheduled-tasks/api/run-now', { id: 'nope' });
check('run-now missing id fails', rerun.payload.ok === false);

const del = await call('/scheduled-tasks/api/delete', { id: taskId });
check('delete ok', del.payload.ok === true);

const listed2 = await call('/scheduled-tasks/api/list');
check('list empty after delete', listed2.payload.tasks.length === 0);

// 清理
for (const dispose of disposers) dispose();
scheduler.dispose();
rmSync(dir, { recursive: true, force: true });
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
