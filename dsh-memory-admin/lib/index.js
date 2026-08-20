/**
 * dsh-memory-admin —— DSH 记忆管理插件（自包含记忆模块）
 *
 * 为 DeepSeek Harness 提供：
 * 1. 记忆库管理工具（memory_list / view / search / add / edit / delete / stats / loaded），
 *    Agent 可以直接修改记忆内容——你只需在对话里说"把记忆 #12 改成…"。
 * 2. 对话记忆可见性：每轮对话自动召回相关记忆并注入上下文，
 *    对话界面中直接显示"本次对话加载了哪些记忆模块"。
 *
 * 零外部依赖：存储使用 Node 内置 node:sqlite，无需 Python / 无需 npm 包。
 *
 * 用法（profile 的 cordis.patch.yml）：
 * ```yaml
 * - insert:
 *     - id: dsh-memory-admin
 *       name: 'dsh-memory-admin'
 *       config:
 *         dbPath: 'C:/Users/<你>/.dsh/profiles/desktop/data/memory-admin.db'
 * ```
 */
import z from '@deepseek-ai/schemastery';
import { MemoryStore } from './store.js';
import { registerMemoryTools } from './tools.js';
import { installMemoryHooks } from './visibility.js';
import { installMemoryApi } from './api.js';

export const name = 'dsh-memory-admin';
/** 依赖的工具注册服务。 */
export const inject = ['tools'];

export const Config = z.object({
  /** 记忆库 SQLite 文件路径（相对路径基于运行时工作目录，建议写绝对路径）。 */
  dbPath: z.string().default('data/memory-admin.db'),
  /** 是否自动把真实用户消息沉淀进记忆库。 */
  autoRemember: z.boolean().default(true),
  /** 自动记忆的重要度（0~1）。 */
  autoRememberImportance: z.number().default(0.6),
  /** 是否也自动记忆子代理会话的提示词（默认否，避免污染记忆库）。 */
  autoRememberSubagent: z.boolean().default(false),
  /** 是否启用"对话开始加载记忆"（每个会话首次用户消息时注入全局+工作区记忆）。 */
  recallEnabled: z.boolean().default(true),
  /** 保留兼容：自动注入现在按重要度加载全部全局+工作区记忆，不再按条数截断。 */
  recallTopK: z.number().default(5),
  /** 保留兼容：自动注入不再做相关度筛选（全局/工作区记忆是常驻偏好，全部加载）。 */
  recallMinScore: z.number().default(0.4),
  /** 是否把加载的记忆注入对话上下文（关闭则只记录不注入）。 */
  injectContext: z.boolean().default(true),
  /** 是否注册可视化页面 API（设置页"记忆管理"section 依赖它）。 */
  webApi: z.boolean().default(true),
});

export async function apply(ctx, config) {
  ctx.logger.info(
    `dsh-memory-admin: 记忆管理插件激活（dbPath=${config.dbPath}，自动记忆=${config.autoRemember}，对话召回=${config.recallEnabled}，可视化=${config.webApi}）`,
  );
  const store = new MemoryStore(config.dbPath);
  const disposers = [];
  try {
    disposers.push(registerMemoryTools(ctx, store));
    installMemoryHooks(ctx, store, config);
    if (config.webApi) {
      // 可选注入 webServer：它可能在插件激活时尚未就绪（此前日志出现
      // “webServer 不可用，可视化页面 API 未注册”），也可能在纯 TUI
      // 环境里根本不存在。用 ctx.inject 在服务就绪时再注册 API，
      // 既不阻塞工具注册，也不影响无 web 环境的加载。
      ctx.inject(['webServer'], (httpCtx) => {
        httpCtx.effect(() => {
          const routes = installMemoryApi(httpCtx, store);
          return () => {
            for (const dispose of routes) dispose();
          };
        }, 'dsh-memory-admin: web api');
      });
    }
  } catch (err) {
    store.close();
    throw err;
  }
  ctx.effect(() => {
    return () => {
      for (const dispose of disposers) dispose();
      store.close();
      ctx.logger.info('dsh-memory-admin: 已卸载（工具已注销，记忆库已关闭）');
    };
  }, 'dsh-memory-admin');
}
