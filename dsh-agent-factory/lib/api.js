/**
 * dsh-agent-factory —— 可视化页面 HTTP API（服务端）
 *
 * 在 ctx.webServer 上注册 /agent-factory/api/* 路由，供侧边栏
 * 「Agent 工厂」面板调用（同源 fetch）。
 *
 *   GET  /agent-factory/api/list               模板列表 + 可用模型供应商
 *   GET  /agent-factory/api/models?provider=X  某供应商的模型列表（尽力而为）
 *   POST /agent-factory/api/save               新建/更新模板
 *   POST /agent-factory/api/delete             删除模板
 *   POST /agent-factory/api/run                按模板运行子智能体（前台/后台）
 */
import { runForeground, runBackground, outputText, stopReasonText } from './runner.js';

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

/** 模板的展示视图（含统计字段）。 */
function viewAgent(agent) {
  return {
    id: agent.id,
    name: agent.name,
    description: agent.description,
    persona: agent.persona || '',
    provider: agent.provider || '',
    model: agent.model || '',
    maxTokens: agent.maxTokens || 0,
    inheritContext: !!agent.inheritContext,
    toolFilter: agent.toolFilter || { allow: [], deny: [] },
    maxDepth: agent.maxDepth || 0,
    usageCount: agent.usageCount || 0,
    createdAt: agent.createdAt || 0,
    updatedAt: agent.updatedAt || 0,
    lastUsedAt: agent.lastUsedAt || 0,
  };
}

/**
 * 注册路由；返回取消注册函数数组。
 * @param {object} httpCtx 注入后的 webServer ctx（llm/jobs 动态解析）
 * @param {object} opts    { store, logger, subagents, agents,
 *                           spawnProvider, forkProvider, runTimeoutMs }
 */
