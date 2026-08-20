// 查看最近加载记录归属的会话（只读）
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('C:/Users/20230/.dsh/profiles/desktop/data/memory-admin.db', { readOnly: true });
const rows = db.prepare(
  "SELECT id, session_id, memory_id, loaded_at FROM memory_loads ORDER BY loaded_at DESC LIMIT 10",
).all();
for (const r of rows) {
  console.log(new Date(r.loaded_at).toLocaleTimeString('zh-CN', { hour12: false }), '|', r.session_id, '| mem#' + r.memory_id);
}
db.close();
