/**
 * dsh-tool-manager —— 可视化页面 HTTP API（服务端）
 *
 * 在 ctx.webServer 上注册 /tool-manager/api/* 路由，供侧边栏
 * 「工具管理」面板调用（同源 fetch）。
 *
 *   GET  /tool-manager/api/list     全部工具（注册表 + 自定义 + 禁用状态）
 *   POST /tool-manager/api/save     新建/更新自定义工具（保存时预检代码语法）
 *   POST /tool-manager/api/delete   删除自定义工具
 *   POST /tool-manager/api/toggle   禁用/启用任意工具
 *   POST /tool-manager/api/test     测试运行自定义工具（args + 超时）
 */
import { checkToolCodeSyntax, runToolCode, buildHelpers } from './runtime.js';
import { MANAGER_TOOL_NAMES } from './registry.js';

const MAX_BODY_BYTES = 1024 * 1024;

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

/** 保存/更新自定义工具（面板表单语义：全量字段）。 */
function applySave(registry, store, body) {
  const { id, name, description, parameters, code, enabled } = body;
  if (!name || !String(name).trim()) throw new Error('缺少工具名称');
  const payload = {
    name: String(name).trim(),
    description: String(description || ''),
    parameters: parameters && typeof parameters === 'object' ? parameters : {},
    code: String(code || ''),
    enabled: enabled !== false,
  };
  const syntaxError = checkToolCodeSyntax(payload.code);
  if (syntaxError) throw new Error(`执行代码语法错误：${syntaxError}`);

  const existing = id
    ? store.getCustom(String(id).trim()) || store.findCustomByName(String(id).trim())
    : store.findCustomByName(payload.name);

  let tool;
  let created;
  if (existing) {
    tool = store.updateCustom(existing.id, payload);
    created = false;
  } else {
    tool = store.addCustom(payload);
    created = true;
  }

  // 同步注册状态：enabled → 注册；否则注销（含改名后旧 id 的注销）
  if (existing && existing.id !== tool.id) registry.unregisterCustom(existing.id);
  if (tool.enabled) {
    registry.registerCustom(tool);
  } else {
    registry.unregisterCustom(tool.id);
  }
  return { tool, created };
}

export function installToolManagerApi(httpCtx, opts) {
  const { registry, store, logger } = opts;
  let webServer;
  try {
    webServer = httpCtx.webServer;
  } catch {
    webServer = undefined;
  }
  if (!webServer || typeof webServer.register !== 'function') {
    logger.warn?.('dsh-tool-manager: webServer 不可用，可视化页面 API 未注册');
    return [];
  }

  const disposers = [];
  const route = (path, handler) => {
    disposers.push(webServer.register({ kind: 'exact', path, handler }));
  };

  route('/tool-manager/api/list', async (_req, res) => {
    try {
      sendJson(res, 200, {
        ok: true,
        path: store.path,
        tools: registry.listAll(),
        protected: MANAGER_TOOL_NAMES,
        defaultTimeoutMs: registry.runTimeoutMs,
      });
    } catch (err) {
      sendJson(res, 200, { ok: false, error: err && err.message ? err.message : String(err) });
    }
  });

  route('/tool-manager/api/save', async (req, res) => {
    try {
      const body = await parseJsonBody(req);
      const { tool, created } = applySave(registry, store, body);
      await store.persist();
      logger.info?.(`tool-manager: ${created ? '创建' : '更新'}自定义工具「${tool.id}」（${tool.name}，enabled=${tool.enabled}）`);
      sendJson(res, 200, { ok: true, tool: registry.listAll().find((t) => t.customId === tool.id) || tool, created });
    } catch (err) {
      sendJson(res, 200, { ok: false, error: err && err.message ? err.message : String(err) });
    }
  });

  route('/tool-manager/api/delete', async (req, res) => {
    try {
      const body = await parseJsonBody(req);
      const key = String(body.id || '').trim();
      if (!key) throw new Error('缺少工具 id 或名称');
      const removed = store.removeCustom(key);
      if (!removed) throw new Error(`找不到自定义工具「${key}」（系统工具不能删除，只能禁用）`);
      registry.unregisterCustom(removed.id);
      registry.enable(removed.id);
      await store.persist();
      logger.info?.(`tool-manager: 删除自定义工具「${removed.id}」`);
      sendJson(res, 200, { ok: true, id: removed.id, removed: true });
    } catch (err) {
      sendJson(res, 200, { ok: false, error: err && err.message ? err.message : String(err) });
    }
  });

  route('/tool-manager/api/toggle', async (req, res) => {
    try {
      const body = await parseJsonBody(req);
      const name = String(body.name || '').trim();
      if (!name) throw new Error('缺少工具名');
      const disabled = body.disabled === true;
      if (disabled) registry.disable(name);
      else registry.enable(name);
      await store.persist();
      logger.info?.(`tool-manager: ${disabled ? '禁用' : '启用'}工具「${name}」`);
      sendJson(res, 200, { ok: true, name, disabled });
    } catch (err) {
      sendJson(res, 200, { ok: false, error: err && err.message ? err.message : String(err) });
    }
  });

  route('/tool-manager/api/test', async (req, res) => {
    const controller = new AbortController();
    const onClose = () => controller.abort(new Error('面板已关闭，测试已中止'));
    res.on('close', onClose);
    try {
      const body = await parseJsonBody(req);
      const key = String(body.id || '').trim();
      let tool;
      if (key) tool = store.getCustom(key) || store.findCustomByName(key);
      if (!tool) {
        // 未保存的代码直测（编辑器「试运行」）：需要 code
        const rawCode = String(body.code || '');
        if (!rawCode.trim()) throw new Error('缺少工具 id 或执行代码');
        const syntaxError = checkToolCodeSyntax(rawCode);
        if (syntaxError) throw new Error(`执行代码语法错误：${syntaxError}`);
        tool = { id: '(未保存)', name: String(body.name || '未命名工具'), code: rawCode };
      }
      const args = body.args !== undefined && body.args !== null ? body.args : {};
      if (args && typeof args !== 'object' || Array.isArray(args)) {
        throw new Error('测试参数必须是 JSON 对象');
      }
      const timeoutMs = Number(body.timeoutMs) > 0 ? Number(body.timeoutMs) : registry.runTimeoutMs;
      const startedAt = Date.now();
      const { value, logs } = await runToolCode(tool.code, args, buildHelpers(), {
        timeoutMs,
        signal: controller.signal,
      });
      sendJson(res, 200, {
        ok: true,
        id: tool.id,
        name: tool.name,
        elapsedMs: Date.now() - startedAt,
        logs,
        result: value,
        resultText: formatResult(value),
      });
    } catch (err) {
      if (res.writableEnded) return;
      sendJson(res, 200, { ok: false, error: err && err.message ? err.message : String(err) });
    } finally {
      res.off('close', onClose);
    }
  });

  logger.info?.('dsh-tool-manager: 可视化页面 API 已注册（/tool-manager/api/*）');
  return disposers;
}

function formatResult(value) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
