/**
 * 迁移测试：旧 schema（无 scope 列）→ 新 schema 自动迁移，旧行标记为 global。
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../lib/store.js';

const dir = mkdtempSync(join(tmpdir(), 'mem-migrate-'));
const dbPath = join(dir, 'legacy.db');

// 1. 构造旧 schema 数据库
const legacy = new DatabaseSync(dbPath);
legacy.exec(`
  CREATE TABLE memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'knowledge',
    importance REAL NOT NULL DEFAULT 0.6,
    tags TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    access_count INTEGER NOT NULL DEFAULT 0,
    last_accessed_at INTEGER
  );
  INSERT INTO memories (content, category, importance, tags, created_at, updated_at)
  VALUES ('旧记忆一', 'knowledge', 0.6, '[]', 1, 1), ('旧记忆二', 'self', 0.9, '[]', 2, 2);
`);
legacy.close();

// 2. 用新 MemoryStore 打开 → 触发迁移
const store = new MemoryStore(dbPath);
const rows = store.list({ limit: 10 });
console.log('迁移后行数:', rows.length);
let ok = rows.length === 2;
for (const r of rows) {
  console.log(`  #${r.id} scope=${r.scope} workspaceId=${r.workspaceId ?? '-'} sessionId=${r.sessionId ?? '-'}`);
  if (r.scope !== 'global') ok = false;
}
// 3. 新写入默认会话级，且旧全局记忆对任意会话可见
const newId = store.add({ content: '新记忆', scope: 'session', sessionId: 's1' });
const visible = store.listVisible({ sessionId: 's1', workspaceId: null });
console.log('新记忆 scope:', store.get(newId).scope);
console.log('会话 s1 可见 id:', visible.map((m) => m.id).join(','));
ok = ok && store.get(newId).scope === 'session' && visible.length === 3;

// 4. 部分迁移：已有 scope 列但缺归属列（中途升级中断过的库）也能补齐
const partialDir = mkdtempSync(join(tmpdir(), 'mem-partial-'));
const partialPath = join(partialDir, 'partial.db');
const partial = new DatabaseSync(partialPath);
partial.exec(`
  CREATE TABLE memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'knowledge',
    importance REAL NOT NULL DEFAULT 0.6,
    tags TEXT NOT NULL DEFAULT '[]',
    scope TEXT NOT NULL DEFAULT 'session',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    access_count INTEGER NOT NULL DEFAULT 0,
    last_accessed_at INTEGER
  );
  INSERT INTO memories (content, category, scope, created_at, updated_at)
  VALUES ('部分迁移记忆', 'knowledge', 'global', 1, 1);
`);
partial.close();
const store2 = new MemoryStore(partialPath);
const rows2 = store2.list({ limit: 10 });
console.log('部分迁移行数:', rows2.length, 'scope:', rows2[0].scope);
ok = ok && rows2.length === 1 && rows2[0].scope === 'global' && rows2[0].workspaceId === null && rows2[0].sessionId === null;
store2.close();
rmSync(partialDir, { recursive: true, force: true });

store.close();
rmSync(dir, { recursive: true, force: true });
console.log(ok ? 'MIGRATION OK' : 'MIGRATION FAILED');
process.exit(ok ? 0 : 1);
