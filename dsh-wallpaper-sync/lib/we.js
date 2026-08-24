/**
 * dsh-wallpaper-sync —— 读取 Wallpaper Engine 当前壁纸（宿主端公共逻辑）
 *
 * 目标：拿到「当前桌面壁纸」并让前端用它作为 DSH 背景，随后跟随切换。
 *
 * Wallpaper Engine 的背景来源：
 *   config.json 里 `general.wallpaperconfig.selectedwallpapers.<monitor>.file`
 *   指向一个可移植类型的壁纸：
 *     - *.mp4 / *.webm      → 视频背景（前端用 <video> 静音循环播放）
 *     - *.html / *.htm      → 网页背景（前端用 <iframe> 渲染）
 *     - *.pkg               → Scene 场景（WE 私有格式，前端无法播放；取同目录
 *                             长驻静态帧 preview.jpg / preview.gif 作替代画面）
 *     - *.jpg / *.png / ... → 普通静态图（前端用 <img>/background-image）
 *
 * WE 不会改 Windows 注册表壁纸（注册表仍是系统默认），所以必须从这里读。
 * 本模块不依赖任何第三方包（仅 node:fs / node:path / node:child_process / node:os）。
 */
import { promises as fsp, existsSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/** 可渲染媒体文件 → MIME（用于前端判断播放方式）。 */
export const MEDIA_MIME = {
  mp4: 'video/mp4',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  mov: 'video/quicktime',
  html: 'text/html',
  htm: 'text/html',
};

/** 静态图 → MIME。 */
export const IMAGE_MIME = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  avif: 'image/avif',
};

/** Scene 场景目录里优先寻找的静态帧文件名（按优先级，按体积从大到小优先后）。 */
const SCENE_PREVIEW_BASENAMES = ['preview.jpg', 'preview.jpeg', 'preview.png', 'preview.gif', 'preview.webp'];

/** 判断路径是否为同目录绝对/相对路径，用于媒体访问白名单。 */
function extOf(p) {
  const dot = String(p).lastIndexOf('.');
  return dot <= 0 ? '' : String(p).slice(dot + 1).toLowerCase();
}

/**
 * 探测 WE 的 config.json 路径。
 * 顺序：显式配置 → 注册表 HKCU\Software\WallpaperEngine\installPath → 常见默认路径。
 * 返回存在的路径或 null。
 */
export async function detectWeConfigPath(explicit) {
  if (explicit && (await exists(explicit))) return explicit;

  // 1) 注册表 installPath（值是 ...\wallpaper_engine\wallpaper64.exe）
  try {
    const out = execFileSync(
      'reg',
      ['query', 'HKCU\\Software\\WallpaperEngine', '/v', 'installPath'],
      { encoding: 'utf8', timeout: 5000 },
    );
    const m = /installPath\s+REG_SZ\s+(.+)/i.exec(out);
    if (m && m[1]) {
      // 去掉末尾可执行名，保留安装目录（config.json 与 wallpaper64.exe 同目录）
      const exePath = m[1].trim().replace(/^"|"$/g, '');
      const dir = path.dirname(exePath);
      const cfg = path.join(dir, 'config.json');
      if (await exists(cfg)) return cfg;
    }
  } catch {
    /* 注册表读取失败忽略 */
  }

  // 2) 常见 Steam 默认路径（C 盘 + 普通盘位）
  const candidates = [
    'C:/Program Files (x86)/Steam/steamapps/common/wallpaper_engine/config.json',
    'C:/Program Files/Steam/steamapps/common/wallpaper_engine/config.json',
    'D:/Program Files (x86)/Steam/steamapps/common/wallpaper_engine/config.json',
  ];
  // 从 libraryfolders.vdf 推断非默认盘（可选增强）
  for (const c of candidates) {
    if (await exists(c)) return c;
  }
  return null;
}

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * 从 WE config 文本解析「该显示器当前正在用的壁纸源」。
 * @returns {Promise<{file:string, title:string, monitor:string}|null>}
 */
export async function readCurrentWallpaper(weConfigPath, preferredMonitor) {
  let raw;
  try {
    raw = await fsp.readFile(weConfigPath, 'utf8');
  } catch {
    return null;
  }
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch {
    return null;
  }
  // WE config.json 顶层是「Steam 用户 id 数字字符串 / '?installdirectory'」键；
  // 找含 general.wallpaperconfig.selectedwallpapers 的那个用户键。
  let user = null;
  for (const k of Object.keys(cfg)) {
    const v = cfg[k];
    if (v && v.general && v.general.wallpaperconfig && v.general.wallpaperconfig.selectedwallpapers) {
      user = v;
      break;
    }
  }
  if (!user) return null;
  const wc = user.general.wallpaperconfig;
  const sw = wc.selectedwallpapers || {};

  // 选出目标显示器：优先 preferredMonitor，否则用"非 application 类型"的第一个；
  // WE 的 application 类壁纸（如自定义 app）也是 file 路径，但通常是最少用的。
  const entries = Object.entries(sw);
  if (entries.length === 0) return null;

  let chosen = null;
  if (preferredMonitor && sw[preferredMonitor]) {
    chosen = { file: sw[preferredMonitor].file || sw[preferredMonitor], monitor: preferredMonitor };
  } else {
    // 优先非 .html application 类型……先取第一个非空 file
    for (const [mon, v] of entries) {
      if (v && typeof v === 'object' && v.file) {
        chosen = { file: v.file, monitor: mon };
        break;
      } else if (v && typeof v === 'string' && v) {
        chosen = { file: v, monitor: mon };
        break;
      }
    }
    if (!chosen) chosen = { file: '', monitor: entries[0][0] };
  }
  if (!chosen.file) return null;

  // 标题：wallpaperconfigrecent 里通常有对应 file 的 title（可空）
  const title = findRecentTitle(user.general, chosen.file);
  return { file: chosen.file, monitor: chosen.monitor, title };
}

