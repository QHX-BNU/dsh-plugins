/**
 * dsh-tool-manager —— 状态持久化存储（JSON 文件）
 *
 * 维护两类记录：
 * 1. 自定义工具（customTools）：用户在面板/Agent 中"制作"的工具定义
 *    { id, name, description, parameters, code, enabled, usageCount, ... }
 * 2. 禁用名单（disabled）：被禁用的外部工具名（含自定义工具），
 *    插件启动时对它们重新应用全局 restriction。
 *
 * 文件结构：
 * {
 *   "version": 1,
 *   "customTools": { "<id>": {...} },
 *   "disabled": ["tool_a", "tool_b"]
 * }
 *
 * 写入使用 dsh-atomic-write 的 writeFileAtomic（先写临时文件再 rename，
 * 不会读到写一半的 JSON）。
 */
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write';

/** 工具名规范：小写字母/数字/下划线，且必须以字母开头（模型输入友好）。 */
export const TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;

/** 默认存储路径：<home>/.dsh/tool-manager/state.json */
export function defaultStatePath() {
  return join(homedir(), '.dsh', 'tool-manager', 'state.json');
}

/** 规范化工具名：小写、非字母数字转 '_'、压缩连续分隔符。中文名退化为空时返回 undefined。 */
export function normalizeToolName(name) {
  const id = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return TOOL_NAME_RE.test(id) ? id : undefined;
}

/** 文本字段清理。 */
function text(value, max) {
  if (typeof value !== 'string') return '';
  const s = value.trim();
  return s.length > max ? s.slice(0, max) : s;
}

/** 清理并校验用户/模型提交的自定义工具字段（不处理名字冲突）。 */
export function sanitizeCustomTool(input) {
  const src = input && typeof input === 'object' ? input : {};
  return {
    name: text(src.name, 64),
    description: text(src.description, 500),
    parameters: src.parameters && typeof src.parameters === 'object'
      ? src.parameters
      : {},
    code: text(src.code, 20000),
    enabled: src.enabled !== false,
  };
}

export class ToolManagerStore {
  constructor(path) {
    this.path = path;
    this.data = { version: 1, customTools: {}, disabled: [] };
  }

  async load() {
    try {
      const raw = await readFile(this.path, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        this.data = {
          version: 1,
          customTools: parsed.customTools && typeof parsed.customTools === 'object'
            ? parsed.customTools
            : {},
          disabled: Array.isArray(parsed.disabled) ? parsed.disabled : [],
        };
      }
    } catch {
      // 文件不存在 / 内容损坏：从空状态开始（不覆盖磁盘，直到下一次保存）
      this.data = { version: 1, customTools: {}, disabled: [] };
    }
    return this;
  }

  async persist() {
    const data = JSON.stringify(this.data, null, 2) + '\n';
    // Windows 下 rename 偶发 EPERM（杀软/索引短暂锁定目标），重试几次
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await writeFileAtomic(this.path, data, { mode: 0o600, dirMode: 0o700 });
        return;
      } catch (err) {
        lastErr = err;
        if (err && (err.code === 'EPERM' || err.code === 'EACCES' || err.code === 'EBUSY')) {
          await new Promise((resolve) => setTimeout(resolve, 60 * (attempt + 1)));
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  }

  listCustom() {
    return Object.values(this.data.customTools)
      .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id, 'zh'));
  }

  getCustom(id) {
    return this.data.customTools[id] || undefined;
  }

  findCustomByName(name) {
    const q = String(name || '').trim().toLowerCase();
    if (!q) return undefined;
    const exact = this.data.customTools[q];
    if (exact) return exact;
    for (const tool of Object.values(this.data.customTools)) {
      if ((tool.name || '').toLowerCase() === q) return tool;
    }
    return undefined;
  }

  /** 新增自定义工具（id 由 name 派生，冲突时报错）。 */
  addCustom(input) {
    const tool = sanitizeCustomTool(input);
    if (!tool.name) throw new Error('缺少工具名称');
    const id = normalizeToolName(tool.name);
    if (!id) throw new Error(`工具名「${tool.name}」无法生成合法 id（需包含英文字母/数字）`);
    if (this.data.customTools[id]) throw new Error(`工具「${id}」已存在，请使用其它名称`);
    const now = Date.now();
    const created = {
      ...tool,
      id,
      usageCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.data.customTools[id] = created;
    return created;
  }

  /** 更新自定义工具（按 id 或名称匹配；不存在的记录报错）。 */
  updateCustom(key, input) {
    const existing = this.getCustom(key) || this.findCustomByName(key);
    if (!existing) throw new Error(`找不到自定义工具「${key}」`);
    const tool = sanitizeCustomTool(input);
    if (tool.name && tool.name !== existing.name) {
      const newId = normalizeToolName(tool.name);
      if (!newId) throw new Error(`工具名「${tool.name}」无法生成合法 id（需包含英文字母/数字）`);
      if (newId !== existing.id && this.data.customTools[newId]) {
        throw new Error(`工具「${newId}」已存在，请使用其它名称`);
      }
      delete this.data.customTools[existing.id];
      existing.id = newId;
    }
    if (tool.name) existing.name = tool.name;
    if (tool.description !== undefined) existing.description = tool.description;
    if (tool.parameters !== undefined) existing.parameters = tool.parameters;
    if (tool.code !== undefined) existing.code = tool.code;
    if (tool.enabled !== undefined) existing.enabled = tool.enabled;
    existing.updatedAt = Date.now();
    this.data.customTools[existing.id] = existing;
    return existing;
  }

  removeCustom(id) {
    const tool = this.getCustom(id) || this.findCustomByName(id);
    if (!tool) return false;
    delete this.data.customTools[tool.id];
    this.data.disabled = this.data.disabled.filter((n) => n !== tool.id && n !== tool.name);
    return tool;
  }

  bumpUsage(id) {
    const tool = this.data.customTools[id];
    if (!tool) return;
    tool.usageCount = (tool.usageCount || 0) + 1;
    tool.lastUsedAt = Date.now();
  }

  isDisabled(name) {
    return this.data.disabled.includes(name);
  }

  setDisabled(name, disabled) {
    const list = this.data.disabled;
    const idx = list.indexOf(name);
    const has = idx >= 0;
    if (disabled && !has) list.push(name);
    if (!disabled && has) list.splice(idx, 1);
  }

  async existsOnDisk() {
    try {
      return (await stat(this.path)).isFile();
    } catch {
      return false;
    }
  }
}
