/**
 * dsh-agent-factory —— 面向主 Agent 的四个工具
 *
 * - agent_list    列出全部可复用 Agent 模板（id/名称/描述/模型路由）
 * - agent_save    新建或更新一个模板（主 Agent 可自行编辑，含模型供应商/模型）
 * - agent_run     按模板运行子智能体，把任务委派出去（可临时覆盖模型路由）
 * - agent_delete  删除一个模板
 *
 * 模型路由覆盖走 request.agentOptions.{provider,model,maxTokens}，
 * 与官方 dsh-tool-subagent 的 agentOptions 配置同一条路径。
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { runForeground, runBackground, outputText, stopReasonText } from './runner.js';

/** 前台结果渲染（与官方 subagent 工具一致的块结构）。 */
function renderBlocks(output) {
  return [{ type: 'text', text: outputText(output) }];
}

/** 统一从 id 或名称解析模板，找不到时报出可用列表。 */
function resolveAgent(store, key) {
  const agent = store.get(key) || store.findByName(key);
  if (agent) return agent;
  const ids = store.list().map((a) => `${a.id}（${a.name}）`).join('，') || '暂无模板';
  throw new Error(`找不到 Agent 模板「${key}」。可用模板：${ids}。可先用 agent_list 查看，或用 agent_save 新建。`);
}

/** 把模板暴露给模型的只读摘要。 */
function publicAgent(agent) {
  return {
    id: agent.id,
    name: agent.name,
    description: agent.description,
    provider: agent.provider || '(继承调用方)',
    model: agent.model || '(继承调用方)',
    maxTokens: agent.maxTokens || 0,
    inheritContext: !!agent.inheritContext,
    toolFilter: agent.toolFilter || undefined,
    usageCount: agent.usageCount || 0,
  };
}

