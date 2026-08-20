/**
 * dsh-skill-manager —— Skill 市场（服务端）
 *
 * 从 GitHub 仓库发现并下载 skills：
 *   - 扫描仓库：通过 GitHub git trees API 递归列出所有 SKILL.md，
 *     并逐个拉取内容解析 name/description（用于安装前的预览）；
 *   - 安装：下载 SKILL.md 文本，校验 frontmatter（name 需 kebab-case、
 *     description 非空），由调用方写入 <skillsDir>/<name>/SKILL.md。
 *
 * 网络出口全部走 fetch（contents API，base64）；仓库地址格式 owner/repo
 * （默认分支自动探测）。
 */
import { parseSkillText } from './fs-store.js';

const GITHUB_API = 'https://api.github.com';

export const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function apiHeaders(token) {
  return token && token.trim() !== ''
    ? { authorization: `Bearer ${token.trim()}`, accept: 'application/vnd.github+json', 'user-agent': 'dsh-skill-manager' }
    : { accept: 'application/vnd.github+json', 'user-agent': 'dsh-skill-manager' };
}

async function githubJson(url, token) {
  const res = await fetch(url, { headers: apiHeaders(token), signal: AbortSignal.timeout(20000) });
  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.json();
      detail = body && body.message ? `：${body.message}` : '';
    } catch { /* 忽略 */ }
    throw new Error(`GitHub 请求失败（HTTP ${res.status}）${detail}`);
  }
  return res.json();
}

/** 获取仓库默认分支（缓存于模块级）。 */
const branchCache = new Map();
export async function defaultBranch(repo, token) {
  const cached = branchCache.get(repo);
  if (cached) return cached;
  const info = await githubJson(`${GITHUB_API}/repos/${repo}`, token);
  const branch = info && typeof info.default_branch === 'string' ? info.default_branch : 'main';
  branchCache.set(repo, branch);
  return branch;
}

/**
 * 扫描仓库，返回全部 SKILL.md 的路径与内容摘要。
 * @returns {Promise<Array<{path: string, name?: string, description?: string, error?: string}>>}
 */
export async function scanRepoSkills(repo, token, signal) {
  const branch = await defaultBranch(repo, token);
  const tree = await githubJson(`${GITHUB_API}/repos/${repo}/git/trees/${branch}?recursive=1`, token);
  const paths = (tree && Array.isArray(tree.tree) ? tree.tree : [])
    .filter((node) => node.type === 'blob' && node.path.endsWith('SKILL.md'))
    .map((node) => node.path)
    .slice(0, 60);
  const results = await Promise.all(paths.map(async (path) => {
    if (signal && signal.aborted) return null;
    try {
      const text = await fetchRaw(repo, branch, path, token, signal);
      const parsed = parseSkillText(text);
      if (!parsed) {
        return { path, error: 'frontmatter 缺少合法的 name/description' };
      }
      return { path, name: parsed.name, description: parsed.description, whenToUse: parsed.whenToUse };
    } catch (err) {
      return { path, error: err && err.message ? err.message : String(err) };
    }
  }));
  return results.filter(Boolean);
}

/**
 * 下载仓库内某个文件的原文（走 GitHub contents API；部分网络环境无法访问
 * raw.githubusercontent.com，contents API 返回 base64 更稳定）。
 */
export async function fetchRaw(repo, branch, path, token, signal) {
  const url = `${GITHUB_API}/repos/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(branch)}`;
  const res = await fetch(url, {
    headers: apiHeaders(token),
    signal: signal || AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.json();
      detail = body && body.message ? `：${body.message}` : '';
    } catch { /* 忽略 */ }
    throw new Error(`下载失败（HTTP ${res.status}）${detail}`);
  }
  const json = await res.json();
  if (typeof json.content === 'string') {
    const text = Buffer.from(json.content, 'base64').toString('utf8');
    if (text.length > 2 * 1024 * 1024) throw new Error('SKILL.md 超过 2MB 上限');
    return text;
  }
  // 大文件走 git blob API
  if (typeof json.git_url === 'string') {
    const blobRes = await fetch(json.git_url, {
      headers: apiHeaders(token),
      signal: signal || AbortSignal.timeout(30000),
    });
    if (!blobRes.ok) throw new Error(`下载 blob 失败（HTTP ${blobRes.status}）`);
    const blob = await blobRes.json();
    if (typeof blob.content !== 'string') throw new Error('blob 内容无法读取');
    const text = Buffer.from(blob.content, 'base64').toString('utf8');
    if (text.length > 2 * 1024 * 1024) throw new Error('SKILL.md 超过 2MB 上限');
    return text;
  }
  throw new Error('无法读取文件内容');
}

const MAX_BUNDLE_FILES = 200;
const MAX_BUNDLE_BYTES = 20 * 1024 * 1024;

/**
 * 下载 SKILL.md 所在目录的完整 bundle（SKILL.md + 同目录资源/脚本/引用），
 * 保持相对路径。用于安装带资源的多文件技能。
 * @returns {Promise<Array<{rel: string, content: string}>>} rel 为相对目录的路径
 */
export async function downloadSkillBundle(repo, branch, skillPath, token, signal) {
  const dir = skillPath.slice(0, -'SKILL.md'.length); // 以 / 结尾或空
  const prefix = dir ? dir.split('/') : [];
  const tree = await githubJson(`${GITHUB_API}/repos/${repo}/git/trees/${branch}?recursive=1`, token);
  const blobs = (tree && Array.isArray(tree.tree) ? tree.tree : [])
    .filter((node) => node.type === 'blob' && node.path.startsWith(dir))
    .filter((node) => {
      // SKILL.md 位于仓库根时（dir === ""）只取根目录文件，避免拉下整个仓库
      if (prefix.length === 0) return !node.path.includes('/');
      return true;
    });
  if (blobs.length === 0) throw new Error('未找到该 skill 目录下的文件');
  if (blobs.length > MAX_BUNDLE_FILES) throw new Error(`skill 目录文件过多（${blobs.length} > ${MAX_BUNDLE_FILES}）`);
  const results = [];
  let total = 0;
  for (const blob of blobs) {
    if (signal && signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('aborted');
    const content = await fetchRaw(repo, branch, blob.path, token, signal);
    total += content.length;
    if (total > MAX_BUNDLE_BYTES) throw new Error(`skill 目录总大小超过 ${MAX_BUNDLE_BYTES / 1024 / 1024}MB 上限`);
    results.push({ rel: blob.path.slice(dir.length), content });
  }
  return results;
}
