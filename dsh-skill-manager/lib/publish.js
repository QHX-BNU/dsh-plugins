/**
 * dsh-skill-manager —— 发布技能到 GitHub（服务端）
 *
 * 通过本机已认证的 gh CLI 把技能目录推送到 GitHub 仓库：
 *   目标路径 = <repo>[:dir]/<name>/<rel>
 * 对每个文件：contents API 先查存在性（拿 sha），再 PUT 创建/更新。
 * 全部走 gh api 子进程（gh 凭据存于系统 keyring，服务端无法直接读取，
 * 因此不自己调 REST API）。
 */
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { stat } from 'node:fs/promises';
import { collectSkillFiles, SKILL_NAME_RE } from './fs-store.js';
import { REPO_RE } from './market.js';

const DIR_RE = /^[A-Za-z0-9._/-]+$/;

function ghApi(args) {
  return new Promise((resolve, reject) => {
    execFile('gh', ['api', ...args], { maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        const e = new Error(stderr && stderr.trim() ? stderr.trim() : `gh api 失败（${err.message}）`);
        e.code = err.code;
        e.stderr = stderr || '';
        reject(e);
        return;
      }
      resolve(stdout);
    });
  });
}

function isNotFound(err) {
  return /(HTTP 404|Not Found)/i.test(err.stderr || String(err.message));
}

/**
 * 把技能推送到 GitHub 仓库。
 * @param {object} opts { skillsDir, name, repo, dir }
 * @returns {Promise<{branch: string, files: number, url: string}>}
 */
export async function publishSkillToGitHub(opts) {
  const { skillsDir, name, repo, dir } = opts;
  if (!SKILL_NAME_RE.test(name)) throw new Error(`非法的 skill 名称: "${name}"`);
  if (!REPO_RE.test(repo)) throw new Error('仓库格式应为 owner/repo');
  const prefix = String(dir || '').trim().replace(/^\/+|\/+$/g, '');
  if (prefix && (!DIR_RE.test(prefix) || prefix.includes('..'))) throw new Error('子目录格式不正确（只允许字母/数字/下划线/点/斜杠）');

  // 1. 收集技能文件
  const skillDir = join(skillsDir, name);
  try {
    await stat(skillDir);
  } catch {
    throw new Error(`技能 "${name}" 不存在于本地 skills 目录`);
  }
  const { files, skipped } = await collectSkillFiles(skillDir);
  if (!files.some((f) => f.rel === 'SKILL.md')) throw new Error('技能缺少 SKILL.md，无法发布');
  if (skipped.length > 0) {
    // 二进制文件无法经 contents API 文本方式发布，直接拒绝（避免静默缺文件）
    throw new Error(`技能包含二进制文件，暂不支持发布：${skipped.slice(0, 5).join(', ')}${skipped.length > 5 ? ' 等' : ''}`);
  }

  // 2. 默认分支
  const infoOut = await ghApi([`repos/${repo}`, '--jq', '.default_branch']);
  const branch = String(infoOut || '').trim() || 'main';

  // 3. 逐个文件 PUT
  const base = prefix ? `${prefix}/` : '';
  let published = 0;
  for (const file of files) {
    const repoPath = `${base}${name}/${file.rel}`.split('/').map(encodeURIComponent).join('/');
    let sha = null;
    try {
      const out = await ghApi([`repos/${repo}/contents/${repoPath}?ref=${encodeURIComponent(branch)}`, '--jq', '.sha']);
      sha = String(out || '').trim() || null;
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
    const content = Buffer.from(file.content, 'utf8').toString('base64');
    const args = [
      '--method', 'PUT',
      `repos/${repo}/contents/${repoPath}`,
      '-f', `message=Publish skill ${name} via dsh-skill-manager`,
      '-f', `content=${content}`,
      '-H', 'Accept: application/vnd.github+json',
    ];
    if (sha) args.push('-f', `sha=${sha}`);
    await ghApi(args);
    published += 1;
  }

  const treePath = [base, name].join('').replace(/\/$/, '');
  return {
    branch,
    files: published,
    url: `https://github.com/${repo}/tree/${branch}/${treePath}`,
  };
}