export function installAgentTools(ctx, { store, spawnProvider, forkProvider, runTimeoutMs }) {
  const disposers = [];

  disposers.push(ctx.tools.register(defineTool({
    name: 'agent_list',
    description: '列出 Agent 工厂中全部可复用的 subagent 模板（id、名称、描述、模型供应商/模型）。当你需要委派任务或不确定有哪些模板可用时调用。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          agents: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                name: { type: 'string', required: true },
                description: { type: 'string', required: true },
                provider: { type: 'string', required: true },
                model: { type: 'string', required: true },
                maxTokens: { type: 'number', required: true },
                inheritContext: { type: 'boolean', required: true },
                usageCount: { type: 'number', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const agents = Array.isArray(value.agents) ? value.agents : [];
        if (agents.length === 0) return [{ type: 'text', text: 'Agent 工厂中还没有模板。用 agent_save 新建一个，或在侧边栏「Agent 工厂」面板中创建。' }];
        const lines = agents.map((a) => `- ${a.id}（${a.name}）${a.description ? '：' + a.description : ''} [${a.provider}${a.model ? ' / ' + a.model : ''}${a.inheritContext ? ' / 继承上下文' : ''}${a.usageCount ? ' / 已用 ' + a.usageCount + ' 次' : ''}]`);
        return [{ type: 'text', text: '可用 Agent 模板：\n' + lines.join('\n') }];
      },
    },
    isConcurrencySafe: () => true,
    async execute() {
      return { agents: store.list().map(publicAgent) };
    },
  })));

  disposers.push(ctx.tools.register(defineTool({
    name: 'agent_save',
    description: '新建或更新一个可复用的 Agent 模板：定义子智能体的名称、职责描述、系统提示（persona）、模型供应商（provider，如 deepseek/aliyun/openai）、模型名、token 上限等。id 已存在或同名时是更新（可编辑已有模板），否则新建。供后续 agent_run 反复调用。',
    parameters: {
      id: { type: 'string', description: '模板 id（小写字母/数字/中划线，建议英文 kebab-case）。不填时从 name 派生。' },
      name: { type: 'string', required: true, description: '模板名称（如「代码评审员」），用于展示与按名调用。' },
      description: { type: 'string', description: '一句话描述该模板的职责与适用场景（会展示给模型与面板）。' },
      persona: { type: 'string', description: '系统提示：子智能体的角色设定、行为规范、输出要求等。' },
      provider: { type: 'string', description: '模型供应商 id（如 deepseek、aliyun、openai、anthropic）。留空继承调用方。' },
      model: { type: 'string', description: '模型名（如 deepseek-chat、qwen-max）。留空继承调用方。' },
      maxTokens: { type: 'number', description: '子智能体单次运行的最大输出 token 数。0 或不填表示继承调用方。' },
      inheritContext: { type: 'boolean', description: '是否继承父对话的上下文历史（true 用 fork 运行，false 用全新上下文的 spawn 运行）。默认 false。' },
      maxDepth: { type: 'number', description: '允许的递归委派深度（子智能体还能再委派）。0 或不填表示不限制。' },
      toolFilter: {
        type: 'object',
        additionalProperties: false,
        description: '限制子智能体可见工具：allow 白名单 / deny 黑名单，工具名数组。不填表示不限制。',
        properties: {
          allow: { type: 'array', items: { type: 'string' }, description: '仅允许这些工具（如 ["read","grep"]）' },
          deny: { type: 'array', items: { type: 'string' }, description: '禁止这些工具' },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          name: { type: 'string', required: true },
          created: { type: 'boolean', required: true },
          provider: { type: 'string', required: true },
          model: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Agent 模板${value.created ? '已创建' : '已更新'}：${value.id}（${value.name}）[${value.provider || '继承调用方'}${value.model ? ' / ' + value.model : ''}]`,
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      // 部分更新语义：模型未提供的字段保持模板原值（persona 等不会被意外清空）
      const payload = {};
      if (args.id !== undefined) payload.id = String(args.id || '').trim();
      if (args.name !== undefined) payload.name = String(args.name || '').trim();
      if (args.description !== undefined) payload.description = String(args.description || '').trim();
      if (args.persona !== undefined) payload.persona = String(args.persona || '');
      if (args.provider !== undefined) payload.provider = String(args.provider || '').trim();
      if (args.model !== undefined) payload.model = String(args.model || '').trim();
      if (args.maxTokens !== undefined) payload.maxTokens = Number(args.maxTokens) || 0;
      if (args.inheritContext !== undefined) payload.inheritContext = args.inheritContext === true;
      if (args.maxDepth !== undefined) payload.maxDepth = Number(args.maxDepth) || 0;
      if (args.toolFilter !== undefined && args.toolFilter && typeof args.toolFilter === 'object') {
        payload.toolFilter = {
          allow: Array.isArray(args.toolFilter.allow) ? args.toolFilter.allow : [],
          deny: Array.isArray(args.toolFilter.deny) ? args.toolFilter.deny : [],
        };
      }
      const result = store.upsert(payload, { partial: true });
      await store.persist();
      ctx.logger.info?.(`agent-factory: ${result.created ? '新建' : '更新'}模板「${result.agent.id}」（${result.agent.name}）`);
      return {
        id: result.agent.id,
        name: result.agent.name,
        created: result.created,
        provider: result.agent.provider || '',
        model: result.agent.model || '',
      };
    },
  })));

  disposers.push(ctx.tools.register(defineTool({
    name: 'agent_run',
    description: '按 Agent 工厂中的模板运行一个子智能体去做指定任务：子智能体使用模板设定的系统提示与模型路由（供应商/模型/token 上限），得到它的最终答复。适合把研究、审查、写作、翻译等可独立完成的任务委派出去。',
    parameters: {
      agent: { type: 'string', required: true, description: '模板 id 或名称（如 "code-reviewer" 或 "代码评审员"）。' },
      task: { type: 'string', required: true, description: '交给子智能体的完整任务描述（它看不到当前对话，需自包含；模板的系统提示会附加在它前面）。' },
      run_in_background: { type: 'boolean', description: 'true 时提交为后台任务立即返回 jobId（不等待结果）；默认 false，等待并返回结果。' },
      provider: { type: 'string', description: '本次运行的模型供应商覆盖（留空用模板设定）。' },
      model: { type: 'string', description: '本次运行的模型覆盖（留空用模板设定）。' },
      maxTokens: { type: 'number', description: '本次运行的 token 上限覆盖（0 用模板设定）。' },
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'background' },
              jobId: { type: 'string', required: true },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'foreground' },
              stopReason: { type: 'string', required: true },
              output: { type: 'array', required: true, items: { type: 'json' } },
            },
          },
        ],
      },
      render: (_args, value) => value.kind === 'background'
        ? [{ type: 'text', text: `已提交后台 Agent 任务 ${value.jobId}（任务面板可查看进度）` }]
        : renderBlocks(value.output),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const parent = exec.agent;
      if (!parent) throw new Error('agent_run 需要调用方 agent（exec.agent 缺失）');
      const agent = resolveAgent(store, args.agent);
      const task = String(args.task || '').trim();
      if (!task) throw new Error('任务内容（task）不能为空');
      const overrides = {
        ...args.provider !== undefined && String(args.provider).trim() ? { provider: String(args.provider).trim() } : {},
        ...args.model !== undefined && String(args.model).trim() ? { model: String(args.model).trim() } : {},
        ...Number(args.maxTokens) > 0 ? { maxTokens: Number(args.maxTokens) } : {},
      };
      if (args.run_in_background === true) {
        const jobId = await runBackground(ctx, agent, task, parent, overrides, spawnProvider, forkProvider);
        store.bumpUsage(agent.id);
        store.persist().catch(() => {});
        return { kind: 'background', jobId };
      }
      const { stopReason, output } = await runForeground(ctx, agent, task, parent, {
        signal: exec.signal,
        timeoutMs: runTimeoutMs,
        overrides,
        spawnProvider,
        forkProvider,
      });
      store.bumpUsage(agent.id);
      store.persist().catch(() => {});
      if (stopReason !== 'completed') {
        const text = outputText(output);
        const detail = `${stopReasonText(stopReason)}：模板「${agent.id}」的子智能体没有正常完成`;
        throw new Error(text ? detail + '\n部分输出：\n' + text : detail);
      }
      return { kind: 'foreground', stopReason, output };
    },
  })));

  disposers.push(ctx.tools.register(defineTool({
    name: 'agent_delete',
    description: '删除 Agent 工厂中的一个模板（按 id 或名称）。删除后 agent_run 无法再调用它；已运行中的子智能体不受影响。',
    parameters: {
      agent: { type: 'string', required: true, description: '要删除的模板 id 或名称。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          removed: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.removed ? `已删除 Agent 模板「${value.id}」` : `模板「${value.id}」不存在`,
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const key = String(args.agent || '').trim();
      if (!key) throw new Error('缺少要删除的模板 id 或名称');
      const agent = store.get(key) || store.findByName(key);
      if (!agent) throw new Error(`找不到 Agent 模板「${key}」。可用 agent_list 查看现有模板。`);
      store.remove(agent.id);
      await store.persist();
      ctx.logger.info?.(`agent-factory: 已删除模板「${agent.id}」`);
      return { id: agent.id, removed: true };
    },
  })));

  return disposers;
}
