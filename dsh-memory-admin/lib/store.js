/**
 * dsh-memory-admin —— 记忆存储层
 *
 * 基于 Node 内置 node:sqlite（无需任何外部依赖）。
 * 记忆库 schema 设计为五层记忆模块（与灵枢 AEIS 对齐）：
 *   anchor    锚点层（基础事实、身份设定）
 *   structure 结构层（流程、方法论、知识结构）
 *   knowledge 知识层（事实性知识、对话沉淀）
 *   situation 情境层（具体场景、事件、上下文）
 *   self      自我层（自我认知、偏好、反思）
 *
 * 每条记忆另有一个三级"作用域"（scope），决定它会被哪些会话加载：
 *   global    全局记忆：所有会话都会加载（用户偏好、长期事实等，需显式指定）
 *   workspace 工作区记忆：仅该工作区下的会话会加载（需显式指定）
 *   session   会话记忆：仅该会话会加载（默认层级）
 *
 * 另维护 memory_loads 表：记录每次会话加载了哪些记忆（审计 + "已加载"查询）。
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

export const CATEGORIES = ['anchor', 'structure', 'knowledge', 'situation', 'self'];

export const CATEGORY_LABELS = {
  anchor: '锚点层',
  structure: '结构层',
  knowledge: '知识层',
  situation: '情境层',
  self: '自我层',
};

/** 记忆作用域：全局 / 工作区 / 会话。 */
export const SCOPES = ['global', 'workspace', 'session'];

export const SCOPE_LABELS = {
  global: '全局',
  workspace: '工作区',
  session: '会话',
};

export const SCOPE_DESCRIPTIONS = {
  global: '全局记忆：所有对话都会加载（适合放用户偏好、长期事实）',
  workspace: '工作区记忆：仅该工作区下的会话会加载',
  session: '会话记忆：仅当前会话会加载（默认）',
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'knowledge',
  importance REAL NOT NULL DEFAULT 0.6,
  tags TEXT NOT NULL DEFAULT '[]',
  scope TEXT NOT NULL DEFAULT 'session',
  workspace_id TEXT,
  session_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  access_count INTEGER NOT NULL DEFAULT 0,
  last_accessed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
CREATE INDEX IF NOT EXISTS idx_memories_updated ON memories(updated_at);

CREATE TABLE IF NOT EXISTS memory_loads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  memory_id INTEGER NOT NULL,
  score REAL NOT NULL DEFAULT 0,
  loaded_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_loads_session ON memory_loads(session_id);
CREATE INDEX IF NOT EXISTS idx_loads_memory ON memory_loads(memory_id);
`;

/** 把旧库升级到带作用域的 schema；旧记忆一律迁移为"全局"（保持迁移前到处可见的行为）。
 *  逐列检查/补齐，避免中途部分迁移（如已有 scope 但缺归属列）导致后续 ALTER 报错。 */
function migrateScopeColumns(db) {
  const cols = new Set(db.prepare('PRAGMA table_info(memories)').all().map((c) => c.name));
  const hadScope = cols.has('scope');
  if (!hadScope) {
    db.exec(`ALTER TABLE memories ADD COLUMN scope TEXT NOT NULL DEFAULT 'session'`);
  }
  if (!cols.has('workspace_id')) {
    db.exec(`ALTER TABLE memories ADD COLUMN workspace_id TEXT`);
  }
  if (!cols.has('session_id')) {
    db.exec(`ALTER TABLE memories ADD COLUMN session_id TEXT`);
  }
  if (!hadScope) {
    // 旧数据没有归属信息，按"全局"处理，保证迁移前可被任何会话召回的行为不丢。
    db.exec(`UPDATE memories SET scope = 'global', workspace_id = NULL, session_id = NULL`);
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope);
    CREATE INDEX IF NOT EXISTS idx_memories_workspace ON memories(scope, workspace_id);
    CREATE INDEX IF NOT EXISTS idx_memories_session ON memories(scope, session_id);
  `);
}

