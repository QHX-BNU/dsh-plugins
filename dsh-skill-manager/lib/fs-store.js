/**
 * dsh-skill-manager —— 文件系统扫描与启用/禁用（服务端）
 *
 * 直接管理 DSH 本地 skills 目录（默认 <dshHome>/skills，即
 * dsh-skill-filesystem 的 user-dsh root）。该目录被官方文件系统 provider
 * 的 watcher 监听，因此这里的任何改动都会自动反映到模型可见的
 * skill catalog 中（无需注册自定义 provider）。
 *
 * 布局约定（与 dsh-skill-filesystem 的发现规则一致）：
 *   - 目录 bundle：<skillsDir>/<name>/SKILL.md
 *   - 扁平文件：  <skillsDir>/<name>.md（frontmatter 必须含 name/description）
 *   - 禁用 = 把 SKILL.md 改名为 SKILL.md.disabled（目录保留、资源保留），
 *     扁平文件 <name>.md 改名为 <name>.md.disabled；
 *     改名的文件不再匹配官方发现规则，catalog 中即消失。
 */
import { readdir, readFile, writeFile, rename, rm, mkdir, stat } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';

export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const BUNDLE_FILE = 'SKILL.md';
const DISABLED_SUFFIX = '.disabled';

/** 默认 skills 根目录：DSH_HOME/skills，兜底 ~/.dsh/skills */
export function defaultSkillsDir() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh');
  return join(home, 'skills');
}

/**
 * 极简 YAML frontmatter 解析（只覆盖 skill 需要的字段）：
 * `---` 包裹的头块，支持 `key: value` 与缩进的嵌套键（invocation）。
 * 返回 { data, body }；无 frontmatter 返回 null；格式错误抛错。
 */
export function parseFrontmatter(text) {
  if (typeof text !== 'string' || !text.startsWith('---')) return null;
  const end = text.indexOf('\n---', 3);
  if (end < 0) throw new Error('frontmatter 未闭合（缺少结尾 ---）');
  const head = text.slice(3, end);
  const body = text.slice(end + 4).replace(/^\r?\n/, '');
  const data = {};
  let section = null;
  const lines = head.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const line = rawLine.trimEnd();
    if (line.trim() === '') continue;
    if (/^\s/.test(line)) {
      // 嵌套键：仅支持 invocation 下的布尔字段
      const m = /^\s+([A-Za-z][\w-]*)\s*:\s*(.+)$/.exec(line);
      if (m && section) data[section][m[1].trim()] = parseScalar(m[2]);
      continue;
    }
    const m = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!m) throw new Error(`无法解析的 frontmatter 行: ${line}`);
    const key = m[1].trim();
    const value = m[2].trim();
    if (value === '') {
      data[key] = {};
      section = key;
      continue;
    }
    // 块标量：> 折叠 / | 字面；- 去掉末尾换行，+ 保留
    if (value === '>' || value === '>-' || value === '>+' || value === '|' || value === '|-' || value === '|+') {
      const literal = value[0] === '|';
      const lines2 = [];
      let j = i + 1;
      while (j < lines.length) {
        const next = lines[j];
        if (next.trim() === '') {
          lines2.push('');
          j += 1;
          continue;
        }
        if (!/^\s/.test(next)) break;
        lines2.push(next.trim());
        j += 1;
      }
      i = j - 1;
      let block = lines2.join('\n').replace(/\n+$/, '');
      if (!literal) block = block.replace(/\n{2,}/g, '\n').replace(/\n/g, ' ');
      data[key] = block;
      section = null;
      continue;
    }
    data[key] = parseScalar(value);
    section = null;
  }
  return { data, body };
}

function parseScalar(raw) {
  const value = raw.trim();
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null' || value === '~') return null;
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  const num = Number(value);
  if (value !== '' && Number.isFinite(num) && !/^[A-Za-z]/.test(value)) return num;
  return value;
}

