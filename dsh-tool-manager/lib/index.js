/**
 * dsh-tool-manager —— DSH 工具管理器（服务端入口）
 *
 * 为 DeepSeek Harness 提供「工具」的集中管理能力：
 * - 显示已有工具：面板/API 列出全部已注册工具（名称、描述、参数、
 *   来源：系统/自定义、禁用状态）；
 * - 制作对应工具：在面板中定义工具名/描述/参数 schema/执行代码，
 *   保存后注册为真实 DSH 工具，主 Agent 与模型立即可调用；
 * - 禁用/删除/添加：任意工具可全局禁用（模型不再看到、调用报未知工具）
 *   或重新启用；自定义工具可删除（彻底移除）；系统工具只能禁用；
 * - 主 Agent 侧提供 toolmgr_list / toolmgr_create / toolmgr_edit /
 *   toolmgr_delete / toolmgr_toggle 五个工具，Agent 也能自行管理；
 * - 侧边栏「工具管理」面板（Web 客户端 bundle 见 lib/client.js）。
 *
 * 用法（profile 的 cordis.patch.yml）：
 * ```yaml
 * - insert:
 *     - id: dsh-tool-manager
 *       name: 'dsh-tool-manager'
 *       config:
 *         statePath: 'C:/Users/<你>/.dsh/profiles/desktop/data/tool-manager.json'
 *         tools: true
 *         promptSection: true
 *         webApi: true
 * ```
 */
import z from '@deepseek-ai/schemastery';
import { defaultStatePath, ToolManagerStore } from './store.js';
import { installManagerTools } from './tools.js';
import { ToolRegistryManager, MANAGER_TOOL_NAMES } from './registry.js';
import { installToolManagerApi } from './api.js';
import { DEFAULT_RUN_TIMEOUT_MS } from './runtime.js';

export const name = 'dsh-tool-manager';

export const inject = ['tools', 'systemPrompt'];

export const Config = z.object({
  /** 状态存储 JSON 路径（默认 <home>/.dsh/tool-manager/state.json）。 */
  statePath: z.string().default(''),
  /** 自定义工具单次执行超时（毫秒）。默认 30 秒。 */
  runTimeoutMs: z.number().min(1000).max(10 * 60 * 1000).default(DEFAULT_RUN_TIMEOUT_MS),
  /** 是否注册 toolmgr_list/create/edit/delete/toggle 五个管理工具。 */
  tools: z.boolean().default(true),
  /** 是否注册系统提示片段（让主 Agent 知道工具可被管理）。 */
  promptSection: z.boolean().default(true),
  /** 是否注册可视化页面 API（侧边栏「工具管理」面板依赖它）。 */
  webApi: z.boolean().default(true),
});

export async function apply(ctx, config) {
  const statePath = config.statePath && config.statePath.trim() !== ''
    ? config.statePath.trim()
    : defaultStatePath();
  const store = new ToolManagerStore(statePath);
  await store.load();
  const registry = new ToolRegistryManager(ctx, store, {
    runTimeoutMs: config.runTimeoutMs,
    logger: ctx.logger,
  });
  ctx.logger.info(`dsh-tool-manager: 插件激活（statePath=${statePath}，${store.listCustom().length} 个自定义工具，${store.data.disabled.length} 个禁用工具）`);

  const disposers = [];
  try {
    if (config.tools) {
      for (const dispose of installManagerTools(ctx, registry, store)) disposers.push(dispose);
    }

    if (config.promptSection) {
      ctx.systemPrompt.section({
        name: 'tool-manager',
        order: 116.6,
        text: () => {
          const tools = registry.listAll();
          const custom = tools.filter((t) => t.source === 'custom' && t.registered);
          const lines = [
            '工具管理（dsh-tool-manager）：可用 toolmgr_list 查看全部工具、toolmgr_create 制作新工具（定义参数与执行代码，立即生效）、toolmgr_edit 修改、toolmgr_delete 删除、toolmgr_toggle 禁用/启用任意工具。禁用后该工具从所有 agent 的可见列表消失。toolmgr_* 本身受保护不可禁用。',
          ];
          if (custom.length > 0) {
            lines.push('当前自定义工具：');
            for (const t of custom.slice(0, 20)) {
              lines.push(`- ${t.name}${t.description ? '：' + t.description : ''}`);
            }
          }
          return lines.join('\n');
        },
      });
    }

    // 注册已启用的自定义工具 + 恢复禁用名单（对现有 agent 生效，
    // 新创建的 agent 由 agent/created 监听自动补齐）
    for (const tool of store.listCustom()) {
      if (!tool.enabled) continue;
      try {
        registry.registerCustom(tool);
      } catch (err) {
        ctx.logger.warn?.(`dsh-tool-manager: 注册自定义工具「${tool.id}」失败：${err && err.message ? err.message : err}`);
      }
    }
    registry.watchAgents();
    registry.applyStoredDisabled();

    if (config.webApi) {
      ctx.inject(['webServer'], (httpCtx) => {
        httpCtx.effect(() => {
          const routes = installToolManagerApi(httpCtx, {
            registry,
            store,
            logger: ctx.logger,
          });
          return () => {
            for (const dispose of routes) dispose();
          };
        }, 'dsh-tool-manager: web api');
      });
    }
  } catch (err) {
    registry.disposeAll();
    for (const dispose of disposers) dispose();
    throw err;
  }

  ctx.effect(() => {
    return () => {
      registry.disposeAll();
      for (const dispose of disposers) dispose();
      ctx.logger.info('dsh-tool-manager: 已卸载');
    };
  }, 'dsh-tool-manager');
}
