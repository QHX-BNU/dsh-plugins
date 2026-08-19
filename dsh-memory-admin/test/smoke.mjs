/**
 * dsh-memory-admin 烟雾测试：存储层 + 召回算法（不依赖 DSH 运行时）。
 * 运行：node.cmd test/smoke.mjs
 */
import { MemoryStore, CATEGORIES, CATEGORY_LABELS } from '../lib/store.js';
import { tokenize, recall } from '../lib/recall.js';

let failures = 0;
function assert(cond, name) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.error(`  ✗ FAIL: ${name}`);
  }
}

console.log('== 分词 ==');
const tokens = tokenize('我记得上次讨论过 DeepSeek 的记忆插件和 SQLite 存储');
assert(tokens.has('deepseek'), '拉丁词小写分词');
assert(tokens.has('记忆'), 'CJK 二元组（记忆）');
assert(tokens.has('忆插'), 'CJK 二元组（忆插）');
assert(tokens.size > 5, '分词数量足够');

console.log('== 存储 CRUD ==');
const store = new MemoryStore(':memory:');
const id1 = store.add({ content: '用户喜欢用中文交流，偏好简洁回答', category: 'self', importance: 0.9, tags: ['偏好', 'user'] });
const id2 = store.add({ content: '2026 年 8 月讨论了记忆插件架构', category: 'situation', importance: 0.7, tags: ['项目'] });
const id3 = store.add({ content: 'DeepSeek Harness 是 Cordis 插件系统', category: 'knowledge', importance: 0.8 });
assert(typeof id1 === 'number' && id1 > 0, 'add 返回数字 id');

const m1 = store.get(id1);
assert(m1 && m1.content.includes('中文'), 'get 读回内容');
assert(m1 && m1.category === 'self' && m1.tags.length === 2, 'get 读回分类/标签');
assert(m1 && CATEGORY_LABELS[m1.category] === '自我层', '分类中文标签');

const updated = store.update(id1, { content: '用户喜欢用中文交流，偏好简洁回答（更新）', importance: 0.5 });
assert(updated && updated.content.includes('更新') && updated.importance === 0.5, 'update 修改内容+重要度');
assert(updated && updated.updatedAt >= updated.createdAt, 'update 刷新 updatedAt');

const unchanged = store.update(id2, {});
assert(unchanged && unchanged.content.includes('记忆插件架构'), '空 patch 返回原记忆');

let threw = false;
try {
  store.add({ content: '', category: 'knowledge' });
} catch {
  threw = true;
}
assert(threw, '空内容抛错');

threw = false;
try {
  store.update(id1, { category: 'bogus' });
} catch {
  threw = true;
}
assert(threw, '非法分类抛错');

const list = store.list({ limit: 10 });
assert(list.length === 3, `list 返回全部（${list.length}）`);
const filtered = store.list({ category: 'self' });
assert(filtered.length === 1 && filtered[0].id === id1, 'list 按分类过滤');
const kw = store.list({ keyword: '记忆插件' });
assert(kw.length >= 1, 'list 按关键词过滤');

console.log('== 召回 ==');
const hits = recall(store, '用户喜欢用什么语言交流？', { topK: 5, minScore: 0.2 });
assert(hits.length >= 1, `recall 命中相关记忆（${hits.length} 条）`);
assert(hits[0].memory.id === id1, '最相关记忆排第一（self 偏好）');
assert(hits[0].score > 0, '分数为正');

const noHits = recall(store, '量子物理与弦论的关系', { topK: 5, minScore: 0.4 });
assert(noHits.length === 0, '无关查询不召回');

const top2 = recall(store, '记忆 插件 讨论', { topK: 2, minScore: 0.1 });
assert(top2.length <= 2, `topK 限制生效（${top2.length}）`);

console.log('== 加载记录 ==');
store.recordLoad('session-abc', id1, 0.83);
store.recordLoad('session-abc', id2, 0.71);
store.recordLoad('session-xyz', id1, 0.9);
const loaded = store.loadedForSession('session-abc');
assert(loaded.length === 2, `loadedForSession 返回 2 条（${loaded.length}）`);
assert(loaded[0].memoryId === id2, '按时间倒序（最新在前）');
const stats = store.stats();
assert(stats.total === 3, 'stats 总数正确');
assert(stats.byCategory['self'] === 1, 'stats 分类计数正确');
assert(stats.recentLoads.length === 3, 'stats 最近加载记录正确');
assert(stats.topLoaded[0].memoryId === id1 && stats.topLoaded[0].count === 2, 'stats 最常加载正确');

const del = store.delete(id3);
assert(del === true, 'delete 成功');
assert(store.get(id3) === undefined, 'delete 后读不到');
assert(store.delete(id3) === false, '重复 delete 返回 false');

const m1after = store.get(id1);
assert(m1after.accessCount === 2, `accessCount 累计正确（${m1after.accessCount}）`);
assert(m1after.lastAccessedAt !== null, 'lastAccessedAt 已更新');

