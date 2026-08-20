/**
 * dsh-tool-manager —— 集成测试（真实 cordis + dsh-tools 服务）
 *
 * 用真实 Context 加载 dsh-tools 的 ToolRuntime 与本插件，验证：
 * - 插件 apply 不报错（注册 toolmgr_* 工具、systemPrompt 片段、API）
 * - toolmgr_list 能列出工具
 * - 创建自定义工具后出现在 schemas()，执行可用
 * - disable 后工具从 agent 的 schemas() 消失，enable 后恢复
 * - 新 agent 创建（agent/created）时自动补齐禁用名单
 *
 * 运行：node test/integration.mjs
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context, Service } from '@deepseek-ai/cordis';
import { createScope } from '@deepseek-ai/dsh-scope';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import * as toolManagerPlugin from '../lib/index.js';

let passed = 0;
async function ok(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

const dir = mkdtempSync(join(tmpdir(), 'tool-manager-int-'));
const statePath = join(dir, 'state.json');

const ctx = new Context();
await ctx.plugin(SystemPrompt, {});
await ctx.plugin(ToolRuntime, { mode: 'native' });

// 模拟 agents 服务：一个 fake agent（真实 scoped context，scope key = agent 对象本身）
const fakeAgent = { id: 'agent-1', name: '测试Agent' };
fakeAgent.ctx = createScope(ctx, fakeAgent).ctx;
class FakeAgents extends Service {
  constructor(c, config) {
    super(c, 'agents');
    this.agents = config.agents;
  }
  list() { return this.agents; }
  get(id) { return this.agents.find((a) => a.id === id); }
}
await ctx.plugin(FakeAgents, { agents: [fakeAgent] });

await ctx.plugin(toolManagerPlugin, {
  statePath,
  runTimeoutMs: 5000,
  tools: true,
  promptSection: true,
  webApi: false,
});

try {
  const tools = ctx.tools;
  assert.ok(tools, 'ctx.tools 存在');

  await ok('toolmgr_* 工具已注册', () => {
    const names = tools.schemas().map((s) => s.name);
    for (const n of ['toolmgr_list', 'toolmgr_create', 'toolmgr_edit', 'toolmgr_delete', 'toolmgr_toggle']) {
      assert.ok(names.includes(n), `缺少 ${n}`);
    }
  });

  await ok('toolmgr_list 执行返回工具列表', async () => {
    const def = tools.get('toolmgr_list');
    assert.ok(def, 'toolmgr_list 定义存在');
    const result = await def.execute({}, { agent: undefined, signal: new AbortController().signal });
    assert.ok(Array.isArray(result.tools));
    assert.ok(result.tools.some((t) => t.name === 'toolmgr_list'));
  });

  await ok('创建自定义工具并出现在 schemas', async () => {
    const def = tools.get('toolmgr_create');
    const res = await def.execute({
      name: 'hello_world',
      description: '返回问候语',
      parameters: { who: { type: 'string', required: true, description: '名字' } },
      code: 'return { hello: "hi " + args.who };',
    }, { agent: undefined, signal: new AbortController().signal });
    assert.equal(res.id, 'hello_world');
    assert.ok(tools.get('hello_world'), '自定义工具已注册');
    const execRes = await tools.get('hello_world').execute({ who: 'dsh' }, { agent: undefined, signal: new AbortController().signal });
    assert.equal(execRes.result.hello, 'hi dsh');
  });

  await ok('禁用后从 agent 可见列表消失，启用后恢复', async () => {
    const agentSchemas = () => tools.schemas(fakeAgent).map((s) => s.name);
    assert.ok(agentSchemas().includes('hello_world'), '禁用前可见');
    const toggle = tools.get('toolmgr_toggle');
    await toggle.execute({ tool: 'hello_world', disabled: true }, { agent: undefined, signal: new AbortController().signal });
    assert.ok(!agentSchemas().includes('hello_world'), '禁用后从 agent 列表消失');
    // 全局（host 平面）视图不做作用域过滤，工具仍注册在全局层，但状态标记为禁用
    const listed = await tools.get('toolmgr_list').execute({}, { agent: undefined, signal: new AbortController().signal });
    const row = listed.tools.find((t) => t.name === 'hello_world');
    assert.ok(row && row.enabled === false, 'toolmgr_list 标记为已禁用');
    await toggle.execute({ tool: 'hello_world', disabled: false }, { agent: undefined, signal: new AbortController().signal });
    assert.ok(agentSchemas().includes('hello_world'), '启用后恢复');
  });

  await ok('新 agent 创建时自动补齐禁用名单', async () => {
    // 禁用一个工具
    const toggle = tools.get('toolmgr_toggle');
    await toggle.execute({ tool: 'hello_world', disabled: true }, { agent: undefined, signal: new AbortController().signal });
    // 模拟新 agent 创建（scope key = agent 对象）
    const newAgent = { id: 'agent-2', name: '新Agent' };
    const scope2 = createScope(ctx, newAgent);
    newAgent.ctx = scope2.ctx;
    ctx.emit('agent/created', { agent: newAgent });
    await new Promise((r) => setTimeout(r, 50));
    const names2 = tools.schemas(newAgent).map((s) => s.name);
    assert.ok(!names2.includes('hello_world'), '新 agent 也不可见被禁用的工具');
    assert.ok(names2.includes('toolmgr_list'), '新 agent 可见其它工具');
    // 启用后新 agent 恢复
    await toggle.execute({ tool: 'hello_world', disabled: false }, { agent: undefined, signal: new AbortController().signal });
    const names2b = tools.schemas(newAgent).map((s) => s.name);
    assert.ok(names2b.includes('hello_world'), '启用后新 agent 恢复可见');
  });

  await ok('删除自定义工具', async () => {
    const del = tools.get('toolmgr_delete');
    const res = await del.execute({ tool: 'hello_world' }, { agent: undefined, signal: new AbortController().signal });
    assert.equal(res.removed, true);
    assert.ok(!tools.get('hello_world'), '已从注册表移除');
  });

  await ok('禁用 toolmgr_* 被拒绝', async () => {
    const toggle = tools.get('toolmgr_toggle');
    await assert.rejects(
      toggle.execute({ tool: 'toolmgr_list', disabled: true }, { agent: undefined, signal: new AbortController().signal }),
      /不允许禁用/,
    );
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n通过 ${passed} 项检查`);
