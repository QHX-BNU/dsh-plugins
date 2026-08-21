/**
 * dsh-scheduled-tasks —— DSH 定时任务插件（服务端入口）
 *
 * 为 DeepSeek Harness 提供定时任务能力：
 * - 侧边栏"定时任务"入口（Web 客户端 bundle 见 lib/client.js）与
 *   Agent 对话工具（lib/tools.js，可直接让 Agent 设置任务）；
 * - 任务可设置执行时间（一次性 / 每天 / 每周 / 间隔，支持起止日期）与内容；
 * - 到点自动执行：向指定会话投递消息并唤醒 Agent，或执行 shell 命令；
 * - 任务持久化到 JSON 文件，应用重启后自动恢复调度（过期的一次性任务
 *   会标记为未执行并停用）。
 *
 * 用法（profile 的 cordis.patch.yml）：
 * ```yaml
 * - insert:
 *     - id: dsh-scheduled-tasks
 *       name: 'dsh-scheduled-tasks'
 *       config:
 *         tasksPath: 'C:/Users/<你>/.dsh/profiles/desktop/data/scheduled-tasks.json'
 * ```
 */
import z from '@deepseek-ai/schemastery';
import { TaskStore, TaskScheduler } from './scheduler.js';
import { installTasksApi } from './api.js';
import { registerTaskTools } from './tools.js';

export const name = 'dsh-scheduled-tasks';

/** 声明必须的核心服务依赖（scheduler 执行任务时需要访问 agents / sessions，
 *  工具注册需要 tools）。webServer 可能晚就绪/不存在，单独用 ctx.inject 延迟。 */
export const inject = ['agents', 'sessions', 'tools'];

export const Config = z.object({
  /** 任务存储 JSON 文件路径（相对路径基于运行时工作目录，建议写绝对路径）。 */
  tasksPath: z.string().default('data/scheduled-tasks.json'),
  /** 命令动作的超时时间（毫秒）。 */
  commandTimeoutMs: z.number().default(120000),
  /** 命令动作的工作目录（留空 = 进程工作目录）。 */
  commandCwd: z.string().default(''),
  /** 是否注册可视化页面 API（侧边栏"定时任务"面板依赖它）。 */
  webApi: z.boolean().default(true),
  /** 是否注册 Agent 对话工具（task_create 等）。 */
  agentTools: z.boolean().default(true),
  /** 发消息动作的目标会话未打开时，是否自动转投到当前打开的根会话（避免提醒落空）。 */
  fallbackToOpenSession: z.boolean().default(true),
  /** "刚错过"补执行窗口（分钟）：应用重启/系统唤醒后，重复任务若在窗口内
   *  错过调度（如系统睡眠导致定时器延迟触发），自动补执行一次；超过窗口
   *  则跳过，直接等下一次。0 表示不补执行。 */
  missedGraceMinutes: z.number().default(30),
});

export async function apply(ctx, config) {
  ctx.logger.info(
    `dsh-scheduled-tasks: 定时任务插件激活（tasksPath=${config.tasksPath}，Agent 工具=${config.agentTools}）`,
  );
  const store = new TaskStore(config.tasksPath, ctx.logger);
  const scheduler = new TaskScheduler(ctx, store, config);
  const disposers = [];
  try {
    // 恢复调度（重启后过期的一次性任务在此停用并记录；刚错过的重复任务补执行）
    await scheduler.restore();
    if (config.agentTools) {
      // agents/sessions/tools 已在静态 inject 中声明，apply 时必然可用
      disposers.push(registerTaskTools(ctx, store, scheduler));
    }
    if (config.webApi) {
      ctx.inject(['webServer'], (httpCtx) => {
        httpCtx.effect(() => {
          const routes = installTasksApi(httpCtx, store, scheduler);
          return () => {
            for (const dispose of routes) dispose();
          };
        }, 'dsh-scheduled-tasks: web api');
      });
    }
    scheduler.schedule();
  } catch (err) {
    scheduler.dispose();
    throw err;
  }
  ctx.effect(() => {
    return () => {
      scheduler.dispose();
      for (const dispose of disposers) dispose();
      ctx.logger.info('dsh-scheduled-tasks: 已卸载（定时器已清除）');
    };
  }, 'dsh-scheduled-tasks');
}