/** 从 skill 文件文本提取 { name, description, whenToUse, invocation, content }；不合法返回 null。 */
export function parseSkillText(text, logger, path) {
  let parsed;
  try {
    parsed = parseFrontmatter(text);
  } catch (err) {
    logger?.warn?.(`dsh-skill-manager: ${path} frontmatter 解析失败: ${err && err.message ? err.message : String(err)}`);
    return null;
  }
  if (!parsed) {
    logger?.warn?.(`dsh-skill-manager: ${path} 缺少 YAML frontmatter，忽略`);
    return null;
  }
  const name = typeof parsed.data.name === 'string' ? parsed.data.name.trim() : '';
  const description = typeof parsed.data.description === 'string' ? parsed.data.description.trim() : '';
  if (!SKILL_NAME_RE.test(name) || !description) {
    logger?.warn?.(`dsh-skill-manager: ${path} frontmatter 缺少合法的 name/description，忽略`);
    return null;
  }
  const whenToUse = typeof parsed.data.whenToUse === 'string' ? parsed.data.whenToUse.trim() : undefined;
  const invocation = parsed.data.invocation && typeof parsed.data.invocation === 'object'
    ? {
        modelInvocable: parsed.data.invocation.modelInvocable !== false,
        userInvocable: parsed.data.invocation.userInvocable !== false,
      }
    : undefined;
  return {
    name,
    description,
    ...(whenToUse ? { whenToUse } : {}),
    ...(invocation ? { invocation } : {}),
    content: parsed.body.trim(),
  };
}

/** 安装状态存储（记录已安装 skill 的来源，用于刷新/展示）。 */
export class SkillState {
  constructor(path) {
    this.path = path;
    this.data = { version: 1, installed: {} };
  }

  async load() {
    try {
      const text = await readFile(this.path, 'utf8');
      const data = JSON.parse(text);
      if (data && typeof data === 'object' && data.installed && typeof data.installed === 'object') {
        this.data = { version: 1, installed: data.installed };
      }
    } catch {
      /* 不存在或损坏：使用空状态 */
    }
  }

  get(name) {
    return this.data.installed[name] || null;
  }

  set(name, record) {
    this.data.installed[name] = record;
  }

  remove(name) {
    delete this.data.installed[name];
  }

  async persist() {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(this.data, null, 2), 'utf8');
  }
}

/**
 * 扫描 managed 目录，返回该目录下的全部 skill 文件条目。
 * name 以文件系统名为准（bundle=目录名、flat=去后缀文件名），保证
 * 启用/禁用/删除按 name 定位一致；frontmatter 的 name 放入 parsedName。
 * @returns {Array<{name, parsedName?, description, whenToUse?, enabled, kind: 'bundle'|'flat', path, dir?, parseError?}>}
 */
