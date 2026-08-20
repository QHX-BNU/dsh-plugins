/**
 * dsh-code-panel —— 右侧代码面板 HTTP API（服务端）
 *
 * 在 ctx.webServer 上注册 /code-panel/api/* 路由，供浏览器端的代码面板调用
 * （同源 fetch，无需任何协议依赖）。
 *
 * 读接口：
 *   GET /code-panel/api/list?root=<工作区绝对路径>&rel=<相对目录，可空>
 *        → { ok, root, rel, entries: [{ name, rel, dir, size, image }] }
 *   GET /code-panel/api/search?root=<工作区绝对路径>&query=<关键词，可空>&limit=<数量>
 *        → { ok, root, query, limit, files: [{ name, rel, dir, size, image }] }
 *      （递归遍历工作区，按文件名/相对路径子串匹配；@ 输入菜单用）
 *   GET /code-panel/api/read?root=<工作区绝对路径>&rel=<文件相对路径>
 *        → { ok, name, rel, lang, size, content }（二进制/过大返回 ok:false）
 *   GET /code-panel/api/image?root=<工作区绝对路径>&rel=<图片相对路径>
 *        → 图片二进制（content-type: image/*；魔数校验失败/过大返回 JSON ok:false）
 *   GET /code-panel/api/snippets
 *        → { ok, snippets: [{ name, rel, lang, size, image }] }
 *   GET /code-panel/api/snippets/read?name=<文件名>
 *        → { ok, name, lang, size, content }
 *   GET /code-panel/api/snippets/image?name=<图片文件名>
 *        → 图片二进制（content-type: image/*；魔数校验失败/过大返回 JSON ok:false）
 *
 * 安全边界：root 必须是绝对路径；rel 解析后必须仍然位于 root 之内；
 * 片段名必须是纯文件名（不允许路径分隔符与 ..）；图片必须通过魔数校验，
 * 且同样受符号链接逃逸防护约束。
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
  if (!path.isAbsolute(root)) throw new Error('root 必须是绝对路径');
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

/**
 * 防符号链接逃逸：realpath 解析后目标必须仍位于 root 之内。
 * stat/readdir 会跟随符号链接，仅做字符串路径校验无法阻止工作区内的
 * 链接指向工作区之外（如 C:\Users\...），必须按真实路径再校验一次。
 */
async function assertRealInside(rootAbs, full) {
  const [rootReal, fullReal] = await Promise.all([fsp.realpath(rootAbs), fsp.realpath(full)]);
  const relative = path.relative(rootReal, fullReal);
  if (relative === '') return;
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('路径越界：不允许访问工作区之外的目录');
  }
}

/** 判断是否二进制：前 8KB 内出现 NUL 字节即视为二进制。 */
function looksBinary(buf) {
  const head = buf.subarray(0, 8192);
  return head.includes(0);
}

// ---------------------------------------------------------------- 图片预览

/** 可预览的图片扩展名 → MIME 类型（与客户端 bundle 的 IMAGE_EXTS 保持同步）。 */
export const IMAGE_MIME = {
  png: 'image/png',
  apng: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  avif: 'image/avif',
  heic: 'image/heic',
  heif: 'image/heif',
  tif: 'image/tiff',
  tiff: 'image/tiff',
};

export const IMAGE_EXTS = new Set(Object.keys(IMAGE_MIME));

/**
 * 校验文件内容是否为图片，返回 MIME 类型；不是图片返回 null。
 * 按魔数（文件头签名）校验，防止任意文件伪装成图片扩展名被当图片返回。
 */
export function imageMimeOf(name, buf) {
  const ext = extensionOf(name);
  const mime = IMAGE_MIME[ext];
  if (!mime || buf.length === 0) return null;
  const b = buf;
  const sig = (arr) => arr.every((v, i) => b[i] === v);
  switch (ext) {
    case 'png':
    case 'apng':
      return sig([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) ? mime : null;
    case 'jpg':
    case 'jpeg':
      return sig([0xff, 0xd8, 0xff]) ? mime : null;
    case 'gif':
      return sig([0x47, 0x49, 0x46, 0x38]) ? mime : null;
    case 'webp':
      return b.length >= 12 && sig([0x52, 0x49, 0x46, 0x46]) && b.toString('latin1', 8, 12) === 'WEBP' ? mime : null;
    case 'bmp':
      return sig([0x42, 0x4d]) ? mime : null;
    case 'ico':
      return sig([0x00, 0x00, 0x01, 0x00]) ? mime : null;
    case 'tif':
    case 'tiff':
      return sig([0x49, 0x49, 0x2a, 0x00]) || sig([0x4d, 0x4d, 0x00, 0x2a]) ? mime : null;
    case 'svg': {
      // SVG 是文本：容忍 BOM 与 <?xml ...?> 前缀
      const head = buf.subarray(0, 4096).toString('utf8').replace(/^\uFEFF/, '').trimStart();
      return head.startsWith('<svg') || head.startsWith('<?xml') || head.startsWith('<!DOCTYPE svg') ? mime : null;
    }
    case 'avif':
    case 'heic':
    case 'heif': {
      // ISO BMFF：第 4~8 字节为 'ftyp'（品牌在 8~12）
      return b.length >= 12 && b.toString('latin1', 4, 8) === 'ftyp' ? mime : null;
    }
    default:
      return null;
  }
}

function sendBinary(res, status, buf, contentType) {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': buf.length,
    'cache-control': 'no-store',
  });
  res.end(buf);
}

