/**
 * dsh-memory-admin —— 可视化页面 HTTP API（服务端）
 *
 * 在 ctx.webServer 上注册 /memory-admin/api/* 路由，供设置页中的
 * "记忆管理"可视化 section 调用（同源 fetch，无需任何协议依赖）。
 *
 * 读接口：
 *   GET /memory-admin/api/list?category=&keyword=&tag=&scope=&limit=&offset=
 *   GET /memory-admin/api/stats
 * 写接口（POST，JSON body）：
 *   POST /memory-admin/api/add     {content, category?, importance?, tags?, scope?, workspaceId?, sessionId?}
 *   POST /memory-admin/api/edit    {id, content?, category?, importance?, tags?, scope?, workspaceId?, sessionId?}
 *   POST /memory-admin/api/delete  {id}
 *
 * scope：global（所有会话）/ workspace（需 workspaceId）/ session（需 sessionId，默认）。
 */
import { CATEGORIES, SCOPES } from './store.js';

const MAX_BODY_BYTES = 1024 * 1024;

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

/** 读取请求体（带大小上限），返回字符串。 */
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

/** 注册可视化 API 路由；返回取消注册函数数组。webServer 不可用时返回空数组。 */
export function installMemoryApi(ctx, store) {
  let webServer;
  try {
    webServer = ctx.webServer;
  } catch {
    webServer = undefined;
  }
  if (!webServer || typeof webServer.register !== 'function') {
    ctx.logger.warn('dsh-memory-admin: webServer 不可用，可视化页面 API 未注册（对话工具仍可用）');
    return [];
  }

  const disposers = [];
  const route = (path, handler) => {
    disposers.push(webServer.register({ kind: 'exact', path, handler }));
  };

  route('/memory-admin/api/list', (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 500);
    const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0);
    const rawCategory = url.searchParams.get('category') ?? undefined;
    const category = rawCategory && CATEGORIES.includes(rawCategory) ? rawCategory : undefined;
    const keyword = url.searchParams.get('keyword') ?? undefined;
    const tag = url.searchParams.get('tag') ?? undefined;
    const rawScope = url.searchParams.get('scope') ?? undefined;
    const scope = rawScope && SCOPES.includes(rawScope) ? rawScope : undefined;
    const workspaceId = url.searchParams.get('workspaceId') ?? undefined;
    const sessionId = url.searchParams.get('sessionId') ?? undefined;
    const memories = store.list({ category, keyword, tag, scope, workspaceId, sessionId, limit, offset });
    sendJson(res, 200, { ok: true, count: memories.length, memories });
  });

  route('/memory-admin/api/stats', (_req, res) => {
    sendJson(res, 200, { ok: true, stats: store.stats({ limit: 20 }) });
  });

  route('/memory-admin/api/add', async (req, res) => {
    try {
      const body = await parseJsonBody(req);
      const id = store.add({
        content: body.content,
        category: body.category,
        importance: body.importance,
        tags: body.tags,
        scope: body.scope,
        workspaceId: body.workspaceId,
        sessionId: body.sessionId,
      });
      sendJson(res, 200, { ok: true, id, memory: store.get(id) });
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err.message });
    }
  });

  route('/memory-admin/api/edit', async (req, res) => {
    try {
      const body = await parseJsonBody(req);
      const id = Number(body.id);
      if (!Number.isInteger(id)) throw new Error('缺少记忆 ID');
      const memory = store.update(id, {
        content: body.content,
        category: body.category,
        importance: body.importance,
        tags: body.tags,
        scope: body.scope,
        workspaceId: body.workspaceId,
        sessionId: body.sessionId,
      });
      if (!memory) {
        sendJson(res, 404, { ok: false, error: `未找到记忆 #${id}` });
        return;
      }
      sendJson(res, 200, { ok: true, id, memory });
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err.message });
    }
  });

  route('/memory-admin/api/delete', async (req, res) => {
    try {
      const body = await parseJsonBody(req);
      const id = Number(body.id);
      if (!Number.isInteger(id)) throw new Error('缺少记忆 ID');
      const deleted = store.delete(id);
      sendJson(res, deleted ? 200 : 404, { ok: deleted, id, deleted });
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err.message });
    }
  });

  ctx.logger.info('dsh-memory-admin: 可视化页面 API 已注册（/memory-admin/api/*）');
  return disposers;
}
