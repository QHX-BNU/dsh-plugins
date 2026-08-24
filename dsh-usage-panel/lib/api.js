/**
 * dsh-usage-panel —— 用量/费用 HTTP API（服务端）
 *
 * 在 ctx.webServer 上注册 /dsh-usage/api/* 路由，供浏览器端的「用量」面板调用
 * （同源 fetch，无需任何协议依赖）。
 *
 * 读接口：
 *   GET /dsh-usage/api/summary
 *        → { ok, balance?: { available, currency, totals: {...} },
 *            tokens: { input, output, cacheRead, cacheWrite, reasoning, total },
 *            byModel: [{ provider, model, tokens: {...}, costCny, costUsd, sessions }],
 *            byDay: [{ date, tokens: { input, output, total } }],
 *            sessions: Number, costCny, costUsd, currency, pricedAt }
 *      （会话读取失败或余额不可用时仍返回部分数据，不整体报错。）
 */
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { priceOf } from './index.js';

/** 汇总读取的最大会话数上限（避免大库拖慢面板）。 */
const MAX_SESSIONS = 200;

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  try {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
    });
  } catch {
    /* 连接可能已断开 */
  }
  res.end(body);
}

function emptyTokens() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 };
}

function addTokens(into, usage) {
  if (!usage || typeof usage !== 'object') return;
  const input = Number(usage.inputTokens) || 0;
  const output = Number(usage.outputTokens) || 0;
  const cacheRead = Number(usage.cacheReadTokens) || 0;
  const cacheWrite = Number(usage.cacheWriteTokens) || 0;
  const reasoning = Number(usage.reasoningTokens) || 0;
  into.input += input;
  into.output += output;
  into.cacheRead += cacheRead;
  into.cacheWrite += cacheWrite;
  into.reasoning += reasoning;
  into.total += input + output + cacheRead + cacheWrite + reasoning;
}

