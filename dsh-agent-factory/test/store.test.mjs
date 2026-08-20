/**
 * dsh-agent-factory —— 存储层测试
 * 运行：node test/store.test.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import {
  AgentStore,
  normalizeId,
  sanitizeAgent,
  deriveId,
  AGENT_ID_RE,
} from '../lib/store.js';

let passed = 0;
async function ok(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('  ✓', name);
  } catch (err) {
    console.error('  ✗', name, '\n   ', err.message);
    process.exitCode = 1;
  }
}

console.log('normalizeId / AGENT_ID_RE');
await ok('英文名派生 kebab id', () => {
  assert.equal(normalizeId('Code Reviewer!'), 'code-reviewer');
  assert.equal(normalizeId('翻译官'), undefined); // 纯中文退化
  assert.ok(AGENT_ID_RE.test('code-reviewer'));
  assert.ok(!AGENT_ID_RE.test('-bad'));
  assert.ok(!AGENT_ID_RE.test('has space'));
});

console.log('sanitizeAgent');
await ok('裁剪与类型规范化', () => {
  const a = sanitizeAgent({
    id: 'x', name: ' 名字 ', description: ' 描述 ',
    persona: ' 系统提示 ', provider: 'aliyun ', model: ' qwen-max ',
    maxTokens: '8192.9', inheritContext: true, maxDepth: -3,
    toolFilter: { allow: ['read', '', 'grep'], deny: ['bash'] },
  });
  assert.equal(a.name, '名字');
  assert.equal(a.provider, 'aliyun');
  assert.equal(a.maxTokens, 8193); // 四舍五入
  assert.equal(a.inheritContext, true);
  assert.equal(a.maxDepth, 0); // 负值归 0
  assert.deepEqual(a.toolFilter, { allow: ['read', 'grep'], deny: ['bash'] });
});

console.log('AgentStore upsert');
const dir = mkdtempSync(join(tmpdir(), 'dsh-af-'));
const store = new AgentStore(join(dir, 'agents.json'));
await store.load();
await ok('空库新建', () => {
  const { agent, created } = store.upsert({ id: 'reviewer', name: '代码评审员', description: '审查代码', persona: '你是评审专家' });
  assert.equal(created, true);
  assert.equal(agent.id, 'reviewer');
  assert.equal(agent.usageCount, 0);
});
await ok('同名更新（partial：未提供的字段保留）', () => {
  const { agent, created } = store.upsert({ name: '代码评审员', provider: 'deepseek', model: 'deepseek-chat' }, { partial: true });
  assert.equal(created, false);
  assert.equal(agent.id, 'reviewer'); // 沿用旧 id
  assert.equal(agent.provider, 'deepseek');
  assert.equal(agent.persona, '你是评审专家'); // 旧字段保留
});
await ok('按 id 更新（partial）', () => {
  const { agent, created } = store.upsert({ id: 'reviewer', maxTokens: 4096 }, { partial: true });
  assert.equal(created, false);
  assert.equal(agent.maxTokens, 4096);
  assert.equal(agent.model, 'deepseek-chat');
});
await ok('全量替换（面板表单语义：空字段清除）', () => {
  const { agent } = store.upsert({ id: 'reviewer', name: '代码评审员', provider: '', model: '' });
  assert.equal(agent.provider, '');
  assert.equal(agent.persona, ''); // persona 未提供 → 清除
});
await ok('缺 id 时从名称派生（不冲突则直接派生）', () => {
  const { agent, created } = store.upsert({ name: 'Translator' });
  assert.equal(created, true);
  assert.equal(agent.id, 'translator');
});
await ok('缺 id 且中文名退化 → 派生为 agent', () => {
  const { agent, created } = store.upsert({ name: '中文模板' });
  assert.equal(created, true);
  assert.equal(agent.id, 'agent');
});
await ok('deriveId 冲突递增', () => {
  assert.equal(deriveId(store, 'reviewer'), 'reviewer-2');
  assert.equal(deriveId(store, 'Translator'), 'translator-2');
});
await ok('findByName 大小写不敏感', () => {
  assert.equal(store.findByName('代码评审员').id, 'reviewer');
  assert.equal(store.findByName('TRANSLATOR').id, 'translator');
});
await ok('bumpUsage 统计', () => {
  store.bumpUsage('reviewer');
  assert.equal(store.get('reviewer').usageCount, 1);
  assert.ok(store.get('reviewer').lastUsedAt > 0);
});
await ok('remove', () => {
  assert.equal(store.remove('translator'), true);
  assert.equal(store.remove('translator'), false);
});

console.log('持久化往返');
await ok('persist 后重载一致', async () => {
  await store.persist();
  const again = new AgentStore(store.path);
  await again.load();
  assert.equal(again.list().length, store.list().length);
  assert.deepEqual(again.get('reviewer'), store.get('reviewer'));
});
await ok('损坏文件回退空库', async () => {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(store.path, '{broken json!!', 'utf8');
  const broken = new AgentStore(store.path);
  await broken.load();
  assert.equal(broken.list().length, 0);
});

rmSync(dir, { recursive: true, force: true });
console.log(`\n通过 ${passed} 项`);
if (process.exitCode) process.exit(process.exitCode);