console.log('== 三层作用域 ==');
// 旧数据迁移：开一个新文件库，先插入不带 scope 的原始 schema 行不可行（新 schema 直接带列），
// 这里验证行为语义：add 默认 session 级。
const sid = 'session-A';
const g = store.add({ content: '全局偏好：用户要求回答简洁', category: 'self', importance: 0.9, scope: 'global' });
const w = store.add({ content: '工作区约定：插件统一用 TypeScript', category: 'structure', scope: 'workspace', workspaceId: 'ws-1' });
const sA = store.add({ content: '会话 A 的临时笔记', category: 'situation', scope: 'session', sessionId: sid });
const sDefault = store.add({ content: '默认层级应该是会话级', category: 'knowledge' });
assert(store.get(g).scope === 'global' && store.get(g).workspaceId === null, 'global 记忆无归属 id');
assert(store.get(w).workspaceId === 'ws-1', 'workspace 记忆带工作区 id');
assert(store.get(sA).sessionId === sid, 'session 记忆带会话 id');
assert(store.get(sDefault).scope === 'session' && store.get(sDefault).sessionId === null, 'add 默认 session 级（未绑定）');

let scopeThrew = false;
try {
  store.add({ content: 'x', scope: 'workspace' });
} catch {
  scopeThrew = true;
}
assert(scopeThrew, 'workspace 记忆缺工作区抛错');

const visibleA = store.listVisible({ sessionId: sid, workspaceId: 'ws-1' });
const visibleIds = new Set(visibleA.map((m) => m.id));
assert(visibleIds.has(g) && visibleIds.has(w) && visibleIds.has(sA), '可见集 = 全局 + 本工作区 + 本会话');
// 过滤条件必须 AND 到可见集上（而不是 OR 进去）
const visibleFiltered = store.listVisible({ sessionId: sid, workspaceId: 'ws-1', category: 'structure' });
assert(visibleFiltered.length === 1 && visibleFiltered[0].id === w, 'listVisible 过滤与可见集取交集');
const visibleKw = store.listVisible({ sessionId: sid, workspaceId: 'ws-1', keyword: '临时笔记' });
assert(visibleKw.every((m) => m.content.includes('临时笔记')), 'listVisible 关键词过滤生效');
// 无上下文的窄化查询不能泄露其他工作区/会话
assert(store.listVisible({ sessionId: null, workspaceId: null, scope: 'workspace' }).length === 0, '无工作区上下文时 workspace 窄化返回空');
assert(store.listVisible({ sessionId: null, workspaceId: null, scope: 'session' }).length === 0, '无会话上下文时 session 窄化返回空');
assert(store.listVisible({ sessionId: sid, workspaceId: null, scope: 'workspace' }).length === 0, '会话不属于任何工作区时 workspace 窄化返回空');
const sB = store.add({ content: '会话 B 的临时笔记', category: 'situation', scope: 'session', sessionId: 'session-B' });
const visibleB = store.listVisible({ sessionId: 'session-B', workspaceId: 'ws-1' });
assert(visibleB.some((m) => m.id === sB) && !visibleB.some((m) => m.id === sA), '其他会话的会话级记忆不可见');
const visibleNoWs = store.listVisible({ sessionId: 'session-B' });
assert(!visibleNoWs.some((m) => m.id === w), '无工作区上下文时工作区记忆不可见');

// 层级迁移
const moved = store.update(sA, { scope: 'global' });
assert(moved.scope === 'global' && moved.sessionId === null, '迁移到 global 清空归属');
const moved2 = store.update(g, { scope: 'workspace', workspaceId: 'ws-2' });
assert(moved2.workspaceId === 'ws-2', '迁移到 workspace 绑定新工作区');
const moved3 = store.update(moved2.id, { scope: 'session', sessionId: 'session-C' });
assert(moved3.scope === 'session' && moved3.sessionId === 'session-C', '迁移到 session 绑定会话');

// 召回按可见范围过滤
const recallHit = recall(store, '会话 A 的临时笔记', { topK: 5, minScore: 0.2, sessionId: 'session-X', workspaceId: 'ws-9' });
assert(recallHit.some((r) => r.memory.id === moved.id), 'global 记忆对任意会话可见（迁移后）');
const recallWs = recall(store, '插件统一用 TypeScript', { topK: 5, minScore: 0.2, sessionId: 'session-X', workspaceId: 'ws-1' });
assert(recallWs.some((r) => r.memory.id === w), '同工作区会话可见工作区记忆');
const recallWsMiss = recall(store, '插件统一用 TypeScript', { topK: 5, minScore: 0.2, sessionId: 'session-X', workspaceId: 'ws-other' });
assert(!recallWsMiss.some((r) => r.memory.id === w), '其他工作区看不到该工作区记忆');
const recallSess = recall(store, '会话 B 的临时笔记', { topK: 5, minScore: 0.2, sessionId: 'session-B', workspaceId: 'ws-1' });
assert(recallSess.some((r) => r.memory.id === sB), '本会话可见自己的会话级记忆');
const recallSessMiss = recall(store, '会话 B 的临时笔记', { topK: 5, minScore: 0.2, sessionId: 'session-A', workspaceId: 'ws-1' });
assert(!recallSessMiss.some((r) => r.memory.id === sB), '其他会话看不到会话级记忆');

const stats2 = store.stats();
assert(stats2.byScope && stats2.byScope['global'] >= 1 && stats2.byScope['session'] >= 2, 'stats 按作用域计数正确');

// 工具输出要求 lossless JSON：记忆对象 JSON 往返后字段不得丢失（undefined 会触发工具系统报错）
const roundTrip = JSON.parse(JSON.stringify(store.get(moved.id)));
assert(roundTrip.workspaceId === null && roundTrip.sessionId === null && 'scope' in roundTrip && 'workspaceId' in roundTrip, '记忆对象可无损 JSON 序列化');

store.close();
console.log(failures === 0 ? '\n== 全部通过 ==' : `\n== ${failures} 项失败 ==`);
process.exit(failures === 0 ? 0 : 1);
