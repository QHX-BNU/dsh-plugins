/**
 * dsh-agent-factory —— Agent 工厂（可复用的 subagent 模板库）
 *
 * 为 DeepSeek Harness 提供「可复用子智能体」能力：
 * - 模板库：每个模板定义子智能体的名称、职责描述、系统提示（persona）、
 *   模型供应商（provider）、模型名、token 上限、工具白/黑名单等；
 * - 主 Agent 可直接使用 agent_list / agent_save / agent_run / agent_delete
 *   四个工具自行创建、编辑并调用模板（模型供应商等信息可被 Agent 随时改写）；
 * - 侧边栏「Agent 工厂」面板（Web 客户端 bundle 见 lib/client.js）：
 *   可视化新建/编辑/复制/删除模板，并可直接试运行；
 * - 运行时按模板通过 ctx.subagents 委派真实的 DSH 子智能体：
 *   inheritContext=true 走 fork（继承父对话），否则走 spawn（全新上下文）；
 *   模型路由经 request.agentOptions.{provider,model,maxTokens} 覆盖。
 *
 * 用法（profile 的 cordis.patch.yml）：
 * ```yaml
 * - insert:
 *     - id: dsh-agent-factory
 *       name: 'dsh-agent-factory'
 *       config:
 *         statePath: 'C:/Users/<你>/.dsh/profiles/desktop/data/agent-factory.json'
 *         webApi: true
 * ```
 */
import z from '@deepseek-ai/schemastery';
import { defaultStatePath, AgentStore } from './store.js';
import { installAgentTools } from './tools.js';
import { installAgentFactoryApi } from './api.js';

export const name = 'dsh-agent-factory';

export const inject = ['tools', 'subagents', 'systemPrompt', 'agents'];

export const Config = z.object({
  /** 模板库 JSON 存储路径（默认 <home>/.dsh/agent-factory/agents.json）。 */
  statePath: z.string().default(''),
  /** 子智能体 provider：inheritContext=false 时使用（全新上下文，默认 spawn）。 */
  spawnProvider: z.string().default('spawn'),
  /** 子智能体 provider：inheritContext=true 时使用（继承父对话，默认 fork）。 */
  forkProvider: z.string().default('fork'),
  /** 面板前台运行的超时（毫秒），超时自动中止。默认 15 分钟。 */
  runTimeoutMs: z.number().min(0).max(24 * 60 * 60 * 1000).default(15 * 60 * 1000),
  /** 是否注册 agent_list/agent_save/agent_run/agent_delete 四个工具。 */
  tools: z.boolean().default(true),
  /** 是否注册系统提示片段（让主 Agent 知道有哪些模板可用）。 */
  promptSection: z.boolean().default(true),
  /** 是否注册可视化页面 API（侧边栏「Agent 工厂」面板依赖它）。 */
  webApi: z.boolean().default(true),
});

export async function apply(ctx, config) {
  const statePath = config.statePath && config.statePath.trim() !== ''
    ? config.statePath.trim()
    : defaultStatePath();
  const store = new AgentStore(statePath);
  await store.load();
  ctx.logger.info(`dsh-agent-factory: 插件激活（statePath=${statePath}，${store.list().length} 个模板，spawn=${config.spawnProvider}，fork=${config.forkProvider}）`);

  const disposers = [];
  try {
    if (config.tools) {
      for (const dispose of installAgentTools(ctx, {
        store,
        spawnProvider: config.spawnProvider,
        forkProvider: config.forkProvider,
        runTimeoutMs: config.runTimeoutMs,
      })) disposers.push(dispose);
    }

    if (config.promptSection) {
      ctx.systemPrompt.section({
        name: 'agent-factory',
        order: 116.8,
        text: () => {
          const agents = store.list();
          if (agents.length === 0) return '';
          const lines = agents.slice(0, 30).map((a) =>
            `- ${a.id}（${a.name}）${a.description ? '：' + a.description : ''}` +
            `[${a.provider || '继承调用方'}${a.model ? ' / ' + a.model : ''}${a.inheritContext ? ' / 继承上下文' : ''}]`);
          return '可复用的 Agent 模板（Agent 工厂）：\n' + lines.join('\n') +
            '\n委派任务用 agent_run（填 agent=模板 id 或名称 + task），用 agent_save 可新建或编辑模板（含模型供应商/模型），agent_list 查看全部。' +
            '用户消息中形如 @模板id 或 @模板名 的引用（如 @vision）表示用户指定用该模板执行任务——解析出模板后用 agent_run 调用，把任务内容作为 task。';
        },
      });
    }

    if (config.webApi) {
      ctx.inject(['webServer'], (httpCtx) => {
        httpCtx.effect(() => {
          const routes = installAgentFactoryApi(httpCtx, {
            store,
            logger: ctx.logger,
            subagents: ctx.subagents,
            agents: ctx.agents,
            spawnProvider: config.spawnProvider,
            forkProvider: config.forkProvider,
            runTimeoutMs: config.runTimeoutMs,
          });
          return () => {
            for (const dispose of routes) dispose();
          };
        }, 'dsh-agent-factory: web api');
      });
    }
  } catch (err) {
    for (const dispose of disposers) dispose();
    throw err;
  }

  ctx.effect(() => {
    return () => {
      for (const dispose of disposers) dispose();
      ctx.logger.info('dsh-agent-factory: 已卸载');
    };
  }, 'dsh-agent-factory');
}