export function installAgentFactoryApi(httpCtx, opts) {
  const { store, logger, subagents, agents, spawnProvider, forkProvider, runTimeoutMs } = opts;
  let webServer;
  try {
    webServer = httpCtx.webServer;
  } catch {
    webServer = undefined;
  }
  if (!webServer || typeof webServer.register !== 'function') {
    logger.warn?.('dsh-agent-factory: webServer 不可用，可视化页面 API 未注册');
    return [];
  }

  // runner 需要的上下文门面：subagents 用插件注入的实例，jobs/llm 动态解析
  const runnerCtx = {
    subagents,
    get: (name) => (name === 'agents' ? agents : httpCtx.get(name)),
  };

  const disposers = [];
  const route = (path, handler) => {
    disposers.push(webServer.register({ kind: 'exact', path, handler }));
  };

  route('/agent-factory/api/list', async (_req, res) => {
    try {
      const llm = httpCtx.get('llm');
      let providers = [];
      if (llm && typeof llm.listProviders === 'function') {
        try {
          providers = llm.listProviders();
        } catch {
          providers = [];
        }
      }
      sendJson(res, 200, {
        ok: true,
        path: store.path,
        agents: store.list().map(viewAgent),
        providers: Array.isArray(providers) ? providers.map((p) => ({ id: p && p.id, name: p && p.name })) : [],
        spawnProvider,
        forkProvider,
        runTimeoutMs,
      });
    } catch (err) {
      sendJson(res, 200, { ok: false, error: err && err.message ? err.message : String(err) });
    }
  });

  route('/agent-factory/api/models', async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const provider = String(url.searchParams.get('provider') || '').trim();
      if (!provider) {
        sendJson(res, 200, { ok: true, provider, models: [] });
        return;
      }
      const llm = httpCtx.get('llm');
      let models = [];
      if (llm && typeof llm.listModels === 'function') {
        try {
          const raw = await llm.listModels(provider);
          if (Array.isArray(raw)) {
            models = raw.map((m) => {
              if (typeof m === 'string') return { id: m, name: m };
              const id = m && (m.id || m.name);
              return id ? { id: String(id), name: m.name ? String(m.name) : String(id) } : undefined;
            }).filter(Boolean);
          }
        } catch {
          models = [];
        }
      }
      sendJson(res, 200, { ok: true, provider, models });
    } catch (err) {
      sendJson(res, 200, { ok: false, error: err && err.message ? err.message : String(err) });
    }
  });

  route('/agent-factory/api/save', async (req, res) => {
    try {
      const body = await parseJsonBody(req);
      const result = store.upsert(body);
      await store.persist();
      logger.info?.(`agent-factory: ${result.created ? '新建' : '更新'}模板「${result.agent.id}」（${result.agent.name}）`);
      sendJson(res, 200, { ok: true, agent: viewAgent(result.agent), created: result.created });
    } catch (err) {
      sendJson(res, 200, { ok: false, error: err && err.message ? err.message : String(err) });
    }
  });

  route('/agent-factory/api/delete', async (req, res) => {
    try {
      const body = await parseJsonBody(req);
      const key = String(body.id || '').trim();
      if (!key) throw new Error('缺少模板 id 或名称');
      const agent = store.get(key) || store.findByName(key);
      if (!agent) throw new Error(`找不到 Agent 模板「${key}」`);
      store.remove(agent.id);
      await store.persist();
      logger.info?.(`agent-factory: 已删除模板「${agent.id}」`);
      sendJson(res, 200, { ok: true, id: agent.id, removed: true });
    } catch (err) {
      sendJson(res, 200, { ok: false, error: err && err.message ? err.message : String(err) });
    }
  });

  route('/agent-factory/api/run', async (req, res) => {
    try {
      const body = await parseJsonBody(req);
      const key = String(body.id || '').trim();
      const task = String(body.task || '').trim();
      if (!key) throw new Error('缺少模板 id 或名称');
      if (!task) throw new Error('任务内容不能为空');
      const agent = store.get(key) || store.findByName(key);
      if (!agent) throw new Error(`找不到 Agent 模板「${key}」`);
      const sessionId = String(body.sessionId || '').trim();
      const parent = sessionId && agents ? agents.get(sessionId) : undefined;
      if (!parent) throw new Error('当前会话尚未启动，无法运行子智能体（请先新建/打开一个会话）');
      const overrides = {
        ...body.provider && String(body.provider).trim() ? { provider: String(body.provider).trim() } : {},
        ...body.model && String(body.model).trim() ? { model: String(body.model).trim() } : {},
        ...Number(body.maxTokens) > 0 ? { maxTokens: Number(body.maxTokens) } : {},
      };
      if (body.background === true) {
        const jobId = await runBackground(runnerCtx, agent, task, parent, overrides, spawnProvider, forkProvider);
        store.bumpUsage(agent.id);
        store.persist().catch(() => {});
        sendJson(res, 200, { ok: true, kind: 'background', jobId, agentId: agent.id, name: agent.name });
        return;
      }
      const controller = new AbortController();
      let closed = false;
      const onClose = () => {
        if (!res.writableEnded) {
          closed = true;
          controller.abort(new Error('面板已关闭，运行已中止'));
        }
      };
      res.on('close', onClose);
      try {
        const result = await runForeground(runnerCtx, agent, task, parent, {
          signal: controller.signal,
          timeoutMs: runTimeoutMs,
          overrides,
          spawnProvider,
          forkProvider,
        });
        store.bumpUsage(agent.id);
        store.persist().catch(() => {});
        if (res.writableEnded) return;
        sendJson(res, 200, {
          ok: true,
          kind: 'foreground',
          agentId: agent.id,
          name: agent.name,
          stopReason: result.stopReason,
          stopReasonText: stopReasonText(result.stopReason),
          output: result.output,
          outputText: outputText(result.output),
        });
      } catch (err) {
        if (res.writableEnded) return;
        sendJson(res, 200, { ok: false, error: err && err.message ? err.message : String(err), aborted: closed });
      } finally {
        res.off('close', onClose);
      }
    } catch (err) {
      if (res.writableEnded) return;
      sendJson(res, 200, { ok: false, error: err && err.message ? err.message : String(err) });
    }
  });

  logger.info?.('dsh-agent-factory: 可视化页面 API 已注册（/agent-factory/api/*）');
  return disposers;
}
