/**
 * dsh-agent-factory —— 模板持久化存储（JSON 文件）
 *
 * 每个 Agent 模板是一条记录，保存在 <statePath> 指向的 JSON 文件里：
 * {
 *   "version": 1,
 *   "agents": {
 *     "<id>": {
 *       id, name, description, persona,
 *       provider, model, maxTokens,      // 空 = 继承调用方（父 agent）的路由
 *       inheritContext,                  // true → fork provider（继承父对话），false → spawn（全新上下文）
 *       toolFilter: { allow[], deny[] }, // 可选，限制子智能体可用的工具
 *       maxDepth,                        // 0 = 不限制（provider-managed）
 *       usageCount, createdAt, updatedAt, lastUsedAt
 *     }
 *   }
 * }
 *
 * 写入使用 dsh-atomic-write 的 writeFileAtomic（先写临时文件再 rename，
 * 读者要么看到旧内容要么看到完整新内容，不会读到写一半的 JSON）。
 */
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write';

/** 模板 id 必须可作 JSON 键且便于模型输入：小写字母/数字/中划线/下划线。 */
export const AGENT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** 默认存储路径：<home>/.dsh/agent-factory/agents.json */
export function defaultStatePath() {
  return join(homedir(), '.dsh', 'agent-factory', 'agents.json');
}

/** 规范化 id：小写、非字母数字转 '-'、压缩连续分隔符。中文名退化为空时返回 undefined。 */
export function normalizeId(name) {
  const id = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return AGENT_ID_RE.test(id) ? id : undefined;
}

/** 单个模板的初始形态（不含统计字段）。 */
export function blankAgent() {
  return {
    id: '',
    name: '',
    description: '',
    persona: '',
    provider: '',
    model: '',
    maxTokens: 0,
    inheritContext: false,
    toolFilter: { allow: [], deny: [] },
    maxDepth: 0,
  };
}

/** 清理并校验用户/模型提交的模板字段，返回可直接入库的规范记录（不处理 id 冲突）。 */
export function sanitizeAgent(input) {
  const src = input && typeof input === 'object' ? input : {};
  const text = (v, max) => {
    if (typeof v !== 'string') return '';
    const s = v.trim();
    return s.length > max ? s.slice(0, max) : s;
  };
  const num = (v, min, max) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= min && n <= max ? Math.round(n) : 0;
  };
  const filter = src.toolFilter && typeof src.toolFilter === 'object' ? src.toolFilter : {};
  const allow = Array.isArray(filter.allow) ? filter.allow.map((x) => String(x).trim()).filter(Boolean).slice(0, 100) : [];
  const deny = Array.isArray(filter.deny) ? filter.deny.map((x) => String(x).trim()).filter(Boolean).slice(0, 100) : [];
  return {
    id: text(src.id, 64),
    name: text(src.name, 64),
    description: text(src.description, 500),
    persona: text(src.persona, 20000),
    provider: text(src.provider, 64),
    model: text(src.model, 128),
    maxTokens: num(src.maxTokens, 1, 100000000),
    inheritContext: src.inheritContext === true,
    toolFilter: allow.length > 0 || deny.length > 0 ? { allow, deny } : { allow: [], deny: [] },
    maxDepth: num(src.maxDepth, 1, 1000),
  };
}

/** 由名称派生一个可用的模板 id（冲突时追加短后缀）。 */
export function deriveId(store, name) {
  const base = normalizeId(name) || 'agent';
  let id = base;
  let n = 2;
  while (store.data.agents[id]) {
    id = `${base}-${n}`;
    n += 1;
    if (n > 1000) break;
  }
  return id;
}

export class AgentStore {
  constructor(path) {
    this.path = path;
    this.data = { version: 1, agents: {} };
  }

  async load() {
    try {
      const raw = await readFile(this.path, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.agents && typeof parsed.agents === 'object') {
        this.data = { version: 1, agents: parsed.agents };
      } else {
        this.data = { version: 1, agents: {} };
      }
    } catch (err) {
      // 文件不存在 / 内容损坏：从空库开始（不覆盖磁盘，直到下一次保存）
      this.data = { version: 1, agents: {} };
    }
    return this;
  }

