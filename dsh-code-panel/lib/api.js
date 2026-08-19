/**
 * dsh-code-panel —— 右侧代码面板 HTTP API（服务端）
 *
 * 在 ctx.webServer 上注册 /code-panel/api/* 路由，供浏览器端的代码面板调用
 * （同源 fetch，无需任何协议依赖）。
 *
 * 读接口：
 *   GET /code-panel/api/list?root=<工作区绝对路径>&rel=<相对目录，可空>
 *        → { ok, root, rel, entries: [{ name, rel, dir, size }] }
 *   GET /code-panel/api/read?root=<工作区绝对路径>&rel=<文件相对路径>
 *        → { ok, name, rel, lang, size, content }（二进制/过大返回 ok:false）
 *   GET /code-panel/api/snippets
 *        → { ok, snippets: [{ name, rel, lang, size }] }
 *   GET /code-panel/api/snippets/read?name=<文件名>
 *        → { ok, name, lang, size, content }
 *
 * 安全边界：root 必须是绝对路径；rel 解析后必须仍然位于 root 之内；
 * 片段名必须是纯文件名（不允许路径分隔符与 ..）。
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';

/** 默认忽略的目录名（列表时跳过，避免把 node_modules 之类的噪音带进面板）。 */
export const DEFAULT_EXCLUDE_DIRS = [
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.cache',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.idea',
  '.vscode',
  'coverage',
];

/** 扩展名 → 代码语言（用于高亮与 Markdown fence）。 */
const LANG_BY_EXT = {
  js: 'js', mjs: 'js', cjs: 'js', jsx: 'jsx', ts: 'ts', tsx: 'tsx', mts: 'ts', cts: 'ts',
  json: 'json', jsonc: 'json', json5: 'json',
  css: 'css', scss: 'scss', less: 'less',
  html: 'html', htm: 'html', vue: 'html', svelte: 'html',
  md: 'markdown', markdown: 'markdown',
  py: 'python', pyi: 'python',
  sql: 'sql',
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash',
  ps1: 'powershell', psd1: 'powershell', psm1: 'powershell',
  yaml: 'yaml', yml: 'yaml',
  toml: 'toml', ini: 'ini', cfg: 'ini', conf: 'ini',
  xml: 'xml', svg: 'xml',
  java: 'java', kt: 'kotlin', scala: 'scala',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'csharp',
  go: 'go', rs: 'rust', rb: 'ruby', php: 'php', lua: 'lua', r: 'r',
  dart: 'dart', swift: 'swift', groovy: 'groovy', gradle: 'groovy',
  diff: 'diff', patch: 'diff',
  dockerfile: 'dockerfile',
  lock: 'text',
};

/** 按文件名推断语言（Dockerfile / Makefile / .gitignore 等无扩展名场景）。 */
function langOf(name, ext) {
  const byExt = LANG_BY_EXT[ext];
  if (byExt) return byExt;
  const base = name.toLowerCase();
  if (base === 'dockerfile') return 'dockerfile';
  if (base === 'makefile') return 'makefile';
  if (base === 'gemfile') return 'ruby';
  if (base === 'rakefile') return 'ruby';
  return 'text';
}

function extensionOf(name) {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return '';
  return name.slice(dot + 1).toLowerCase();
}

/** 路径合法性：root 必须为绝对路径；解析后的 full 必须位于 root 之内。 */
function resolveInside(root, rel) {
  if (typeof root !== 'string' || root.length === 0) throw new Error('缺少 root 参数');
  if (typeof rel !== 'string') throw new Error('缺少 rel 参数');
  const rootAbs = path.resolve(root);
  const relClean = rel.replace(/^[/\\]+/, '');
  const full = path.resolve(rootAbs, relClean);
  const relative = path.relative(rootAbs, full);
  if (relative === '') return { rootAbs, full, rel: '' };
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('路径越界：不允许访问工作区之外的目录');
  }
  return { rootAbs, full, rel: relative.split(path.sep).join('/') };
}

