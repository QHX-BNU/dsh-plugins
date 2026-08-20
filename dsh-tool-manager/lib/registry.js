/**
 * dsh-tool-manager —— 工具注册表管理核心（服务端）
 *
 * 围绕 ctx.tools（dsh-tools 的 ToolRuntime）提供：
 * - listAll()：列出全部注册工具（全局层 + agent 局部层 + 自定义工具），
 *   含每个工具的 schema 与禁用/来源状态；
 * - disable()/enable()：DSH 工具可见性由「作用域链上的 restriction」过滤
 *   （ToolRuntime.view 对每个 scope 检查其 own + 祖先层的 admits），因此
 *   禁用 = 对每个 live agent 的 scoped ctx 追加 deny restriction：
 *   - 已存在的 agent：遍历 ctx.agents.list() 逐个应用；
 *   - 未来的 agent：由插件在 ctx.on('agent/created') 中调用 applyToAgent()
 *     补齐；
 *   - 被禁用的工具从 agent 的可见工具列表消失（模型看不到、调用报
 *     UNKNOWN_TOOL），启用时撤销对应 restriction；
 * - registerCustom()/unregisterCustom()：把用户"制作"的自定义工具注册为
 *   真正的 DSH 工具（ctx.tools.register），主 Agent 立即可用。
 *
 * 保护名单：toolmgr_* 管理工具自身不可被禁用/删除（防止把管理入口锁死）。
 */
import { defineTool, parameterSchemaSpecToJsonSchema } from '@deepseek-ai/dsh-tools';
import { runToolCode, buildHelpers, DEFAULT_RUN_TIMEOUT_MS } from './runtime.js';

/** 本插件注册的管理工具名（受保护，不可禁用/删除）。 */
export const MANAGER_TOOL_NAMES = [
  'toolmgr_list',
  'toolmgr_create',
  'toolmgr_edit',
  'toolmgr_delete',
  'toolmgr_toggle',
];

/** 保留名（Code Mode 传输层），不可注册也不可被 restriction 命中。 */
const RESERVED_NAMES = new Set(['run_code']);

/** restriction 表 key 的分隔符（agent id 与工具名之间）。 */
const KEY_SEP = '\u0001';

export class ToolRegistryManager {
  /**
   * @param ctx   插件根 ctx（inject: ['tools', 'systemPrompt']）
   * @param store ToolManagerStore 实例
   * @param opts  { runTimeoutMs, logger }
   */
  constructor(ctx, store, opts = {}) {
    this.ctx = ctx;
    this.tools = ctx.tools;
    this.store = store;
    this.logger = opts.logger;
    this.runTimeoutMs = opts.runTimeoutMs || DEFAULT_RUN_TIMEOUT_MS;
    /** 当前已禁用的工具名集合（内存态，与 store.data.disabled 同步维护）。 */
    this.disabledNames = new Set(store.data.disabled);
    /** key: agentId + KEY_SEP + toolName -> restriction disposer */
    this.agentRestrictions = new Map();
    /** customId -> 工具注册的 disposer */
    this.customDisposers = new Map();
    /** agent/created 监听器的 dispose 函数 */
    this.createdListenerDispose = undefined;
  }

  /** 惰性解析 agents 服务（DSH 主程序必有；测试环境可能没有）。 */
  agentsService() {
    try {
      return this.ctx.get('agents');
    } catch {
      return undefined;
    }
  }

  /** 工具是否受保护（管理工具自身）。 */
  isProtected(name) {
    return MANAGER_TOOL_NAMES.includes(name);
  }

  /** 全部已注册工具名（global + scoped），含被禁用的。 */
  allRegisteredNames() {
    const names = new Set();
    for (const [name] of this.tools.layers.global.tools.entries()) names.add(name);
    for (const layer of this.tools.layers.scoped.values()) {
      for (const [name] of layer.tools.entries()) names.add(name);
    }
    return names;
  }

