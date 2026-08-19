/** 对 live DB 副本执行迁移并打印结果（只读验证，不改动原始库）。 */
import { MemoryStore } from '../lib/store.js';

const dbPath = process.argv[2];
const store = new MemoryStore(dbPath);
const all = store.list({ limit: 500 });
console.log(`总行数: ${all.length}`);
let bad = 0;
for (const m of all) {
  const line = `#${m.id} scope=${m.scope} ws=${m.workspaceId ?? '-'} sess=${(m.sessionId || '-').slice(0, 8)} | ${m.content.slice(0, 40)}`;
  console.log(line);
  if (!['global', 'workspace', 'session'].includes(m.scope)) bad += 1;
}
const s = store.stats();
console.log('stats.byScope =', JSON.stringify(s.byScope));
console.log('stats.total =', s.total);
store.close();
process.exit(bad === 0 ? 0 : 1);
