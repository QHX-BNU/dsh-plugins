/**
 * dsh-skill-manager —— 可视化页面 HTTP API（服务端）
 *
 * 在 ctx.webServer 上注册 /skill-manager/api/* 路由，供侧边栏
 * "Skill 管理"面板调用（同源 fetch）。
 *
 * 读接口：
 *   GET  /skill-manager/api/list                    已安装 skills + 全量 catalog
 *   GET  /skill-manager/api/market?repo=owner/repo  扫描 GitHub 仓库中的 skills
 * 写接口（POST，JSON body）：
 *   POST /skill-manager/api/import       {repo, skillPath}   从仓库安装
 *   POST /skill-manager/api/set-enabled  {name, enabled}     启用/禁用
 *   POST /skill-manager/api/remove       {name}              删除
 *   POST /skill-manager/api/refresh      {name}              按记录来源重新安装
 */
import { scanSkillsDir, setSkillEnabled, removeSkill, writeBundleSkill, writeBundleFiles, importLocalSkill, parseSkillText, SKILL_NAME_RE } from './fs-store.js';
import { scanRepoSkills, fetchRaw, downloadSkillBundle, defaultBranch, REPO_RE } from './market.js';
import { publishSkillToGitHub } from './publish.js';

const MAX_BODY_BYTES = 512 * 1024;

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        done = true;
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!done) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

async function parseJsonBody(req) {
  const text = (await readBody(req)).trim();
  if (!text) return {};
  return JSON.parse(text);
}

/**
 * 注册路由；返回取消注册函数数组。
 * @param {object} ctx       注入后的 webServer ctx
 * @param {object} opts      { skillsDir, state, skills, logger, githubToken }
 */
