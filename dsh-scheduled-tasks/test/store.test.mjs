/**
 * 存储 + 执行冒烟测试（不依赖 DSH 环境）：
 *  - TaskStore 持久化/读取/损坏恢复
 *  - 命令动作执行（runCommand 路径，通过 executeTask 的 command 分支）
 *  - 一次性任务执行后停用
 * 运行：node test/store.test.mjs
 */
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore, computeNextRun, executeTask } from '../lib/scheduler.js';

let failed = 0;
function check(name, cond, extra = '') {
  if (!cond) failed++;
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' ' + extra : ''}`);
}

const dir = mkdtempSync(join(tmpdir(), 'dsh-tasks-test-'));
const file = join(dir, 'tasks.json');

// 1. 空存储
const store1 = new TaskStore(file, console);
check('empty store', store1.tasks.length === 0);

// 2. 写入 + 重读
const task = {
  id: 't1',
  name: '测试命令任务',
  enabled: true,
  mode: 'interval',
  intervalMinutes: 5,
  timeZone: 'Asia/Shanghai',
  action: 'command',
  content: process.platform === 'win32' ? 'echo hello-task' : 'echo hello-task',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  runCount: 0,
  history: [],
  nextRunAt: null,
};
store1.upsert(task);
const store2 = new TaskStore(file, console);
check('persist/reload', store2.get('t1') !== null && store2.get('t1').name === '测试命令任务');

// 3. 损坏文件恢复
const corrupt = join(dir, 'corrupt.json');
const { writeFileSync } = await import('node:fs');
writeFileSync(corrupt, '{broken json', 'utf8');
const store3 = new TaskStore(corrupt, console);
check('corrupt file recovery', Array.isArray(store3.tasks) && store3.tasks.length === 0);
check('corrupt file backed up', !existsSync(corrupt));

// 4. 命令动作执行（executeTask 的 command 分支）
const fakeCtx = {
  logger: console,
  agents: { get: () => null },
  sessions: { get: () => null },
};
const cmdTask = {
  ...task,
  id: 't2',
  mode: 'interval',
  intervalMinutes: 5,
  content: process.platform === 'win32' ? 'echo hello-task' : 'echo hello-task',
  runCount: 0,
  history: [],
  createdAt: Date.now(),
};
const result = await executeTask(fakeCtx, cmdTask, { commandTimeoutMs: 15000, commandCwd: '' });
check('command ok', result.status === 'ok', `detail=${JSON.stringify(result.detail)}`);
check('command output captured', String(result.detail).includes('hello-task'));
check('runCount incremented', cmdTask.runCount === 1);
check('lastRunAt set', typeof cmdTask.lastRunAt === 'number');
check('history recorded', cmdTask.history.length === 1 && cmdTask.history[0].status === 'ok');

// 5. 命令失败
const badTask = {
  ...task,
  id: 't3',
  content: process.platform === 'win32' ? 'echo boom & exit 3' : 'echo boom; exit 3',
  runCount: 0,
  history: [],
  createdAt: Date.now(),
};
const badResult = await executeTask(fakeCtx, badTask, { commandTimeoutMs: 15000, commandCwd: '' });
check('command nonzero exit', badResult.status === 'ok', '（有输出时视为已执行）');
check('command output kept', String(badResult.detail).includes('boom'));

// 6. 一次性任务执行后停用
const onceTask = {
  ...task,
  id: 't4',
  mode: 'once',
  at: new Date(Date.now() + 60000).toISOString(),
  runCount: 0,
  history: [],
  createdAt: Date.now(),
};
const next = computeNextRun(onceTask);
check('once nextRunAt computed', typeof next === 'number' && next > Date.now());
await executeTask(fakeCtx, onceTask, { commandTimeoutMs: 15000, commandCwd: '' });
check('once disabled after run', onceTask.enabled === false);
check('once nextRunAt null after run', onceTask.nextRunAt === null);

// 7. restore 补执行：刚错过（5 分钟内）的重复任务自动补执行
const { TaskScheduler } = await import('../lib/scheduler.js');
const dir2 = mkdtempSync(join(tmpdir(), 'dsh-tasks-restore-'));
const makeMissed = (id, nextRunAt) => ({
  id,
  name: '错过补执行',
  enabled: true,
  mode: 'daily',
  time: '09:00',
  timeZone: 'Asia/Shanghai',
  action: 'command',
  content: 'echo catchup-ok',
  createdAt: Date.now() - 86400000,
  updatedAt: Date.now(),
  runCount: 0,
  history: [],
  nextRunAt,
});
const store4 = new TaskStore(join(dir2, 'tasks.json'), console);
const sched2 = new TaskScheduler(fakeCtx, store4, {
  commandTimeoutMs: 15000,
  commandCwd: '',
  missedGraceMinutes: 30,
});
store4.upsert(makeMissed('m1', Date.now() - 5 * 60000)); // 5 分钟前应执行（刚错过）
await sched2.restore();
const m1 = store4.get('m1');
check('catchup executed', m1.runCount === 1);
check('catchup ok', m1.lastStatus === 'ok');
check('catchup note', String(m1.history[0].detail).includes('补执行'));
check('catchup next future', m1.nextRunAt !== null && m1.nextRunAt > Date.now());

// 8. restore 不补执行：错过超过窗口（120 分钟）→ 直接跳到下一次
const store5 = new TaskStore(join(dir2, 'tasks2.json'), console);
const sched3 = new TaskScheduler(fakeCtx, store5, {
  commandTimeoutMs: 15000,
  commandCwd: '',
  missedGraceMinutes: 30,
});
store5.upsert(makeMissed('m2', Date.now() - 120 * 60000));
await sched3.restore();
const m2 = store5.get('m2');
check('stale skip no run', m2.runCount === 0);
check('stale next future', m2.nextRunAt !== null && m2.nextRunAt > Date.now());

// 9. restore 不补执行：missedGraceMinutes = 0 时关闭
const store6 = new TaskStore(join(dir2, 'tasks3.json'), console);
const sched4 = new TaskScheduler(fakeCtx, store6, {
  commandTimeoutMs: 15000,
  commandCwd: '',
  missedGraceMinutes: 0,
});
store6.upsert(makeMissed('m3', Date.now() - 5 * 60000));
await sched4.restore();
check('grace off no run', store6.get('m3').runCount === 0);

sched2.dispose();
sched3.dispose();
sched4.dispose();
rmSync(dir, { recursive: true, force: true });
rmSync(dir2, { recursive: true, force: true });
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