  async persist() {
    await writeFileAtomic(this.path, JSON.stringify(this.data, null, 2) + '\n', { mode: 0o600, dirMode: 0o700 });
  }

  list() {
    return Object.values(this.data.agents).sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id, 'zh'));
  }

  get(id) {
    return this.data.agents[id] || undefined;
  }

  findByName(name) {
    const q = String(name || '').trim().toLowerCase();
    if (!q) return undefined;
    const exact = this.data.agents[q];
    if (exact) return exact;
    for (const agent of Object.values(this.data.agents)) {
      if (agent.name.toLowerCase() === q) return agent;
    }
    return undefined;
  }

  /**
   * upsert：按 id（或同名名称）匹配更新，否则新建（id 缺失时从 name 派生）。
   * @param input 模板字段
   * @param opts.partial 部分更新：input 中未提供的字段保持原值（供 Agent 工具
   *   增量编辑使用）；false 表示全量替换（供面板表单使用，空字符串即清除）。
   */
  upsert(input, { partial = false } = {}) {
    const src = input && typeof input === 'object' ? input : {};
    const agent = sanitizeAgent(src);
    if (!agent.id && !agent.name) throw new Error('缺少模板 id 或名称');
    const now = Date.now();
    const existing = agent.id && this.data.agents[agent.id]
      ? this.data.agents[agent.id]
      : agent.name ? this.findByName(agent.name) : undefined;
    if (existing) {
      const merged = partial
        ? this.mergePartial(existing, src, agent, now)
        : this.mergeFull(existing, agent, now);
      this.data.agents[merged.id] = merged;
      return { agent: merged, created: false };
    }
    const id = agent.id || deriveId(this, agent.name);
    if (!AGENT_ID_RE.test(id)) throw new Error(`模板 id「${id}」不合法（只能包含小写字母/数字/中划线/下划线，且不能以中划线或下划线开头）`);
    const created = {
      ...agent,
      id,
      name: agent.name || id,
      usageCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    if (!(created.toolFilter && (created.toolFilter.allow.length > 0 || created.toolFilter.deny.length > 0))) {
      delete created.toolFilter;
    }
    this.data.agents[created.id] = created;
    return { agent: created, created: true };
  }

  /** 全量替换合并：面板表单语义，空字段即清除。 */
  mergeFull(existing, agent, now) {
    const merged = {
      ...existing,
      ...agent,
      id: agent.id || existing.id,
      name: agent.name || existing.name,
      usageCount: existing.usageCount || 0,
      createdAt: existing.createdAt || now,
      updatedAt: now,
    };
    if (!(merged.toolFilter && (merged.toolFilter.allow.length > 0 || merged.toolFilter.deny.length > 0))) {
      delete merged.toolFilter;
    }
    return merged;
  }

  /** 部分合并：工具增量编辑语义，未提供的字段保持原值。 */
  mergePartial(existing, src, agent, now) {
    const merged = { ...existing };
    const applyScalar = (key) => {
      if (src[key] === undefined) return;
      merged[key] = agent[key];
    };
    for (const key of ['name', 'description', 'persona', 'provider', 'model', 'maxTokens', 'inheritContext', 'maxDepth']) {
      applyScalar(key);
    }
    if (src.toolFilter !== undefined) {
      if (agent.toolFilter && (agent.toolFilter.allow.length > 0 || agent.toolFilter.deny.length > 0)) {
        merged.toolFilter = agent.toolFilter;
      } else {
        delete merged.toolFilter;
      }
    }
    if (src.id !== undefined && agent.id) merged.id = agent.id;
    merged.usageCount = existing.usageCount || 0;
    merged.createdAt = existing.createdAt || now;
    merged.updatedAt = now;
    return merged;
  }

  remove(id) {
    if (!this.data.agents[id]) return false;
    delete this.data.agents[id];
    return true;
  }

  bumpUsage(id) {
    const agent = this.data.agents[id];
    if (!agent) return;
    agent.usageCount = (agent.usageCount || 0) + 1;
    agent.lastUsedAt = Date.now();
  }

  async existsOnDisk() {
    try {
      return (await stat(this.path)).isFile();
    } catch {
      return false;
    }
  }
}