function findRecentTitle(general, file) {
  const recent = general && general.wallpaperconfigrecent;
  if (!Array.isArray(recent)) return '';
  const norm = (p) => String(p || '').replace(/\\/g, '/').toLowerCase();
  const target = norm(file);
  for (const item of recent) {
    const sw = item && item.config && item.config.selectedwallpapers;
    if (!sw) continue;
    for (const v of Object.values(sw)) {
      if (v && norm(v.file) === target) return String(item.title || '');
    }
  }
  return '';
}

/**
 * 判定壁纸如何渲染，并解析出前端可用的媒体地址与能力描述。
 * @param {string} absFile 壁纸文件绝对路径
 * @param {object} opts { basePath: string } basePath 是挂到同源 http 下的路径前缀（如 ''）
 * @returns {{kind:'video'|'web'|'scene'|'image'|'unknown', file:string, mediaUrl:string,
 *            mediaType?:string, sceneFrame?:string, sceneFrameType?:string}}
 */
export function resolveWallpaper(absFile, opts = {}) {
  const base = opts.basePath || '';
  const ext = extOf(absFile);
  const lower = absFile.replace(/\\/g, '/');

  if (ext === 'html' || ext === 'htm') {
    return { kind: 'web', file: absFile, mediaUrl: `${base}/wallpaper-sync/api/media`, mediaType: 'text/html' };
  }
  if (MEDIA_MIME[ext]) {
    return { kind: 'video', file: absFile, mediaUrl: `${base}/wallpaper-sync/api/media`, mediaType: MEDIA_MIME[ext] };
  }
  if (ext === 'pkg') {
    // Scene：找同目录静态帧作为替代画面
    const dir = path.dirname(absFile);
    for (const bn of SCENE_PREVIEW_BASENAMES) {
      const cand = path.join(dir, bn);
      if (existsSync(cand)) {
        return {
          kind: 'scene',
          file: absFile,
          mediaUrl: `${base}/wallpaper-sync/api/media`,
          sceneFrame: cand,
          sceneFrameType: IMAGE_MIME[extOf(bn)] || 'image/jpeg',
        };
      }
    }
    // 无静态帧：整个目录下找任意图片
    return { kind: 'scene', file: absFile, mediaUrl: '', sceneFrame: '', sceneFrameType: '' };
  }
  if (IMAGE_MIME[ext]) {
    return { kind: 'image', file: absFile, mediaUrl: `${base}/wallpaper-sync/api/media`, mediaType: IMAGE_MIME[ext] };
  }
  return { kind: 'unknown', file: absFile, mediaUrl: '', mediaType: '' };
}

/** 判断一个候选文件是否允许被当作媒体流式提供（避免任意文件读取）。 */
export function isAllowedMediaFile(file, currentFile) {
  const norm = (p) => String(p || '').replace(/\\/g, '/');
  if (norm(file) === norm(currentFile)) return true;
  return false;
}

// ---------------------------------------------------------------- 壁纸库扫描

/** 默认 WE workshop 内容目录（相对 Steam 安装）。 */
const WORKSHOP_REL = 'steamapps/workshop/content/431960';

/** 从 Steam libraryfolders.vdf 枚举所有库目录；失败返回空数组。 */
function readSteamLibraryRoots() {
  const roots = [];
  // 尝试从 WE 安装目录反推（常见在 <steam>/steamapps/common/wallpaper_engine）
  const weDir = process.env.WALLPAPER_ENGINE_DIR || '';
  // 常见库位置
  const cand = [
    weDir ? path.resolve(path.dirname(weDir), '..', '..') : null, // <steam>/steamapps/...
    'C:/Program Files (x86)/Steam',
    'C:/Program Files/Steam',
    'D:/Program Files (x86)/Steam',
    'D:/Program Files/Steam',
    'D:/Steam',
  ].filter(Boolean);
  for (const c of cand) {
    for (const f of ['libraryfolders.vdf']) {
      const fp = path.join(c, 'steamapps', f);
      if (existsSync(fp)) {
        // 从 VDF 提取所有 "path" 行
        try {
          const txt = execFileSync('type', [fp], { encoding: 'utf8' }).toString();
          const re = /"path"\s+"([^"]+)"/g;
          let m;
          while ((m = re.exec(txt)) !== null) roots.push(m[1]);
        } catch { /* 忽略 */ }
        if (roots.length === 0) roots.push(c); // 兜底：默认库根
      }
    }
  }
  // 去重并规范化
  return [...new Set(roots.map((r) => r.replace(/\/+$/, '').replace(/\\+/g, '/')))];
}

