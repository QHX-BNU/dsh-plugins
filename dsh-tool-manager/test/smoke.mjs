/**
 * dsh-tool-manager —— 冒烟测试
 *
 * 覆盖：
 * 1. store：自定义工具增/改/删、禁用名单、持久化
 * 2. runtime：vm 沙箱执行（普通返回 / helpers.require / 语法错误 / 超时）
 * 3. registry：用 mock tools 验证 listAll / disable / enable 流程
 *
 * 运行：node test/smoke.mjs（依赖本地 node_modules junction）
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolManagerStore, normalizeToolName } from '../lib/store.js';
import { runToolCode, checkToolCodeSyntax, buildHelpers } from '../lib/runtime.js';
import { ToolRegistryManager } from '../lib/registry.js';

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

const dir = mkdtempSync(join(tmpdir(), 'tool-manager-test-'));
const statePath = join(dir, 'state.json');

console.log('== store ==');
await ok('normalizeToolName', () => {
  assert.equal(normalizeToolName('翻译文本'), undefined);
  assert.equal(normalizeToolName('Translate Text'), 'translate_text');
  assert.equal(normalizeToolName('  hello  world '), 'hello_world');
});

const store = new ToolManagerStore(statePath);

const t1 = store.addCustom({
  name: 'add_two',
  description: '两数相加',
  parameters: { a: { type: 'number', required: true }, b: { type: 'number', required: true } },
  code: 'return { sum: args.a + args.b };',
});
assert.ok(t1.id === 'add_two');
store.setDisabled('pwsh', true);
store.setDisabled('pwsh', false);
store.setDisabled('web_search', true);

await ok('禁用名单持久化', async () => {
  await store.persist();
  const store2 = new ToolManagerStore(statePath);
  await store2.load();
  assert.deepEqual(store2.data.disabled, ['web_search']);
  assert.ok(store2.getCustom('add_two'));
});

await ok('更新重命名', () => {
  const updated = store.updateCustom('add_two', { name: 'calc_sum', code: 'return { s: args.a + args.b };' });
  assert.equal(updated.id, 'calc_sum');
  assert.equal(store.getCustom('add_two'), undefined);
  assert.ok(store.getCustom('calc_sum'));
});

await ok('删除', () => {
  const removed = store.removeCustom('calc_sum');
  assert.ok(removed);
  assert.equal(store.removeCustom('calc_sum'), false);
});

console.log('== runtime ==');
await ok('语法预检', () => {
  assert.equal(checkToolCodeSyntax('return 1;'), undefined);
  assert.ok(checkToolCodeSyntax('return ))(').length > 0);
});

await ok('普通执行 + 日志', async () => {
  const { value, logs } = await runToolCode(
    'console.log("a=" + args.a);\nreturn { sum: args.a + args.b };',
    { a: 1, b: 2 },
    buildHelpers(),
    { timeoutMs: 3000 },
  );
  // vm 沙箱返回的对象属于沙箱 realm，deepStrictEqual 会因原型不同误报，用 JSON 比较
  assert.equal(JSON.stringify(value), JSON.stringify({ sum: 3 }));
  assert.ok(logs.some((l) => l.includes('a=1')));
});

await ok('helpers.require 可用', async () => {
  const { value } = await runToolCode(
    "const { join } = helpers.require('node:path');\nreturn { joined: join('a', 'b') };",
    {},
    buildHelpers(),
    { timeoutMs: 3000 },
  );
  assert.equal(value.joined, 'a\\b');
});

await ok('语法错误执行报错', async () => {
  await assert.rejects(
    runToolCode('return ))(' , {}, buildHelpers(), { timeoutMs: 3000 }),
    /编译失败/,
  );
});

await ok('超时保护', async () => {
  await assert.rejects(
    runToolCode('await new Promise(r => setTimeout(r, 5000));\nreturn 1;', {}, buildHelpers(), { timeoutMs: 200 }),
    /超时/,
  );
});

await ok('非 JSON 返回值报错', async () => {
  await assert.rejects(
    runToolCode('const o = {}; o.self = o; return o;', {}, buildHelpers(), { timeoutMs: 3000 }),
    /可 JSON 序列化/,
  );
});

console.log('== registry (mock tools) ==');
function makeMockTools() {
  const restrictions = [];
  const tools = new Map();
  const scoped = new Map();
  const appendRestriction = (filter) => {
    restrictions.push(filter);
    return () => {
      const i = restrictions.indexOf(filter);
      if (i >= 0) restrictions.splice(i, 1);
    };
  };
  return {
    layers: {
      global: {
        tools,
        restrictions: { append: appendRestriction },
      },
      scoped: {
        values: () => scoped.values(),
      },
      effect: (_ctx, action) => {
        const layer = { restrictions: { append: appendRestriction } };
        const undo = action(layer);
        return () => undo();
      },
    },
    register: () => () => {},
    _restrictions: restrictions,
  };
}

const mockTools = makeMockTools();
const fakeAgent = { id: 'a1', ctx: {} };
const mockCtx = {
  tools: mockTools,
  get: (name) => (name === 'agents' ? { list: () => [fakeAgent] } : undefined),
  on: () => () => {},
};
const registry = new ToolRegistryManager(
  mockCtx,
  store,
  { logger: { info: () => {}, warn: () => {} }, runTimeoutMs: 3000 },
);
// 模拟系统工具
mockTools.layers.global.tools.set('pwsh', { description: '执行 PowerShell', parameters: { properties: { command: {} } } });
mockTools.layers.global.tools.set('web_search', { description: '搜索', parameters: {} });

await ok('listAll 包含系统与自定义', () => {
  const rows = registry.listAll();
  const names = rows.map((r) => r.name);
  assert.ok(names.includes('pwsh'));
  assert.ok(names.includes('web_search'));
});

await ok('disable 经 agent ctx 追加 restriction 且保护名单拒绝', () => {
  registry.disable('pwsh');
  assert.ok(mockTools._restrictions.some((f) => f.deny && f.deny.has('pwsh')));
  assert.throws(() => registry.disable('toolmgr_list'), /不允许禁用/);
  registry.enable('pwsh');
  assert.ok(!mockTools._restrictions.some((f) => f.deny && f.deny.has('pwsh')));
});

console.log(`\n通过 ${passed} 项检查`);
rmSync(dir, { recursive: true, force: true });