/** 归一化重要度：有限数值钳制到 [0,1]，非法值用默认值兜底。 */
function normalizeImportance(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

function normalizeTags(tags) {
  if (tags === undefined || tags === null) return '[]';
  if (Array.isArray(tags)) {
    const clean = tags.filter((t) => typeof t === 'string' && t.length > 0);
    return JSON.stringify([...new Set(clean)]);
  }
  if (typeof tags === 'string') {
    try {
      const parsed = JSON.parse(tags);
      return normalizeTags(parsed);
    } catch {
      return JSON.stringify(tags.split(/[,，;；\s]+/).filter(Boolean));
    }
  }
  return '[]';
}

/**
 * 归一化作用域信息。
 * - scope ∈ global | workspace | session，默认 session；
 * - global 不携带归属 id；workspace 需要 workspaceId；session 需要 sessionId（允许为空，表示"未绑定会话"，不会被自动召回）。
 */
export function normalizeScope({ scope, workspaceId, sessionId } = {}) {
  const s = SCOPES.includes(scope) ? scope : 'session';
  if (s === 'global') return { scope: 'global', workspaceId: undefined, sessionId: undefined };
  if (s === 'workspace') {
    const ws = workspaceId !== undefined && workspaceId !== null && String(workspaceId).trim() !== ''
      ? String(workspaceId).trim()
      : undefined;
    if (ws === undefined) throw new Error('工作区记忆必须指定工作区（workspaceId）');
    return { scope: 'workspace', workspaceId: ws, sessionId: undefined };
  }
  const sess = sessionId !== undefined && sessionId !== null && String(sessionId).trim() !== ''
    ? String(sessionId).trim()
    : undefined;
  return { scope: 'session', workspaceId: undefined, sessionId: sess };
}

function parseTags(raw) {
  try {
    const parsed = JSON.parse(raw ?? '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function toMemory(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    content: row.content,
    category: row.category,
    importance: row.importance,
    tags: parseTags(row.tags),
    scope: row.scope ?? 'session',
    // 注意：用 null 而非 undefined —— 工具输出要求 lossless JSON，undefined 字段会被判定非法
    workspaceId: row.workspace_id ?? null,
    sessionId: row.session_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    accessCount: row.access_count,
    lastAccessedAt: row.last_accessed_at,
  };
}

/** 解析 dbPath：相对路径基于 process.cwd()（与 dsh-memory 默认行为一致）。 */
export function resolveDbPath(dbPath) {
  if (dbPath === ':memory:') return dbPath;
  const p = isAbsolute(dbPath) ? dbPath : resolve(process.cwd(), dbPath);
  return p;
}

export class MemoryStore {
  constructor(dbPath) {
    const resolved = resolveDbPath(dbPath);
    if (resolved !== ':memory:') {
      mkdirSync(dirname(resolved), { recursive: true });
    }
    this.dbPath = resolved;
    this.db = new DatabaseSync(resolved);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec(SCHEMA);
    migrateScopeColumns(this.db);
  }

  close() {
    try {
      this.db.close();
    } catch {
      /* 已关闭则忽略 */
    }
  }

  // ---- 基础 CRUD ----

  /**
   * 新增一条记忆，返回新 id。
   * scope：'global'（所有会话）｜'workspace'（需 workspaceId）｜'session'（需 sessionId，默认）。
   */
  add({ content, category = 'knowledge', importance = 0.6, tags = [], scope = 'session', workspaceId, sessionId }) {
    if (typeof content !== 'string' || content.trim().length === 0) {
      throw new Error('记忆内容不能为空');
    }
    if (!CATEGORIES.includes(category)) {
      throw new Error(`分类必须是以下之一：${CATEGORIES.join(', ')}`);
    }
    const target = normalizeScope({ scope, workspaceId, sessionId });
    const now = Date.now();
    const stmt = this.db.prepare(
      'INSERT INTO memories (content, category, importance, tags, scope, workspace_id, session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const result = stmt.run(
      content.trim(),
      category,
      normalizeImportance(importance, 0.6),
      normalizeTags(tags),
      target.scope,
      target.workspaceId ?? null,
      target.sessionId ?? null,
      now,
      now,
    );
    return Number(result.lastInsertRowid);
  }

  /** 按 id 读取一条记忆。 */
  get(id) {
    const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id);
    return toMemory(row);
  }

  /** 更新记忆（只更新传入的字段），返回更新后的记忆。 */
  update(id, patch) {
    const existing = this.get(id);
    if (!existing) return undefined;
    const fields = [];
    const values = [];
    if (patch.content !== undefined) {
      if (typeof patch.content !== 'string' || patch.content.trim().length === 0) {
        throw new Error('记忆内容不能为空');
      }
      fields.push('content = ?');
      values.push(patch.content.trim());
    }
    if (patch.category !== undefined) {
      if (!CATEGORIES.includes(patch.category)) {
        throw new Error(`分类必须是以下之一：${CATEGORIES.join(', ')}`);
      }
      fields.push('category = ?');
      values.push(patch.category);
    }
    if (patch.importance !== undefined) {
      fields.push('importance = ?');
      values.push(normalizeImportance(patch.importance, 0));
    }
    if (patch.tags !== undefined) {
      fields.push('tags = ?');
      values.push(normalizeTags(patch.tags));
    }
    // 作用域：仅当显式传入 scope 时才迁移层级；切换层级时按新层级重算归属 id。
    if (patch.scope !== undefined) {
      const base = patch.scope === existing.scope
        ? { scope: patch.scope, workspaceId: patch.workspaceId ?? existing.workspaceId, sessionId: patch.sessionId ?? existing.sessionId }
        : { scope: patch.scope, workspaceId: patch.workspaceId, sessionId: patch.sessionId };
      const target = normalizeScope(base);
      fields.push('scope = ?', 'workspace_id = ?', 'session_id = ?');
      values.push(target.scope, target.workspaceId ?? null, target.sessionId ?? null);
    } else if (patch.workspaceId !== undefined || patch.sessionId !== undefined) {
      // 未换层级但修正归属 id
      const target = normalizeScope({
        scope: existing.scope,
        workspaceId: patch.workspaceId ?? existing.workspaceId,
        sessionId: patch.sessionId ?? existing.sessionId,
      });
      fields.push('workspace_id = ?', 'session_id = ?');
      values.push(target.workspaceId ?? null, target.sessionId ?? null);
    }
    if (fields.length === 0) return existing;
    fields.push('updated_at = ?');
    values.push(Date.now());
    values.push(id);
    this.db.prepare(`UPDATE memories SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    return this.get(id);
  }

  /** 删除一条记忆，返回是否删除成功。 */
  delete(id) {
    const result = this.db.prepare('DELETE FROM memories WHERE id = ?').run(id);
    return Number(result.changes) > 0;
  }

  /** 按内容精确去重检查：存在相同内容的记忆时返回其 id。 */
  findDuplicate(content) {
    const row = this.db.prepare('SELECT id FROM memories WHERE content = ? LIMIT 1').get(content.trim());
    return row ? Number(row.id) : undefined;
  }

  // ---- 查询 ----

  /** 列出记忆，支持分类 / 关键词 / 标签 / 作用域过滤，按 updated_at 或创建时间倒序。 */
  list({ category, keyword, tag, scope, workspaceId, sessionId, limit = 50, offset = 0, order = 'updated' } = {}) {
    const where = [];
    const values = [];
    if (category) {
      where.push('category = ?');
      values.push(category);
    }
    if (keyword && keyword.trim()) {
      where.push('content LIKE ?');
      values.push(`%${keyword.trim()}%`);
    }
    if (tag && tag.trim()) {
      where.push('tags LIKE ?');
      values.push(`%${tag.trim()}%`);
    }
    if (SCOPES.includes(scope)) {
      where.push('scope = ?');
      values.push(scope);
      if (scope === 'workspace' && workspaceId) {
        where.push('workspace_id = ?');
        values.push(workspaceId);
      }
      if (scope === 'session' && sessionId) {
        where.push('session_id = ?');
        values.push(sessionId);
      }
    }
    const orderClause = order === 'created' ? 'created_at DESC' : 'updated_at DESC';
    const sql = `SELECT * FROM memories ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${orderClause} LIMIT ? OFFSET ?`;
    const rows = this.db.prepare(sql).all(...values, limit, offset);
    return rows.map(toMemory);
  }

  /**
   * 对话开始时的注入候选：全局记忆 + 当前工作区记忆（不含会话记忆），
   * 按重要度降序（同重要度按更新时间降序）。上限默认 100，防注入膨胀。
   */
  listInjectionCandidates({ workspaceId, limit = 100 } = {}) {
    const where = ['scope = ?'];
    const values = ['global'];
    if (workspaceId) {
      where.push('(scope = ? AND workspace_id = ?)');
      values.push('workspace', workspaceId);
    }
    const sql = `SELECT * FROM memories WHERE ${where.join(' OR ')} ORDER BY importance DESC, updated_at DESC LIMIT ?`;
    const rows = this.db.prepare(sql).all(...values, limit);
    return rows.map(toMemory);
  }

  /**
   * 列出某个会话"可见"的记忆：全局 + 该会话所属工作区 + 该会话自身。
   * workspaceId 为 null/undefined 时只含全局与会话级。
   * 支持分类/关键词/标签过滤；传 scope 时进一步限定为该作用域。
   */
  listVisible({ sessionId, workspaceId, category, keyword, tag, scope, limit = 1000, offset = 0, order = 'updated' } = {}) {
    const scoped = SCOPES.includes(scope) ? scope : undefined;
    const visWhere = [];
    const visValues = [];
    if (scoped === 'global') {
      visWhere.push('scope = ?');
      visValues.push('global');
    } else if (scoped === 'workspace') {
      if (!workspaceId) return []; // 无工作区上下文时不泄露其他工作区的记忆
      visWhere.push('scope = ? AND workspace_id = ?');
      visValues.push('workspace', workspaceId);
    } else if (scoped === 'session') {
      if (!sessionId) return []; // 无会话上下文时不泄露其他会话的记忆
      visWhere.push('scope = ? AND session_id = ?');
      visValues.push('session', sessionId);
    } else {
      visWhere.push('scope = ?');
      visValues.push('global');
      if (workspaceId) {
        visWhere.push('(scope = ? AND workspace_id = ?)');
        visValues.push('workspace', workspaceId);
      }
      if (sessionId) {
        visWhere.push('(scope = ? AND session_id = ?)');
        visValues.push('session', sessionId);
      }
    }
    const filterWhere = [];
    const filterValues = [];
    if (category) {
      filterWhere.push('category = ?');
      filterValues.push(category);
    }
    if (keyword && keyword.trim()) {
      filterWhere.push('content LIKE ?');
      filterValues.push(`%${keyword.trim()}%`);
    }
    if (tag && tag.trim()) {
      filterWhere.push('tags LIKE ?');
      filterValues.push(`%${tag.trim()}%`);
    }
    const orderClause = order === 'created' ? 'created_at DESC' : 'updated_at DESC';
    const sql = `SELECT * FROM memories WHERE (${visWhere.join(' OR ')})${filterWhere.length ? ` AND ${filterWhere.join(' AND ')}` : ''} ORDER BY ${orderClause} LIMIT ? OFFSET ?`;
    const rows = this.db.prepare(sql).all(...visValues, ...filterValues, limit, offset);
    return rows.map(toMemory);
  }

  /** 统计：总数、各分类数量、各作用域数量、最近加载记录。 */
  stats({ limit = 10 } = {}) {
    const total = this.db.prepare('SELECT COUNT(*) AS n FROM memories').get().n;
    const byCategory = this.db.prepare('SELECT category, COUNT(*) AS n FROM memories GROUP BY category').all();
    const byScope = this.db.prepare('SELECT scope, COUNT(*) AS n FROM memories GROUP BY scope').all();
    const recentLoads = this.db
      .prepare('SELECT * FROM memory_loads ORDER BY loaded_at DESC LIMIT ?')
      .all(limit)
      .map((row) => ({
        id: row.id,
        sessionId: row.session_id,
        memoryId: row.memory_id,
        score: row.score,
        loadedAt: row.loaded_at,
      }));
    const topLoaded = this.db
      .prepare(
        `SELECT memory_id, COUNT(*) AS n FROM memory_loads GROUP BY memory_id ORDER BY n DESC LIMIT ?`,
      )
      .all(limit)
      .map((row) => ({ memoryId: row.memory_id, count: row.n }));
    const categoryMap = {};
    for (const row of byCategory) categoryMap[row.category] = row.n;
    const scopeMap = {};
    for (const row of byScope) scopeMap[row.scope] = row.n;
    return { total, byCategory: categoryMap, byScope: scopeMap, recentLoads, topLoaded };
  }

  // ---- 加载记录（可见性审计）----

  /** 记录一次记忆加载。 */
  recordLoad(sessionId, memoryId, score) {
    this.db.prepare('INSERT INTO memory_loads (session_id, memory_id, score, loaded_at) VALUES (?, ?, ?, ?)').run(
      String(sessionId ?? 'unknown'),
      memoryId,
      Number(score) || 0,
      Date.now(),
    );
    this.db.prepare('UPDATE memories SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?').run(
      Date.now(),
      memoryId,
    );
  }

  /** 查询某个会话加载过的记忆（按时间倒序）。 */
  loadedForSession(sessionId, { limit = 50 } = {}) {
    const rows = this.db
      .prepare(
        `SELECT l.*, m.content, m.category, m.importance, m.scope, m.workspace_id, m.session_id FROM memory_loads l
         JOIN memories m ON m.id = l.memory_id
         WHERE l.session_id = ? ORDER BY l.loaded_at DESC, l.id DESC LIMIT ?`,
      )
      .all(String(sessionId ?? 'unknown'), limit);
    return rows.map((row) => ({
      loadId: row.id,
      memoryId: row.memory_id,
      score: row.score,
      loadedAt: row.loaded_at,
      content: row.content,
      category: row.category,
      importance: row.importance,
      scope: row.scope ?? 'session',
      workspaceId: row.workspace_id ?? null,
      sessionId: row.session_id ?? null,
    }));
  }

  /** 查询一条记忆的全部加载历史。 */
  loadHistory(memoryId, { limit = 20 } = {}) {
    const rows = this.db
      .prepare('SELECT * FROM memory_loads WHERE memory_id = ? ORDER BY loaded_at DESC LIMIT ?')
      .all(memoryId, limit);
    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      score: row.score,
      loadedAt: row.loaded_at,
    }));
  }
}
