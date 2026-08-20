/**
 * dsh-tool-manager —— 面向主 Agent 的五个管理工具
 *
 * - toolmgr_list    列出全部已注册工具（名称/描述/参数个数/来源/禁用状态）
 * - toolmgr_create  制作一个新的自定义工具（定义参数与执行代码，立即生效）
 * - toolmgr_edit    修改一个自定义工具（名称/描述/参数/代码/启用开关）
 * - toolmgr_delete  删除一个自定义工具（系统工具不可删除，只能禁用）
 * - toolmgr_toggle  禁用/启用任意工具（禁用后模型不再看到、也无法调用）
 *
 * 自定义工具的执行代码是 async (args, helpers) => { ...; return value; }
 * 的函数体，在 node:vm 沙箱中运行；helpers 提供 require/fetch/log/now/env。
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { normalizeToolName, TOOL_NAME_RE } from './store.js';

/** 工具列表的展示视图。 */
function viewTool(tool) {
  return {
    name: tool.name,
    description: tool.description || '',
    paramCount: tool.paramCount || 0,
    source: tool.source,
    scoped: !!tool.scoped,
    registered: !!tool.registered,
    enabled: !tool.disabled,
    usageCount: tool.usageCount || 0,
  };
}

export function installManagerTools(ctx, registry, store) {
  const disposers = [];

  disposers.push(ctx.tools.register(defineTool({
    name: 'toolmgr_list',
    description: '列出 DSH 中全部已注册工具（名称、描述、参数个数、来源：自定义/系统、是否被禁用）。用于查看当前可用工具、排查工具状态、为 toolmgr_toggle 提供准确的工具名。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tools: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                description: { type: 'string', required: true },
                paramCount: { type: 'number', required: true },
                source: { type: 'string', required: true },
                scoped: { type: 'boolean', required: true },
                registered: { type: 'boolean', required: true },
                enabled: { type: 'boolean', required: true },
                usageCount: { type: 'number', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const tools = Array.isArray(value.tools) ? value.tools : [];
        if (tools.length === 0) return [{ type: 'text', text: '当前没有已注册的工具。' }];
        const lines = tools.map((t) => {
          const badges = [];
          badges.push(t.source === 'custom' ? '自定义' : '系统');
          if (t.scoped) badges.push('局部');
          if (!t.registered) badges.push('未注册');
          if (!t.enabled) badges.push('已禁用');
          return `- ${t.name}（${badges.join('/')}${t.paramCount ? `，${t.paramCount} 个参数` : ''}${t.usageCount ? `，已用 ${t.usageCount} 次` : ''}）${t.description ? '：' + t.description : ''}`;
        });
        return [{ type: 'text', text: '已注册工具：\n' + lines.join('\n') }];
      },
    },
    isConcurrencySafe: () => true,
    async execute() {
      return { tools: registry.listAll().map(viewTool) };
    },
  })));

  disposers.push(ctx.tools.register(defineTool({
    name: 'toolmgr_create',
    description: '制作一个新的自定义工具：定义工具名（name）、描述（description）、参数定义（parameters，DSH 值 schema：{ 参数名: { type: "string|number|integer|boolean|array|object|json", required: true, description: "..." } }）与执行代码（code）。执行代码是 async (args, helpers) => { ...; return value; } 的函数体，在 node:vm 沙箱运行；helpers 提供 require（按需引入 node 模块）、fetch、log、now、env。创建后立即注册，主 Agent 和模型马上就能调用。',
    parameters: {
      name: { type: 'string', required: true, description: '工具名（小写字母/数字/下划线，以字母开头，如 translate_text）。' },
      description: { type: 'string', required: true, description: '一句话描述工具职责与适用场景（展示给模型）。' },
      parameters: { type: 'json', description: '参数定义对象：{ 参数名: { type, required, description } }。无参数时传 {}。' },
      code: { type: 'string', required: true, description: '执行代码：async (args, helpers) => { ...; return value; } 的函数体。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          name: { type: 'string', required: true },
          created: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `自定义工具已创建：${value.id}（${value.name}），立即生效，可用 toolmgr_list 查看。`,
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const tool = store.addCustom(args);
      registry.registerCustom(tool);
      await store.persist();
      ctx.logger.info?.(`tool-manager: 创建自定义工具「${tool.id}」（${tool.name}）`);
      return { id: tool.id, name: tool.name, created: true };
    },
  })));

  disposers.push(ctx.tools.register(defineTool({
    name: 'toolmgr_edit',
    description: '修改一个自定义工具（按 id 或名称）：可更新描述、参数定义、执行代码，或切换启用状态（enabled=false 时注销该工具，模型不再看到；true 时重新注册）。系统工具不能编辑，只能禁用（toolmgr_toggle）。',
    parameters: {
      tool: { type: 'string', required: true, description: '要修改的自定义工具 id 或名称。' },
      description: { type: 'string', description: '新的描述。' },
      parameters: { type: 'json', description: '新的参数定义（DSH 值 schema）。' },
      code: { type: 'string', description: '新的执行代码（async (args, helpers) => {...} 函数体）。' },
      enabled: { type: 'boolean', description: '是否启用：false 注销工具，true 注册工具。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          name: { type: 'string', required: true },
          updated: { type: 'boolean', required: true },
          enabled: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `自定义工具已更新：${value.id}（${value.name}）${value.enabled ? '（已启用）' : '（已注销）'}`,
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const key = String(args.tool || '').trim();
      if (!key) throw new Error('缺少要修改的工具 id 或名称');
      const existing = store.getCustom(key) || store.findCustomByName(key);
      if (!existing) throw new Error(`找不到自定义工具「${key}」。系统工具不能编辑，只能禁用（toolmgr_toggle）。`);
      const payload = {};
      if (args.description !== undefined) payload.description = String(args.description);
      if (args.parameters !== undefined) payload.parameters = args.parameters;
      if (args.code !== undefined) payload.code = String(args.code);
      if (args.enabled !== undefined) payload.enabled = args.enabled === true;
      const tool = store.updateCustom(existing.id, payload);
      const wantRegistered = tool.enabled;
      const isRegistered = registry.customDisposers.has(tool.id);
      if (wantRegistered && !isRegistered) registry.registerCustom(tool);
      if (!wantRegistered && isRegistered) registry.unregisterCustom(tool.id);
      await store.persist();
      ctx.logger.info?.(`tool-manager: 更新自定义工具「${tool.id}」（enabled=${tool.enabled}）`);
      return { id: tool.id, name: tool.name, updated: true, enabled: tool.enabled };
    },
  })));

  disposers.push(ctx.tools.register(defineTool({
    name: 'toolmgr_delete',
    description: '删除一个自定义工具（按 id 或名称）：从注册表与存储中彻底移除，无法恢复。系统工具不能删除（它们由 DSH 或插件注册，只能通过 toolmgr_toggle 禁用）。',
    parameters: {
      tool: { type: 'string', required: true, description: '要删除的自定义工具 id 或名称。' },
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
        text: value.removed ? `已删除自定义工具「${value.id}」` : `工具「${value.id}」不存在`,
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const key = String(args.tool || '').trim();
      if (!key) throw new Error('缺少要删除的工具 id 或名称');
      const removed = store.removeCustom(key);
      if (!removed) {
        if (registry.allRegisteredNames().has(key)) {
          throw new Error(`「${key}」是系统工具，不能删除；如需停用请用 toolmgr_toggle 禁用它。`);
        }
        throw new Error(`找不到自定义工具「${key}」`);
      }
      registry.unregisterCustom(removed.id);
      registry.enable(removed.id);
      await store.persist();
      ctx.logger.info?.(`tool-manager: 删除自定义工具「${removed.id}」`);
      return { id: removed.id, removed: true };
    },
  })));

  disposers.push(ctx.tools.register(defineTool({
    name: 'toolmgr_toggle',
    description: '禁用或启用一个已注册工具（按工具名，可用 toolmgr_list 查看准确名称）：disabled=true 时该工具从所有 agent 的可见工具列表消失、调用报未知工具；false 时恢复。系统工具与自定义工具均可禁用；工具管理器自身的 toolmgr_* 工具受保护不可禁用。',
    parameters: {
      tool: { type: 'string', required: true, description: '要禁用/启用的工具名（如 "web_search"、"pwsh"）。' },
      disabled: { type: 'boolean', required: true, description: 'true=禁用，false=启用。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          disabled: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `工具「${value.name}」已${value.disabled ? '禁用' : '启用'}。`,
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const name = String(args.tool || '').trim();
      if (!name) throw new Error('缺少工具名');
      const disabled = args.disabled === true;
      if (disabled) {
        registry.disable(name);
      } else {
        registry.enable(name);
      }
      await store.persist();
      ctx.logger.info?.(`tool-manager: ${disabled ? '禁用' : '启用'}工具「${name}」`);
      return { name, disabled };
    },
  })));

  return disposers;
}

/** 工具名合法性提示（供 API/面板复用）。 */
export function validateToolName(name) {
  if (!TOOL_NAME_RE.test(name)) {
    throw new Error(`工具名「${name}」不合法：只能包含小写字母/数字/下划线，且必须以字母开头`);
  }
  return normalizeToolName(name);
}