/** 图片预览公共实现：校验 → 读文件 → 魔数识别 → 二进制返回。 */
async function serveImage(res, full, rel, name, maxImageBytes) {
  const stat = await fsp.stat(full);
  if (!stat.isFile()) {
    sendJson(res, 400, { ok: false, error: '目标不是文件' });
    return;
  }
  if (stat.size > maxImageBytes) {
    sendJson(res, 200, {
      ok: false,
      error: 'image-too-large',
      message: `图片过大（${stat.size} 字节，上限 ${maxImageBytes} 字节），无法预览`,
      size: stat.size,
      name,
      rel,
    });
    return;
  }
  const buf = await fsp.readFile(full);
  const mime = imageMimeOf(name, buf);
  if (!mime) {
    sendJson(res, 200, {
      ok: false,
      error: 'not-image',
      message: '文件内容不是有效的图片，无法预览',
      size: stat.size,
      name,
      rel,
    });
    return;
  }
  sendBinary(res, 200, buf, mime);
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
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

  const { snippetsDir, maxFileBytes, maxImageBytes, excludeDirs } = options;
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
      // 目录本身不允许是逃逸符号链接
      try {
        await assertRealInside(rootAbs, full);
      } catch (err) {
        sendJson(res, 400, { ok: false, error: err.message });
        return;
      }
      const names = await fsp.readdir(full, { withFileTypes: true });
      const entries = [];
      for (const entry of names) {
        const name = entry.name;
        // 符号链接一律不展示：链接目标可能在工作区之外，面板也不负责跟随链接
        if (entry.isSymbolicLink()) continue;
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
        entries.push({ name, rel: entryRel, dir: isDir, size, image: !isDir && IMAGE_EXTS.has(extensionOf(name)) });
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

  // 搜索工作区文件（@ 输入菜单用）：递归遍历，按文件名/相对路径子串匹配，
  // 受 excludeDirs / 符号链接跳过 / 深度与访问量上限约束；前缀命中优先。
  route('/code-panel/api/search', async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const { rootAbs } = resolveInside(url.searchParams.get('root') ?? '', '');
      const stat = await fsp.stat(rootAbs);
      if (!stat.isDirectory()) {
        sendJson(res, 400, { ok: false, error: '目标不是目录' });
        return;
      }
      // 根目录本身不允许是逃逸符号链接（与 /list 一致）
      try {
        await assertRealInside(rootAbs, rootAbs);
      } catch (err) {
        sendJson(res, 400, { ok: false, error: err.message });
        return;
      }
      const query = String(url.searchParams.get('query') || '').trim().toLowerCase();
      const limit = Math.max(1, Math.min(parseInt(url.searchParams.get('limit') || '30', 10) || 30, 100));
      const hits = [];
      let visited = 0;
      const MAX_VISITED = 50000;
      const MAX_DEPTH = 16;
      const walk = async (dirAbs, rel, depth) => {
        if (depth > MAX_DEPTH || visited > MAX_VISITED || hits.length >= limit) return;
        let entries;
        try {
          entries = await fsp.readdir(dirAbs, { withFileTypes: true });
        } catch {
          return; // 目录读取失败（权限等）跳过
        }
        // 目录在前、文件在后，各自按名称（不区分大小写）排序
        entries.sort((a, b) => {
          if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
          return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
        });
        for (const entry of entries) {
          if (++visited > MAX_VISITED || hits.length >= limit) return;
          // 符号链接一律不展示：链接目标可能在工作区之外
          if (entry.isSymbolicLink()) continue;
          if (entry.isDirectory()) {
            if (excludeDirs.has(entry.name.toLowerCase())) continue;
            await walk(
              path.join(dirAbs, entry.name),
              rel ? `${rel}/${entry.name}` : entry.name,
              depth + 1,
            );
            if (hits.length >= limit) return;
            continue;
          }
          const name = entry.name;
          const entryRel = rel ? `${rel}/${name}` : name;
          if (query && !entryRel.toLowerCase().includes(query) && !name.toLowerCase().includes(query)) continue;
          let size = 0;
          try {
            size = (await fsp.stat(path.join(dirAbs, name))).size;
          } catch {
            /* 单个文件 stat 失败不影响搜索 */
          }
          hits.push({ name, rel: entryRel, dir: false, size, image: IMAGE_EXTS.has(extensionOf(name)) });
        }
      };
      await walk(rootAbs, '', 0);
      // 前缀命中（名称以 query 开头）优先，其余按相对路径排序
      if (query) {
        hits.sort((a, b) => {
          const ap = a.name.toLowerCase().startsWith(query) ? 0 : 1;
          const bp = b.name.toLowerCase().startsWith(query) ? 0 : 1;
          if (ap !== bp) return ap - bp;
          return a.rel.localeCompare(b.rel, undefined, { sensitivity: 'base' });
        });
      }
      sendJson(res, 200, { ok: true, root: rootAbs, query, limit, files: hits });
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err && err.message ? err.message : String(err) });
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
      // 文件不允许是逃逸符号链接（防工作区内链接指向工作区外）
      try {
        await assertRealInside(rootAbs, full);
      } catch (err) {
        sendJson(res, 400, { ok: false, error: err.message });
        return;
      }
      if (stat.size > maxFileBytes) {
        // 图片扩展名的文件：提示走图片预览（旧客户端 bundle 仍会请求 /read）
        if (IMAGE_EXTS.has(extensionOf(path.basename(full)))) {
          sendJson(res, 200, {
            ok: false,
            error: 'image',
            message: `这是图片文件（${stat.size} 字节），请在面板中直接预览；若仍显示本提示，请重启 DSH 使插件更新生效`,
            size: stat.size,
            name: path.basename(full),
            rel,
            image: true,
          });
          return;
        }
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
        // 已读到内容：按魔数识别图片（防伪装），给出图片引导而非"二进制"误导
        const name = path.basename(full);
        const mime = imageMimeOf(name, buf);
        if (mime) {
          sendJson(res, 200, {
            ok: false,
            error: 'image',
            message: '这是图片文件，请在面板中直接预览；若仍显示本提示，请重启 DSH 使插件更新生效',
            size: stat.size,
            name,
            rel,
            image: true,
            mime,
          });
          return;
        }
        sendJson(res, 200, {
          ok: false,
          error: 'binary',
          message: '二进制文件，无法在面板中预览',
          size: stat.size,
          name,
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

  // 预览图片（工作区文件；返回图片二进制，非 JSON）
  route('/code-panel/api/image', async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const { rootAbs, full, rel } = resolveInside(
        url.searchParams.get('root') ?? '',
        url.searchParams.get('rel') ?? '',
      );
      // 图片文件同样不允许是逃逸符号链接；文件不存在时让 ENOENT 上抛（→404）
      try {
        await assertRealInside(rootAbs, full);
      } catch (err) {
        if (err && err.code === 'ENOENT') throw err;
        sendJson(res, 400, { ok: false, error: err.message });
        return;
      }
      await serveImage(res, full, rel, path.basename(full), maxImageBytes);
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
          image: IMAGE_EXTS.has(ext),
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
      // 片段目录内的符号链接同样不允许逃逸到片段目录之外
      try {
        await assertRealInside(snippetsDir, full);
      } catch (err) {
        sendJson(res, 400, { ok: false, error: err.message });
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

  // 预览图片片段（"我的代码"标签；返回图片二进制，非 JSON）
  route('/code-panel/api/snippets/image', async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const name = url.searchParams.get('name') ?? '';
      if (!name || name.includes('/') || name.includes('\\') || name === '..' || name.includes('..')) {
        sendJson(res, 400, { ok: false, error: '非法的片段名' });
        return;
      }
      const full = path.join(snippetsDir, name);
      // 片段目录内的符号链接同样不允许逃逸到片段目录之外；不存在时让 ENOENT 上抛（→404）
      try {
        await assertRealInside(snippetsDir, full);
      } catch (err) {
        if (err && err.code === 'ENOENT') throw err;
        sendJson(res, 400, { ok: false, error: err.message });
        return;
      }
      await serveImage(res, full, name, name, maxImageBytes);
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
