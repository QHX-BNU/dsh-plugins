/**
 * dsh-agent-factory —— 工具 schema 编译冒烟测试
 * 用真实 dsh-tools 的 defineTool 编译全部四个工具，任何 schema 问题都会在此抛出。
 * 运行：node test/tools-schema.test.mjs
 */
import { installAgentTools } from '../lib/tools.js';
import { AgentStore } from '../lib/store.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const dir = mkdtempSync(join(tmpdir(), 'dsh-af-tools-'));
const store = new AgentStore(join(dir, 'agents.json'));
await store.load();

const captured = [];
const ctx = {
  tools: {
    register: (tool) => {
      captured.push(tool);
      return () => {};
    },
  },
  logger: { info: () => {}, warn: () => {} },
};

installAgentTools(ctx, { store, spawnProvider: 'spawn', forkProvider: 'fork', runTimeoutMs: 900000 });

const names = captured.map((t) => t.name);
console.log('已注册工具:', names.join(', '));
assert.deepEqual(names.sort(), ['agent_delete', 'agent_list', 'agent_run', 'agent_save']);

// 编译后的参数 schema 结构断言
const save = captured.find((t) => t.name === 'agent_save');
assert.equal(save.parameters.properties.toolFilter.additionalProperties, false); // 修复点：必须显式声明
assert.equal(save.parameters.properties.toolFilter.properties.allow.type, 'array');
assert.equal(save.parameters.required.includes('name'), true);

const run = captured.find((t) => t.name === 'agent_run');
assert.equal(run.parameters.required.includes('agent'), true);
assert.equal(run.parameters.required.includes('task'), true);

const del = captured.find((t) => t.name === 'agent_delete');
assert.equal(del.parameters.required.includes('agent'), true);

// 输出 schema 结构
const list = captured.find((t) => t.name === 'agent_list');
assert.equal(list.output.schema.type, 'object');
assert.equal(list.output.schema.properties.agents.type, 'array');
const runOut = run.output.schema.oneOf.map((s) => s.properties.kind.const).sort();
assert.deepEqual(runOut, ['background', 'foreground']);

// 输出渲染路径（render 接收 args/value）
const rendered = list.output.render({}, { agents: [{ id: 'a1', name: 'A1', description: '', provider: 'deepseek', model: '', maxTokens: 0, inheritContext: false, usageCount: 0 }] });
assert.ok(Array.isArray(rendered) && rendered[0].type === 'text');
const renderedBg = run.output.render({}, { kind: 'background', jobId: 'agent-factory-1' });
assert.ok(renderedBg[0].text.includes('agent-factory-1'));

rmSync(dir, { recursive: true, force: true });
console.log('✓ 工具 schema 全部编译通过');