export function installSkillsApi(ctx, opts) {
  const { skillsDir, state, skills, logger, githubToken } = opts;
  let webServer;
  try {
    webServer = ctx.webServer;
  } catch {
    webServer = undefined;
  }
  if (!webServer || typeof webServer.register !== 'function') {
    logger.warn?.('dsh-skill-manager: webServer 不可用，可视化页面 API 未注册');
    return [];
  }

  const disposers = [];
  const route = (path, handler) => {
    disposers.push(webServer.register({ kind: 'exact', path, handler }));
  };

  /** 组合列表：managed = 本地目录可管理的 skills；catalog = 全量 catalog（含系统/其他来源）。 */
  route('/skill-manager/api/list', async (_req, res) => {
    try {
      const managed = await scanSkillsDir(skillsDir, logger);
      const catalog = await skills.list().catch((err) => {
        logger.warn?.(`dsh-skill-manager: catalog 读取失败: ${err && err.message ? err.message : String(err)}`);
        return [];
      });
      sendJson(res, 200, {
        ok: true,
        skillsDir,
        managed,
        catalog: catalog.map((s) => ({
          name: s.name,
          description: s.description,
          whenToUse: s.whenToUse,
          modelInvocable: !!(s.invocation && s.invocation.modelInvocable),
          userInvocable: !!(s.invocation && s.invocation.userInvocable),
          provider: s.provider,
          source: s.source,
        })),
        installed: state.data.installed,
      });
    } catch (err) {
      sendJson(res, 200, { ok: false, error: err && err.message ? err.message : String(err) });
    }
  });

  route('/skill-manager/api/market', async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const repo = String(url.searchParams.get('repo') || '').trim();
      if (!REPO_RE.test(repo)) throw new Error('仓库格式应为 owner/repo，如 xu-jin-cs/dsh-skills');
      const skills = await scanRepoSkills(repo, githubToken);
      sendJson(res, 200, { ok: true, repo, skills });
    } catch (err) {
      sendJson(res, 200, { ok: false, error: err && err.message ? err.message : String(err) });
    }
  });

  route('/skill-manager/api/import', async (req, res) => {
    try {
      const body = await parseJsonBody(req);
      const repo = String(body.repo || '').trim();
      const skillPath = String(body.skillPath || '').trim();
      if (!REPO_RE.test(repo)) throw new Error('仓库格式应为 owner/repo');
      if (!skillPath) throw new Error('缺少 skillPath（仓库内 SKILL.md 的路径）');
      const branch = await defaultBranch(repo, githubToken);
      const text = await fetchRaw(repo, branch, skillPath, githubToken);
      const parsed = parseSkillText(text);
      if (!parsed) throw new Error('该文件不是合法的 skill：frontmatter 必须包含 kebab-case 的 name 与非空 description');
      // 完整下载 SKILL.md 所在目录（含 scripts/references/assets 等资源），
      // 失败时降级为仅安装 SKILL.md
      let files = null;
      try {
        files = await downloadSkillBundle(repo, branch, skillPath, githubToken);
      } catch (bundleErr) {
        logger.warn?.(`dsh-skill-manager: bundle 下载失败，降级为仅 SKILL.md: ${bundleErr && bundleErr.message ? bundleErr.message : String(bundleErr)}`);
      }
      const target = files
        ? await writeBundleFiles(skillsDir, parsed.name, files)
        : await writeBundleSkill(skillsDir, parsed.name, text);
      state.set(parsed.name, {
        repo,
        skillPath,
        branch,
        installedAt: Date.now(),
        files: files ? files.length : 1,
      });
      await state.persist();
      logger.info?.(`dsh-skill-manager: 已安装 skill "${parsed.name}"（${repo} ${skillPath}，${files ? files.length + ' 个文件' : '仅 SKILL.md'}）`);
      sendJson(res, 200, {
        ok: true,
        name: parsed.name,
        description: parsed.description,
        whenToUse: parsed.whenToUse,
        path: target,
        files: files ? files.length : 1,
      });
    } catch (err) {
      sendJson(res, 200, { ok: false, error: err && err.message ? err.message : String(err) });
    }
  });

  route('/skill-manager/api/import-local', async (req, res) => {
    try {
      const body = await parseJsonBody(req);
      const path = String(body.path || '').trim();
      if (!path) throw new Error('缺少本地路径');
      const result = await importLocalSkill(skillsDir, path, logger);
      state.set(result.name, {
        source: 'local',
        localPath: path,
        installedAt: Date.now(),
        files: result.files,
      });
      await state.persist();
      logger.info?.(`dsh-skill-manager: 已从本地导入 skill "${result.name}"（${path}，${result.files} 个文件）`);
      sendJson(res, 200, {
        ok: true,
        name: result.name,
        description: result.description,
        files: result.files,
        skipped: result.skipped,
        path: result.dir,
      });
    } catch (err) {
      sendJson(res, 200, { ok: false, error: err && err.message ? err.message : String(err) });
    }
  });

  route('/skill-manager/api/publish', async (req, res) => {
    try {
      const body = await parseJsonBody(req);
      const name = String(body.name || '').trim();
      const repo = String(body.repo || '').trim();
      const dir = String(body.dir || '').trim();
      const result = await publishSkillToGitHub({ skillsDir, name, repo, dir });
      // 发布成功后把来源记录为仓库（之后可一键刷新）
      state.set(name, {
        repo,
        skillPath: (dir ? dir.replace(/^\/+|\/+$/g, '') + '/' : '') + name + '/SKILL.md',
        branch: result.branch,
        installedAt: Date.now(),
        files: result.files,
      });
      await state.persist();
      logger.info?.(`dsh-skill-manager: 已发布 skill "${name}" → ${repo}（${result.files} 个文件）`);
      sendJson(res, 200, { ok: true, name, ...result });
    } catch (err) {
      sendJson(res, 200, { ok: false, error: err && err.message ? err.message : String(err) });
    }
  });

  route('/skill-manager/api/set-enabled', async (req, res) => {
    try {
      const body = await parseJsonBody(req);
      const name = String(body.name || '').trim();
      if (!SKILL_NAME_RE.test(name)) throw new Error('非法的 skill 名称');
      const result = await setSkillEnabled(skillsDir, name, body.enabled !== false, logger);
      if (!result.ok) throw new Error(result.error || '操作失败');
      sendJson(res, 200, { ok: true, name, enabled: result.enabled });
    } catch (err) {
      sendJson(res, 200, { ok: false, error: err && err.message ? err.message : String(err) });
    }
  });

  route('/skill-manager/api/remove', async (req, res) => {
    try {
      const body = await parseJsonBody(req);
      const name = String(body.name || '').trim();
      if (!SKILL_NAME_RE.test(name)) throw new Error('非法的 skill 名称');
      const result = await removeSkill(skillsDir, name);
      if (!result.ok) throw new Error(result.error || '删除失败');
      state.remove(name);
      await state.persist();
      logger.info?.(`dsh-skill-manager: 已删除 skill "${name}"`);
      sendJson(res, 200, { ok: true, name });
    } catch (err) {
      sendJson(res, 200, { ok: false, error: err && err.message ? err.message : String(err) });
    }
  });

  route('/skill-manager/api/refresh', async (req, res) => {
    try {
      const body = await parseJsonBody(req);
      const name = String(body.name || '').trim();
      if (!SKILL_NAME_RE.test(name)) throw new Error('非法的 skill 名称');
      const record = state.get(name);
      if (!record || !record.repo || !record.skillPath) throw new Error(`skill "${name}" 没有可用的来源记录（只能刷新从市场安装的 skill）`);
      const branch = record.branch || await defaultBranch(record.repo, githubToken);
      const text = await fetchRaw(record.repo, branch, record.skillPath, githubToken);
      const parsed = parseSkillText(text);
      if (!parsed) throw new Error('来源文件不再是合法的 skill');
      if (parsed.name !== name) {
        // 来源改名：先删旧名，再按新名安装
        await removeSkill(skillsDir, name);
        state.remove(name);
      }
      let files = null;
      try {
        files = await downloadSkillBundle(record.repo, branch, record.skillPath, githubToken);
      } catch (bundleErr) {
        logger.warn?.(`dsh-skill-manager: 刷新 bundle 下载失败，降级为仅 SKILL.md: ${bundleErr && bundleErr.message ? bundleErr.message : String(bundleErr)}`);
      }
      if (files) await writeBundleFiles(skillsDir, parsed.name, files);
      else await writeBundleSkill(skillsDir, parsed.name, text);
      state.set(parsed.name, { repo: record.repo, skillPath: record.skillPath, branch, installedAt: Date.now(), files: files ? files.length : record.files || 1 });
      await state.persist();
      logger.info?.(`dsh-skill-manager: 已刷新 skill "${name}"（${files ? files.length + ' 个文件' : '仅 SKILL.md'}）`);
      sendJson(res, 200, { ok: true, name: parsed.name, files: files ? files.length : 1 });
    } catch (err) {
      sendJson(res, 200, { ok: false, error: err && err.message ? err.message : String(err) });
    }
  });

  logger.info?.('dsh-skill-manager: 可视化页面 API 已注册（/skill-manager/api/*）');
  return disposers;
}
