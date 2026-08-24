/**
 * dsh-wallpaper-sync —— 同源 HTTP API（服务端）
 *
 * 在 ctx.webServer 上注册：
 *   GET /wallpaper-sync/api/current
 *        → { ok, kind, file, monitor, title, mediaUrl, mediaType, sceneFrame, sceneFrameType }
 *          kind: video/web/scene/image/unknown —— 前端据此选择渲染方式
 *   GET /wallpaper-sync/api/media
 *        → 直接把「当前壁纸源文件」流式返回（图片/视频二进制，或 text/html）。
 *          支持 HTTP Range（视频拖动/分段下载必需），并严格受白名单校验：
 *          仅允许返回当前壁纸源文件本体，或 Scene 目录下的静态帧。
 *   GET /wallpaper-sync/api/status
 *        → { ok, file, monitor, kind, lastModified, size, title, fallback }
 *          前端轮询它判断桌面壁纸是否切换（file/monitor 变了 → 重新加载）。
 *
 * 安全边界：media 只能提供 resolveWallpaper 当前解析出的源文件或 Scene 帧，
 * 不接受任意路径参数，杜绝目录穿越读到别的文件。
 */
import { promises as fsp, createReadStream } from 'node:fs';
import path from 'node:path';
import {
  detectWeConfigPath,
  readCurrentWallpaper,
  resolveWallpaper,
  listWallpapers,
  MEDIA_MIME,
  IMAGE_MIME,
} from './we.js';

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

/** 流式返回文件，支持 Range。 */
function serveFileStream(req, res, file, contentType) {
  const statP = fsp.stat(file);
  statP
    .then((stat) => {
      const size = stat.size;
      const range = req && req.headers && req.headers.range;
      // 解析单段 Range: bytes=start-end
      let start = 0;
      let end = size - 1;
      let useRange = false;
      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range);
        if (m) {
          useRange = true;
          if (m[1]) start = parseInt(m[1], 10);
          if (m[2]) end = parseInt(m[2], 10);
          else end = size - 1;
          if (start > end) {
            res.writeHead(416, { 'content-range': `bytes */${size}` });
            res.end();
            return;
          }
        }
      }
      const headers = {
        'content-type': contentType,
        'accept-ranges': 'bytes',
        'cache-control': 'no-store',
      };
      if (useRange) {
        headers['content-range'] = `bytes ${start}-${end}/${size}`;
        headers['content-length'] = end - start + 1;
        res.writeHead(206, headers);
      } else {
        headers['content-length'] = size;
        res.writeHead(200, headers);
      }
      const stream = createReadStream(file, { start, end });
      stream.on('error', () => {
        try {
          res.end();
        } catch {
          /* 已结束 */
        }
      });
      stream.pipe(res);
    })
    .catch(() => {
      if (!res.headersSent) sendJson(res, 404, { ok: false, error: 'wallpaper-not-found' });
    });
}

const MEDIA_TYPE_OF = (file) => {
  const ext = path.extname(String(file || '')).slice(1).toLowerCase();
  return MEDIA_MIME[ext] || IMAGE_MIME[ext] || 'application/octet-stream';
};

/** 给定「规范化 key」返回其媒体文件与 MIME；找不到返回 null。 */
async function resolveByKey(key) {
  if (!key) return null;
  // 只允许来自壁纸库的条目（白名单），避免任意文件读取
  const lib = await listWallpapers('');
  const item = lib.find((x) => norm(x.key) === norm(key));
  if (!item) return null;
  if (item.kind === 'scene') {
    // Scene：返回其预览帧（若有）
    if (item.preview) return { file: item.preview, contentType: MEDIA_TYPE_OF(item.preview) };
    return null;
  }
  if (item.media) return { file: item.media, contentType: MEDIA_TYPE_OF(item.media) };
  if (item.file) return { file: item.file, contentType: MEDIA_TYPE_OF(item.file) };
  return null;
}

function norm(p) { return String(p || '').replace(/\\/g, '/').replace(/\/+$/, ''); }