export async function scanSkillsDir(skillsDir, logger) {
  let entries;
  try {
    entries = await readdir(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const items = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(skillsDir, entry.name);
    if (entry.isDirectory()) {
      const active = join(full, BUNDLE_FILE);
      const disabled = join(full, BUNDLE_FILE + DISABLED_SUFFIX);
      let target = null;
      let enabled = true;
      try {
        await stat(active);
        target = active;
      } catch {
        try {
          await stat(disabled);
          target = disabled;
          enabled = false;
        } catch {
          continue; // 目录内没有 SKILL.md，不是 skill
        }
      }
      const text = await safeRead(target);
      if (text === null) continue;
      const parsed = parseSkillText(text, logger, target);
      items.push(parsed
        ? { ...parsed, name: entry.name, parsedName: parsed.name, enabled, kind: 'bundle', path: target, dir: full }
        : { name: entry.name, description: '', enabled, kind: 'bundle', path: target, dir: full, parseError: true });
      continue;
    }
    if (entry.isFile()) {
      let name = entry.name;
      let enabled = true;
      if (name.endsWith('.md' + DISABLED_SUFFIX)) {
        name = name.slice(0, -DISABLED_SUFFIX.length);
        enabled = false;
      } else if (!name.endsWith('.md')) {
        continue;
      }
      const text = await safeRead(full);
      if (text === null) continue;
      const parsed = parseSkillText(text, logger, full);
      items.push(parsed
        ? { ...parsed, name: basename(name, '.md'), parsedName: parsed.name, enabled, kind: 'flat', path: full }
        : { name: basename(name, '.md'), description: '', enabled, kind: 'flat', path: full, parseError: true });
    }
  }
  return items;
}

async function safeRead(path) {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * 切换某个 skill 的启用状态（bundle 与 flat 均支持，互相不混用）。
 * @returns {Promise<{ok: boolean, enabled?: boolean, error?: string}>}
 */
export async function setSkillEnabled(skillsDir, name, enabled, logger) {
  if (!SKILL_NAME_RE.test(name)) return { ok: false, error: `非法的 skill 名称: ${name}` };
  const bundleDir = join(skillsDir, name);
  const flat = join(skillsDir, name + '.md');
  const flatDisabled = join(skillsDir, name + '.md' + DISABLED_SUFFIX);
  const bundleActive = join(bundleDir, BUNDLE_FILE);
  const bundleDisabled = join(bundleDir, BUNDLE_FILE + DISABLED_SUFFIX);

  const pick = async (active, disabled) => {
    let hasActive = false;
    let hasDisabled = false;
    try { await stat(active); hasActive = true; } catch { /* 不存在 */ }
    try { await stat(disabled); hasDisabled = true; } catch { /* 不存在 */ }
    if (!hasActive && !hasDisabled) return null;
    if (enabled && hasActive) return { ok: true, enabled: true }; // 已启用
    if (!enabled && hasDisabled) return { ok: true, enabled: false }; // 已禁用
    if (enabled) {
      await rename(disabled, active);
      return { ok: true, enabled: true };
    }
    await rename(active, disabled);
    return { ok: true, enabled: false };
  };

  let result = await pick(bundleActive, bundleDisabled);
  if (result === null) result = await pick(flat, flatDisabled);
  if (result === null) {
    logger?.warn?.(`dsh-skill-manager: 未找到 skill "${name}"（${skillsDir}）`);
    return { ok: false, error: `未找到 skill "${name}"` };
  }
  logger?.info?.(`dsh-skill-manager: skill "${name}" 已${result.enabled ? '启用' : '禁用'}`);
  return result;
}

/** 删除一个已安装的 skill（bundle 目录或扁平文件，含 .disabled 变体）。 */
export async function removeSkill(skillsDir, name) {
  if (!SKILL_NAME_RE.test(name)) return { ok: false, error: `非法的 skill 名称: ${name}` };
  const bundleDir = join(skillsDir, name);
  const flat = join(skillsDir, name + '.md');
  const flatDisabled = join(skillsDir, name + '.md' + DISABLED_SUFFIX);
  let removed = false;
  for (const target of [bundleDir, flat, flatDisabled]) {
    try {
      const info = await stat(target);
      if (info.isDirectory()) await rm(target, { recursive: true, force: true });
      else await rm(target, { force: true });
      removed = true;
    } catch {
      /* 不存在 */
    }
  }
  if (!removed) return { ok: false, error: `未找到 skill "${name}"` };
  return { ok: true };
}

/** 写入一个 bundle skill（<skillsDir>/<name>/SKILL.md），返回写入路径。 */
export async function writeBundleSkill(skillsDir, name, content) {
  if (!SKILL_NAME_RE.test(name)) throw new Error(`非法的 skill 名称: "${name}"（需 kebab-case）`);
  const dir = join(skillsDir, name);
  await mkdir(dir, { recursive: true });
  // 若目录里存在 SKILL.md.disabled（之前被禁用），安装后默认恢复启用
  const disabledPath = join(dir, BUNDLE_FILE + DISABLED_SUFFIX);
  try {
    await rm(disabledPath, { force: true });
  } catch { /* 不存在 */ }
  const target = join(dir, BUNDLE_FILE);
  await writeFile(target, content, 'utf8');
  return target;
}

/**
 * 写入完整 bundle（SKILL.md + 资源文件），保持相对路径。
 * @param skillsDir 技能根目录
 * @param name      技能名（kebab-case）
 * @param files     [{ rel, content }]，rel 为相对技能目录的路径（如 "scripts/run.py"）
 * @returns 技能目录绝对路径
 */
export async function writeBundleFiles(skillsDir, name, files) {
  if (!SKILL_NAME_RE.test(name)) throw new Error(`非法的 skill 名称: "${name}"（需 kebab-case）`);
  const dir = join(skillsDir, name);
  // 覆盖安装时先清空旧内容，避免残留旧资源
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  for (const file of files) {
    const rel = String(file.rel || '').replace(/\\/g, '/');
    if (!rel || rel.includes('..') || rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) {
      throw new Error(`非法的 bundle 文件路径: ${rel}`);
    }
    const target = join(dir, rel);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content, 'utf8');
  }
  return dir;
}