/** 是否为目标目录：dir 以 src 开头（在其子树内，含自身）。 */
function isInside(src, dir) {
  const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '');
  return norm(dir) === norm(src) || norm(dir).startsWith(norm(src) + '/');
}

/**
 * 扫描 WE 壁纸库（workshop content + 内置 projects/）
 * @returns {Promise<Array<{id, key, kind, title, file, media, preview, current}>>}
 */
export async function listWallpapers(activeFile) {
  const items = [];
  const workshopRoots = [];

  // 1) workshop 内容目录：枚举 steam 库下 431960
  for (const root of readSteamLibraryRoots()) {
    const ws = path.join(root, WORKSHOP_REL);
    if (!(await isDir(ws))) continue;
    let entries = [];
    try { entries = await fsp.readdir(ws, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const d = path.join(ws, ent.name);
      const it = await scanWallpaperDir(d, ent.name);
      if (it) items.push(it);
    }
    workshopRoots.push(ws);
  }

  // 2) WE 内置默认 projects（仅含真正可渲染媒体/网页/场景的，跳过纯静态图样本）
  const weProjects = await findWeProjects();
  for (const projDir of weProjects) {
    const it = await scanWallpaperDir(projDir, path.basename(projDir));
    if (it && (it.kind === 'video' || it.kind === 'web' || it.kind === 'scene')) items.push(it);
  }

  // 3) 标记当前激活壁纸
  if (activeFile) {
    const act = norm(activeFile);
    for (const it of items) if (it.file && norm(it.file) === act) it.current = true;
  }

  // 去重（按 file 规范化 key） + 排序：当前 > 视频 > 场景 > 图像
  const seen = new Set();
  const uniq = [];
  for (const it of items) {
    if (!it.file) continue;
    const k = norm(it.file);
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(it);
  }
  const order = { video: 0, web: 1, scene: 2, image: 3, unknown: 4 };
  uniq.sort((a, b) => (b.current?1:0) - (a.current?1:0) || (order[a.kind] ?? 9) - (order[b.kind] ?? 9) || a.title.localeCompare(b.title));
  return uniq;
}

async function isDir(p) {
  try { return (await fsp.stat(p)).isDirectory(); } catch { return false; }
}

async function scanWallpaperDir(dir, id) {
  let files = [];
  try { files = await fsp.readdir(dir); } catch { return null; }
  const isVideo = (f) => /\.(mp4|webm|mkv|mov)$/i.test(f);
  const isWeb = (f) => /\.(html|htm)$/i.test(f);
  const isPkg = (f) => /\.pkg$/i.test(f);
  const isImage = (f) => /\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(f);

  const media = files.find(isVideo) || '';
  const webFile = files.find(isWeb) || '';
  const pkgFile = files.find(isPkg) || '';
  const preview = files.find((f) => /^preview\./i.test(f)) || files.find(isImage) || '';

  let kind = 'unknown';
  if (media) kind = 'video';
  else if (webFile) kind = 'web';
  else if (pkgFile) kind = 'scene';
  else if (preview) kind = 'image';

  let title = id;
  try {
    const pj = path.join(dir, 'project.json');
    if (existsSync(pj)) { const p = JSON.parse(await fsp.readFile(pj, 'utf8')); title = p.title || p.name || id; }
  } catch { /* 忽略 */ }

  const file = media ? path.join(dir, media) : webFile ? path.join(dir, webFile) : pkgFile ? path.join(dir, pkgFile) : path.join(dir, preview);
  return {
    id,
    key: norm(file),
    kind,
    title,
    file: file || '',
    media: media ? path.join(dir, media) : '',
    preview: preview ? path.join(dir, preview) : '',
  };
}

async function findWeProjects() {
  const out = [];
  const candidates = [
    process.env.WALLPAPER_ENGINE_DIR || '',
    'D:/Program Files/Steam/steamapps/common/wallpaper_engine',
    'C:/Program Files (x86)/Steam/steamapps/common/wallpaper_engine',
  ];
  for (const base of candidates) {
    if (!base) continue;
    const projRoot = path.join(base, 'projects', 'defaultprojects');
    if (await isDir(projRoot)) {
      let entries = [];
      try { entries = await fsp.readdir(projRoot, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) if (e.isDirectory()) out.push(path.join(projRoot, e.name));
    }
  }
  return out;
}

/** 规范化路径（统一 / 分隔、去尾部斜杠）。 */
function norm(p) { return String(p || '').replace(/\\/g, '/').replace(/\/+$/, ''); }