/** 注册 API 路由；返回取消注册函数数组。 */
export function installWallpaperSyncApi(ctx, options) {
  let webServer;
  try {
    webServer = ctx.webServer;
  } catch {
    webServer = undefined;
  }
  if (!webServer || typeof webServer.register !== 'function') {
    ctx.logger.warn('dsh-wallpaper-sync: webServer 不可用，API 未注册');
    return [];
  }

  const { weConfigPath, monitor, pollIntervalMs, fallbackOnError } = options;
  const disposers = [];
  let current = null; // 最近一次解析出的 { resolved, file, monitor, title, mtime, size }
  let lastRead = 0;
  const throttle = (pollIntervalMs || 3000) / 2;

  const route = (pathname, handler) => {
    disposers.push(webServer.register({ kind: 'exact', path: pathname, handler }));
  };

  /** 读 WE 当前壁纸（带节流：半倍轮询间隔内复用缓存）。 */
  async function refreshCurrent(force) {
    const now = Date.now();
    if (!force && current && now - lastRead < throttle) return current;
    lastRead = now;
    const cfgPath = (await detectWeConfigPath(weConfigPath)) || weConfigPath;
    const found = await readCurrentWallpaper(cfgPath, monitor);
    if (!found) {
      current = null;
      return null;
    }
    const resolved = resolveWallpaper(found.file);
    let size = 0;
    try {
      const st = await fsp.stat(found.file);
      size = st.size;
    } catch {
      /* 文件可能暂时不可读 */
    }
    current = {
      resolved,
      file: found.file,
      monitor: found.monitor,
      title: found.title,
      size,
    };
    return current;
  }

  // 当前壁纸元数据
  route('/wallpaper-sync/api/current', async (req, res) => {
    try {
      const info = await refreshCurrent(false);
      if (!info) {
        return sendJson(res, 200, { ok: false, error: 'no-wallpaper', fallback: !!fallbackOnError, monitor, weConfigPath });
      }
      const r = info.resolved;
      return sendJson(res, 200, {
        ok: true,
        kind: r.kind,
        file: info.file,
        monitor: info.monitor,
        title: info.title,
        mediaUrl: r.mediaUrl,
        mediaType: r.mediaType || null,
        sceneFrame: r.sceneFrame || null,
        sceneFrameType: r.sceneFrameType || null,
        fallback: !!fallbackOnError,
        weConfigPath,
      });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err.message });
    }
  });

  // 轮询状态（用于跟随切换）
  route('/wallpaper-sync/api/status', async (req, res) => {
    try {
      const info = await refreshCurrent(false);
      if (!info) return sendJson(res, 200, { ok: false, error: 'no-wallpaper' });
      const r = info.resolved;
      return sendJson(res, 200, {
        ok: true,
        file: info.file,
        monitor: info.monitor,
        kind: r.kind,
        size: info.size,
        title: info.title,
      });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err.message });
    }
  });

  // 壁纸库列表（供选择器）
  route('/wallpaper-sync/api/library', async (req, res) => {
    try {
      const info = await refreshCurrent(false);
      const activeFile = info ? info.file : '';
      const items = await listWallpapers(activeFile);
      // 返回精简字段（不含绝对路径敏感信息给前端预览直接用 key）
      const out = items.map((it) => ({
        key: it.key,
        id: it.id,
        kind: it.kind,
        title: it.title,
        current: !!it.current,
        previewUrl: it.preview ? `/wallpaper-sync/api/preview?key=${encodeURIComponent(it.key)}` : '',
        mediaUrl: it.media || it.file ? `/wallpaper-sync/api/media?key=${encodeURIComponent(it.key)}` : '',
      }));
      return sendJson(res, 200, { ok: true, monitor, items: out, activeFile });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err.message });
    }
  });

  // 缩略图/预览帧：仅供库条目 key
  route('/wallpaper-sync/api/preview', async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const key = url.searchParams.get('key') || '';
      const lib = await listWallpapers('');
      const item = lib.find((x) => norm(x.key) === norm(key));
      if (!item || !item.preview) return sendJson(res, 404, { ok: false, error: 'no-preview' });
      return serveFileStream(req, res, item.preview, MEDIA_TYPE_OF(item.preview));
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err.message });
    }
  });

  // 媒体流：壁纸源文件或 Scene 静态帧；若带 ?key= 则返回库中指定壁纸
  route('/wallpaper-sync/api/media', async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const key = url.searchParams.get('key') || '';
      if (key) {
        const r = await resolveByKey(key);
        if (!r) return sendJson(res, 404, { ok: false, error: 'no-library-item' });
        return serveFileStream(req, res, r.file, r.contentType);
      }
      const info = await refreshCurrent(false);
      if (!info) return sendJson(res, 404, { ok: false, error: 'no-wallpaper' });
      const r = info.resolved;
      let file = '';
      let contentType = '';
      if (r.kind === 'scene') {
        file = r.sceneFrame || '';
        contentType = r.sceneFrameType || 'image/jpeg';
      } else {
        file = info.file;
        contentType = r.mediaType || MEDIA_TYPE_OF(info.file);
      }
      if (!file) return sendJson(res, 404, { ok: false, error: 'no-renderable-source' });
      return serveFileStream(req, res, file, contentType);
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err.message });
    }
  });

  return disposers;
}