/** 判断是否二进制：前 8KB 内出现 NUL 字节即视为二进制。 */
function looksBinary(buf) {
  const head = buf.subarray(0, 8192);
  return head.includes(0);
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

/** 目录条目排序：目录在前、文件在后，各自按名称（不区分大小写）排序。 */
function sortEntries(entries) {
  return entries.sort((a, b) => {
    if (a.dir !== b.dir) return a.dir ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
}

/** 注册代码面板 API 路由；返回取消注册函数数组。 */
export function installCodePanelApi(ctx, options) {
  let webServer;
  try {
    webServer = ctx.webServer;
  } catch {
    webServer = undefined;
  }
  if (!webServer || typeof webServer.register !== 'function') {
    ctx.logger.warn('dsh-code-panel: webServer 不可用，代码面板 API 未注册');
    return [];
  }

  const { snippetsDir, maxFileBytes, excludeDirs } = options;
  const disposers = [];
  const route = (pathname, handler) => {
    disposers.push(webServer.register({ kind: 'exact', path: pathname, handler }));
  };

  // 列出单个目录（懒加载文件树用）
  route('/code-panel/api/list', async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const { rootAbs, full, rel } = resolveInside(
        url.searchParams.get('root') ?? '',
        url.searchParams.get('rel') ?? '',
      );
      const stat = await fsp.stat(full);
      if (!stat.isDirectory()) {
        sendJson(res, 400, { ok: false, error: '目标不是目录' });
        return;
      }
      const names = await fsp.readdir(full, { withFileTypes: true });
      const entries = [];
      for (const entry of names) {
        const name = entry.name;
        const isDir = entry.isDirectory();
        if (isDir && excludeDirs.has(name.toLowerCase())) continue;
        const entryRel = rel ? `${rel}/${name}` : name;
        let size = 0;
        if (!isDir) {
          try {
            size = (await fsp.stat(path.join(full, name))).size;
          } catch {
            /* 单个文件 stat 失败不影响列表 */
          }
        }
        entries.push({ name, rel: entryRel, dir: isDir, size });
      }
      sendJson(res, 200, {
        ok: true,
        root: rootAbs,
        rel,
        entries: sortEntries(entries),
      });
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err.message });
    }
  });

  // 读取文件内容（utf8；二进制/过大返回 ok:false）
  route('/code-panel/api/read', async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const { rootAbs, full, rel } = resolveInside(
        url.searchParams.get('root') ?? '',
        url.searchParams.get('rel') ?? '',
      );
      const stat = await fsp.stat(full);
      if (!stat.isFile()) {
        sendJson(res, 400, { ok: false, error: '目标不是文件' });
        return;
      }
      if (stat.size > maxFileBytes) {
        sendJson(res, 200, {
          ok: false,
          error: 'file-too-large',
          message: `文件过大（${stat.size} 字节，上限 ${maxFileBytes} 字节），请直接用编辑器打开`,
          size: stat.size,
          name: path.basename(full),
          rel,
        });
        return;
      }
      const buf = await fsp.readFile(full);
      if (looksBinary(buf)) {
        sendJson(res, 200, {
          ok: false,
          error: 'binary',
          message: '二进制文件，无法在面板中预览',
          size: stat.size,
          name: path.basename(full),
          rel,
        });
        return;
      }
      const name = path.basename(full);
      const ext = extensionOf(name);
      sendJson(res, 200, {
        ok: true,
        name,
        rel,
        lang: langOf(name, ext),
        size: stat.size,
        content: buf.toString('utf8'),
      });
    } catch (err) {
      const code = err && err.code;
      if (code === 'ENOENT') {
        sendJson(res, 404, { ok: false, error: 'not-found', message: '文件不存在' });
        return;
      }
      sendJson(res, 400, { ok: false, error: err.message });
    }
  });

  // 列出 Agent 代码片段（“我的代码”标签）
  route('/code-panel/api/snippets', async (req, res) => {
    try {
      await fsp.mkdir(snippetsDir, { recursive: true });
      const names = await fsp.readdir(snippetsDir);
      const snippets = [];
      for (const name of names) {
        if (name.startsWith('.')) continue;
        const full = path.join(snippetsDir, name);
        let stat;
        try {
          stat = await fsp.stat(full);
        } catch {
          continue;
        }
        if (!stat.isFile()) continue;
        const ext = extensionOf(name);
        snippets.push({
          name,
          rel: name,
          lang: langOf(name, ext),
          size: stat.size,
        });
      }
      snippets.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
      sendJson(res, 200, { ok: true, dir: snippetsDir, snippets });
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err.message });
    }
  });

  // 读取单个片段
  route('/code-panel/api/snippets/read', async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const name = url.searchParams.get('name') ?? '';
      if (!name || name.includes('/') || name.includes('\\') || name === '..' || name.includes('..')) {
        sendJson(res, 400, { ok: false, error: '非法的片段名' });
        return;
      }
      const full = path.join(snippetsDir, name);
      const stat = await fsp.stat(full);
      if (!stat.isFile()) {
        sendJson(res, 404, { ok: false, error: 'not-found', message: '片段不存在' });
        return;
      }
      const buf = await fsp.readFile(full);
      if (looksBinary(buf)) {
        sendJson(res, 200, { ok: false, error: 'binary', message: '二进制文件，无法预览', name, size: stat.size });
        return;
      }
      const ext = extensionOf(name);
      sendJson(res, 200, {
        ok: true,
        name,
        rel: name,
        lang: langOf(name, ext),
        size: stat.size,
        content: buf.toString('utf8'),
      });
    } catch (err) {
      const code = err && err.code;
      if (code === 'ENOENT') {
        sendJson(res, 404, { ok: false, error: 'not-found', message: '片段不存在' });
        return;
      }
      sendJson(res, 400, { ok: false, error: err.message });
    }
  });

  ctx.logger.info(`dsh-code-panel: 代码面板 API 已注册（/code-panel/api/*，片段目录=${snippetsDir}）`);
  return disposers;
}