/** 从 DeepSeek 官方 /user/balance 读取账户余额。 */
async function fetchDeepSeekBalance(homeDir) {
  const credFile = path.join(homeDir, '.credentials.yaml');
  let key = '';
  try {
    const raw = await fsp.readFile(credFile, 'utf8');
    const m = raw.match(/DEEPSEEK_API_KEY:\s*['"]?([^'"\r\n]+)['"]?/);
    if (m) key = m[1].trim();
  } catch {
    return null;
  }
  if (!key) return null;
  try {
    const res = await fetch('https://api.deepseek.com/user/balance', {
      method: 'GET',
      headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const body = await res.json();
    if (!body || !Array.isArray(body.balance_infos)) return null;
    return body;
  } catch {
    return null;
  }
}

/** 读取一个会话的 events（优先 live，回退 persisted），失败返回 null。 */
async function readSessionEvents(sessionQuery, sessions, record) {
  const id = typeof record === 'object' && record ? record.header?.id ?? record.id : null;
  if (!id) return [];
  // 优先取 live 会话（速度快、含最新用量）
  try {
    const live = sessions ? sessions.get(id) : undefined;
    if (live && Array.isArray(live.events)) return live.events;
  } catch {
    /* ignore */
  }
  try {
    const loaded = await sessionQuery.readSession(id);
    if (loaded && Array.isArray(loaded.events)) return loaded.events;
  } catch {
    /* ignore broken session */
  }
  return [];
}

/** 汇总各会话 Token 用量：按模型拆分 + 按天拆分。maxSessions=0 表示读取全部会话。 */
async function summarizeTokens(sessionQuery, sessions, priceOverrides, maxSessions) {
  const totals = emptyTokens();
  const byModel = new Map();
  const byDay = new Map();
  let sessionCount = 0;

  let records = [];
  try {
    records = await sessionQuery.listSessions();
  } catch {
    records = [];
  }
  // 按创建时间倒序；maxSessions>0 时只取最近 N 个（0 = 全部，取完整官方累计）
  const sorted = [...records].sort(
    (a, b) => new Date(a?.header?.createdAt ?? 0).getTime() - new Date(b?.header?.createdAt ?? 0).getTime(),
  );
  const recent = maxSessions && maxSessions > 0 ? sorted.slice(-maxSessions) : sorted;

  for (const record of recent) {
    const events = await readSessionEvents(sessionQuery, sessions, record);
    let hasUsage = false;
    let sessionInput = 0;
    for (const event of events) {
      const data = event?.data;
      const usage = data?.usage;
      if (!usage) continue;
      const provider = typeof data?.provider === 'string'
        ? data.provider
        : typeof event?.source?.provider === 'string'
          ? event.source.provider
          : 'unknown';
      const model = typeof data?.model === 'string'
        ? data.model
        : typeof event?.source?.model === 'string'
          ? event.source.model
          : 'unknown';
      const tk = emptyTokens();
      addTokens(tk, usage);
      addTokens(totals, usage);
      hasUsage = true;
      sessionInput += tk.input + tk.cacheRead + tk.cacheWrite;

      const mkey = `${provider}\u0000${model}`;
      let m = byModel.get(mkey);
      if (!m) {
        m = { provider, model, tokens: emptyTokens(), sessions: 0 };
        byModel.set(mkey, m);
      }
      m.sessions = 1;
      addTokens(m.tokens, usage);

      const date = String(typeof data?.time === 'string'
        ? data.time
        : typeof event?.time === 'string'
          ? event.time
          : '')
        .slice(0, 10);
      if (date) {
        let d = byDay.get(date);
        if (!d) { d = { date, tokens: emptyTokens() }; byDay.set(date, d); }
        addTokens(d.tokens, usage);
      }
    }
    if (hasUsage) sessionCount += 1;
  }

  const resolvedByModel = [...byModel.values()]
    .sort((a, b) => b.tokens.total - a.tokens.total)
    .map((m) => {
      const p = priceOf(m.model, priceOverrides);
      const costCny = (m.tokens.input / 1e6 * p.inputPerM)
        + (m.tokens.cacheRead / 1e6 * p.cacheReadPerM)
        + (m.tokens.cacheWrite / 1e6 * p.cacheWritePerM)
        + (m.tokens.output / 1e6 * p.outputPerM);
      // USD / CNY 约 7.1（估算，仅作展示参考）
      return { provider: m.provider, model: m.model, tokens: m.tokens, sessions: m.sessions, costCny, costUsd: costCny / 7.1 };
    });

  const byDayResolved = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-31);
  const costCnyTotal = resolvedByModel.reduce((n, m) => n + m.costCny, 0);

  return {
    tokens: totals,
    byModel: resolvedByModel,
    byDay: byDayResolved,
    sessions: sessionCount,
    costCny: costCnyTotal,
    costUsd: costCnyTotal / 7.1,
  };
}

export function installUsageApi(ctx, options) {
  const { sessionQuery, balanceEnabled, currency, priceOverrides, maxSessions } = options;
  // 服务端缓存摘要 30 秒，避免每次刷新都重读全部会话（会话读取可能较慢）。
  const CACHE_TTL_MS = 30000;
  let cache = null;
  let cacheAt = 0;

  let webServer;
  try {
    webServer = ctx.webServer;
  } catch {
    webServer = undefined;
  }
  if (!webServer || typeof webServer.register !== 'function') {
    ctx.logger.warn('dsh-usage-panel: webServer 不可用，用量 API 未注册');
    return [];
  }

  const disposers = [];
  const route = (pathname, handler) => {
    disposers.push(webServer.register({ kind: 'exact', path: pathname, handler }));
  };

  route('/dsh-usage/api/summary', async (req, res) => {
    try {
      if (cache && Date.now() - cacheAt < CACHE_TTL_MS) {
        sendJson(res, 200, cache);
        return;
      }
      const homeDir = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
      let sessions;
      try {
        sessions = ctx.sessions; // live 会话注册表（可能未注入）
      } catch {
        sessions = undefined;
      }

      const tokenSummary = await summarizeTokens(sessionQuery, sessions, priceOverrides, maxSessions);
      let balance = null;
      if (balanceEnabled) {
        balance = await fetchDeepSeekBalance(homeDir);
      }

      const payload = {
        ok: true,
        source: 'official-session-usage',
        currency: currency || 'CNY',
        tokens: tokenSummary.tokens,
        byModel: tokenSummary.byModel,
        byDay: tokenSummary.byDay,
        sessions: tokenSummary.sessions,
        costCny: tokenSummary.costCny,
        costUsd: tokenSummary.costUsd,
        pricedAt: new Date().toISOString(),
      };
      if (balance && Array.isArray(balance.balance_infos) && balance.balance_infos.length > 0) {
        const info = balance.balance_infos[0];
        payload.balance = {
          available: balance.is_available !== false,
          currency: info.currency,
          total: info.total_balance,
          granted: info.granted_balance,
          toppedUp: info.topped_up_balance,
        };
      }
      cache = payload;
      cacheAt = Date.now();
      sendJson(res, 200, payload);
    } catch (err) {
      sendJson(res, 200, {
        ok: false,
        error: err && err.message ? err.message : String(err),
      });
    }
  });

  ctx.logger.info('dsh-usage-panel: 用量 API 已注册（/dsh-usage/api/*）');
  return disposers;
}