  /**
   * 列出全部工具（注册表 + 自定义），构造面板/模型可读的视图。
   * 同名时（scoped 覆盖 global）合并展示，标注 scoped=true。
   */
  listAll() {
    const rows = [];
    const seen = new Map();
    const customById = new Map(this.store.listCustom().map((t) => [t.id, t]));

    // global 层
    for (const [name, def] of this.tools.layers.global.tools.entries()) {
      seen.set(name, { name, def, scoped: false });
    }
    // scoped 层（agent 局部注册，如 preset 注入的工具）
    for (const layer of this.tools.layers.scoped.values()) {
      for (const [name, def] of layer.tools.entries()) {
        const existing = seen.get(name);
        if (existing) existing.scoped = true;
        else seen.set(name, { name, def, scoped: true });
      }
    }
    for (const { name, def, scoped } of seen.values()) {
      const custom = customById.get(name) || this.store.findCustomByName(name);
      const parameters = def && def.parameters && typeof def.parameters === 'object' ? def.parameters : {};
      const paramCount = parameters.properties && typeof parameters.properties === 'object'
        ? Object.keys(parameters.properties).length
        : 0;
      rows.push({
        name,
        description: def && def.description ? def.description : '',
        parameters,
        paramCount,
        scoped,
        source: custom ? 'custom' : 'system',
        customId: custom ? custom.id : undefined,
        code: custom ? custom.code || '' : undefined,
        registered: true,
        disabled: this.store.isDisabled(name),
        usageCount: custom ? custom.usageCount || 0 : undefined,
        createdAt: custom ? custom.createdAt || 0 : undefined,
        updatedAt: custom ? custom.updatedAt || 0 : undefined,
      });
    }
    // 未注册的自定义工具（enabled=false）
    for (const tool of this.store.listCustom()) {
      if (seen.has(tool.id) || seen.has(tool.name)) continue;
      rows.push({
        name: tool.id,
        description: tool.description || '',
        parameters: tool.parameters || {},
        paramCount: tool.parameters && tool.parameters.properties
          ? Object.keys(tool.parameters.properties).length
          : 0,
        scoped: false,
        source: 'custom',
        customId: tool.id,
        code: tool.code || '',
        registered: false,
        disabled: this.store.isDisabled(tool.id),
        usageCount: tool.usageCount || 0,
        createdAt: tool.createdAt || 0,
        updatedAt: tool.updatedAt || 0,
      });
    }
    rows.sort((a, b) => {
      if (a.source !== b.source) return a.source === 'custom' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return rows;
  }

  /** 对单个 agent 的 scoped ctx 应用一条禁用 restriction（幂等）。 */
  applyToAgent(agent, name) {
    if (!agent || !agent.ctx) return;
    if (this.agentRestrictions.has(agent.id + KEY_SEP + name)) return;
    const disposer = this.tools.layers.effect(
      agent.ctx,
      (layer) => layer.restrictions.append({ deny: new Set([name]) }),
      { label: `dsh-tool-manager: disable ${name} for ${agent.id}` },
    );
    this.agentRestrictions.set(agent.id + KEY_SEP + name, disposer);
  }

  /** 对所有已存在的 agent 应用某条禁用 restriction。 */
  applyToAllAgents(name) {
    const agents = this.agentsService();
    if (!agents || typeof agents.list !== 'function') return;
    for (const agent of agents.list()) {
      try {
        this.applyToAgent(agent, name);
      } catch (err) {
        this.logger?.warn?.(`dsh-tool-manager: 对 agent「${agent && agent.id}」禁用「${name}」失败：${err && err.message ? err.message : err}`);
      }
    }
  }

  /** 全局禁用某个已注册工具（对所有 live agent 生效，未来 agent 由监听补齐）。 */
  disable(name) {
    if (this.isProtected(name)) throw new Error(`「${name}」是工具管理器自身的管理工具，不允许禁用`);
    if (RESERVED_NAMES.has(name)) throw new Error(`「${name}」是保留工具名，不能禁用`);
    if (this.disabledNames.has(name)) return;
    this.disabledNames.add(name);
    this.store.setDisabled(name, true);
    this.applyToAllAgents(name);
  }

  /** 取消禁用（撤销所有 agent 上的对应 restriction）。 */
  enable(name) {
    if (!this.disabledNames.has(name)) return;
    this.disabledNames.delete(name);
    this.store.setDisabled(name, false);
    for (const [key, disposer] of [...this.agentRestrictions.entries()]) {
      if (!key.endsWith(KEY_SEP + name)) continue;
      this.agentRestrictions.delete(key);
      try {
        disposer();
      } catch (err) {
        this.logger?.warn?.(`dsh-tool-manager: 撤销「${name}」禁用失败：${err && err.message ? err.message : err}`);
      }
    }
  }

  /** 恢复存储中的禁用名单（插件启动时调用，配合 agent/created 监听）。 */
  applyStoredDisabled() {
    for (const name of this.store.data.disabled) {
      if (RESERVED_NAMES.has(name) || this.isProtected(name)) continue;
      if (!this.disabledNames.has(name)) {
        this.disabledNames.add(name);
        this.applyToAllAgents(name);
      }
    }
  }

  /** 注册 agent/created 监听：新 agent 创建时补齐禁用名单（返回 dispose 函数）。 */
  watchAgents() {
    if (this.createdListenerDispose) return this.createdListenerDispose;
    const listener = ({ agent }) => {
      if (!agent || !agent.ctx) return;
      for (const name of this.disabledNames) {
        try {
          this.applyToAgent(agent, name);
        } catch (err) {
          this.logger?.warn?.(`dsh-tool-manager: 新 agent「${agent.id}」禁用「${name}」失败：${err && err.message ? err.message : err}`);
        }
      }
    };
    this.createdListenerDispose = this.ctx.on('agent/created', listener);
    return this.createdListenerDispose;
  }

  /** 注册（或重新注册）一个自定义工具为真实 DSH 工具。 */
  registerCustom(tool) {
    const existing = this.customDisposers.get(tool.id);
    if (existing) {
      existing();
      this.customDisposers.delete(tool.id);
    }
    if (RESERVED_NAMES.has(tool.id)) {
      throw new Error(`工具名「${tool.id}」是保留名（run_code），不能注册`);
    }
    // 校验参数 schema（DSH 值 schema DSL）
    try {
      parameterSchemaSpecToJsonSchema(tool.parameters || {});
    } catch (err) {
      throw new Error(`参数定义不合法：${err && err.message ? err.message : String(err)}`);
    }
    const self = this;
    const helpers = buildHelpers();
    const disposer = this.tools.register(defineTool({
      name: tool.id,
      description: tool.description || `自定义工具：${tool.name}`,
      parameters: tool.parameters || {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            result: { type: 'json', required: true, description: '工具逻辑的返回值' },
            logs: { type: 'array', items: { type: 'string' }, description: '工具运行期间 console/helpers.log 的输出' },
          },
        },
        render: (_args, value) => {
          const parts = [];
          if (Array.isArray(value.logs) && value.logs.length > 0) {
            parts.push(value.logs.join('\n'));
          }
          let text;
          try {
            text = typeof value.result === 'string'
              ? value.result
              : JSON.stringify(value.result, null, 2);
          } catch {
            text = String(value.result);
          }
          if (text && text !== 'null' && text !== 'undefined') parts.push(text);
          return [{ type: 'text', text: parts.length > 0 ? parts.join('\n') : '(工具返回空结果)' }];
        },
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const { value, logs } = await runToolCode(tool.code, args, helpers, {
          timeoutMs: self.runTimeoutMs,
          signal: exec.signal,
        });
        self.store.bumpUsage(tool.id);
        self.store.persist().catch(() => {});
        return { result: value === undefined ? null : value, logs };
      },
    }));
    this.customDisposers.set(tool.id, disposer);
  }

  /** 注销一个自定义工具（从注册表移除，不影响 store 记录）。 */
  unregisterCustom(id) {
    const disposer = this.customDisposers.get(id);
    if (disposer) {
      disposer();
      this.customDisposers.delete(id);
    }
  }

  /** 卸载：清理全部 disposer 与监听器。 */
  disposeAll() {
    if (this.createdListenerDispose) {
      try {
        this.createdListenerDispose();
      } catch { /* 忽略 */ }
      this.createdListenerDispose = undefined;
    }
    for (const disposer of this.agentRestrictions.values()) {
      try {
        disposer();
      } catch { /* 忽略 */ }
    }
    this.agentRestrictions.clear();
    for (const disposer of this.customDisposers.values()) {
      try {
        disposer();
      } catch { /* 忽略 */ }
    }
    this.customDisposers.clear();
  }
}
