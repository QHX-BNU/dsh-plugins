/**
 * 重启后验证脚本：检查运行中的 dsh-memory-admin 三层作用域是否全部生效。
 * 用法：node test/verify-live.mjs [baseUrl]   （默认 http://127.0.0.1:56256）
 */
const base = process.argv[2] || 'http://127.0.0.1:56256';

let failures = 0;
function ok(cond, name, extra = '') {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures += 1;
    console.error(`  ✗ FAIL: ${name}${extra ? ' | ' + extra : ''}`);
  }
}

async function getJson(path) {
  const res = await fetch(base + path);
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json();
}

console.log(`== 验证 ${base} ==`);

// 1. stats 带 byScope
const stats = (await getJson('/memory-admin/api/stats')).stats;
console.log('stats:', JSON.stringify({ total: stats.total, byCategory: stats.byCategory, byScope: stats.byScope }));
ok(stats && typeof stats.byScope === 'object', 'stats 返回 byScope（三层计数）');
ok(stats.total > 0, `记忆总数 > 0（当前 ${stats.total}）`);

// 2. list 返回 scope 字段
const list = (await getJson('/memory-admin/api/list?limit=500'));
const memories = list.memories || [];
ok(memories.length > 0, `list 返回记忆（${memories.length} 条）`);
const scopes = new Set(memories.map((m) => m.scope));
ok([...scopes].every((s) => ['global', 'workspace', 'session'].includes(s)), `scope 字段合法（实际值: ${[...scopes].join(',')}）`);
const legacy = memories.filter((m) => m.scope === 'global');
console.log(`  迁移结果：全局 ${memories.filter((m) => m.scope === 'global').length} / 工作区 ${memories.filter((m) => m.scope === 'workspace').length} / 会话 ${memories.filter((m) => m.scope === 'session').length}`);
ok(legacy.length > 0, '旧记忆已迁移为全局');

// 3. 写入测试：新增会话级记忆 → 读回 scope=session → 删除清理
let testId;
try {
  const added = await (await fetch(base + '/memory-admin/api/add', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: '__verify-scope-session__', category: 'knowledge', scope: 'session', sessionId: 'verify-test-session' }),
  })).json();
  testId = added.id;
  ok(added.memory && added.memory.scope === 'session' && added.memory.sessionId === 'verify-test-session', 'API add 默认/显式 session 作用域生效');
  const edited = await (await fetch(base + '/memory-admin/api/edit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: testId, scope: 'global' }),
  })).json();
  ok(edited.memory && edited.memory.scope === 'global' && edited.memory.sessionId === null, 'API edit 可迁移层级（session → global）');
  const deleted = await (await fetch(base + '/memory-admin/api/delete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: testId }),
  })).json();
  ok(deleted.ok === true, 'API delete 清理测试记忆成功');
} catch (err) {
  ok(false, 'API 写测试执行成功', String(err && err.message));
  if (testId) {
    try {
      await fetch(base + '/memory-admin/api/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: testId }),
      });
    } catch { /* ignore */ }
  }
}

// 4. 客户端 bundle 是否带三层 UI
const html = await (await fetch(base + '/')).text();
const revMatch = /\/plugins\/dsh-memory-admin\/client\.js\?rev=([a-f0-9]+)/.exec(html);
ok(!!revMatch, 'boot HTML 引用了插件客户端 bundle');
if (revMatch) {
  const js = await (await fetch(base + `/plugins/dsh-memory-admin/client.js?rev=${revMatch[1]}`)).text();
  ok(js.includes('SCOPE_LABELS') && js.includes('scopeChipText') && js.includes('三层作用域'), '客户端 bundle 包含三层作用域 UI');
}

console.log(failures === 0 ? '\n== 线上验证全部通过 ==' : `\n== ${failures} 项失败 ==`);
process.exit(failures === 0 ? 0 : 1);
