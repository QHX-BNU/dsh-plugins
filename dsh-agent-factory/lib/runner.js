/**
 * dsh-agent-factory —— 子智能体运行逻辑（工具与 HTTP API 共用）
 *
 * 依据模板把任务委派给一个真正的 DSH 子智能体：
 * - 子智能体 provider：inheritContext=true 用 fork（继承父对话历史），
 *   否则用 spawn（全新上下文）；
 * - request.agentOptions.{provider,model,maxTokens} 覆盖子智能体的
 *   模型路由（供应商/模型/上限），留空字段继承调用方；
 * - request.persona 作为子智能体的系统提示（persona section）；
 * - request.toolFilter 限制子智能体可见工具；
 * - request.maxDepth 限制递归委派深度（0 = provider-managed）。
 */

/** 把子智能体运行的 stopReason 转成一句中文说明。 */
export function stopReasonText(stopReason) {
  switch (stopReason) {
    case 'completed': return '已完成';
    case 'aborted': return '被中止';
    case 'error': return '运行出错';
    case 'max-tokens': return '达到 token 上限提前结束';
    case 'refusal': return '拒绝执行任务';
    default: return `异常结束（${String(stopReason)}）`;
  }
}

/** 取运行结果的纯文本（拼合所有 text 块）。 */
export function outputText(output) {
  if (!Array.isArray(output)) return '';
  return output
    .filter((b) => b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
}

/** 按模板 + 覆盖项组装 subagent 请求。 */
export function buildRequest(preset, task, overrides) {
  const o = overrides && typeof overrides === 'object' ? overrides : {};
  const provider = String(o.provider !== undefined ? o.provider : preset.provider || '').trim();
  const model = String(o.model !== undefined ? o.model : preset.model || '').trim();
  const maxTokens = Number(o.maxTokens !== undefined ? o.maxTokens : preset.maxTokens || 0);
  const agentOptions = {};
  if (provider) agentOptions.provider = provider;
  if (model) agentOptions.model = model;
  if (Number.isFinite(maxTokens) && maxTokens > 0) agentOptions.maxTokens = Math.round(maxTokens);
  const filter = preset.toolFilter && typeof preset.toolFilter === 'object' ? preset.toolFilter : {};
  const toolFilter = filter.allow && filter.allow.length > 0 || filter.deny && filter.deny.length > 0 ? filter : undefined;
  const request = {
    label: preset.name || preset.id,
    prompt: [{ type: 'text', text: String(task || '').trim() }],
    ...Object.keys(agentOptions).length > 0 ? { agentOptions } : {},
    ...preset.persona && preset.persona.trim() ? { persona: preset.persona } : {},
    ...toolFilter ? { toolFilter } : {},
    ...preset.maxDepth > 0 ? { maxDepth: preset.maxDepth } : {},
  };
  return { request, agentOptions };
}

/** 前台运行：等待子智能体结束并释放 run 句柄。 */
export async function collectForeground(run) {
  let result;
  try {
    result = await run.result;
  } finally {
    try {
      await run.dispose();
    } catch {
      /* 释放失败不掩盖结果本身 */
    }
  }
  return { stopReason: result.stopReason, output: Array.isArray(result.output) ? result.output : [] };
}

/** 前台运行（带超时与外部取消信号）。 */
export async function runForeground(ctx, preset, task, parent, {
  signal,
  timeoutMs,
  overrides,
  spawnProvider,
  forkProvider,
} = {}) {
  const { request } = buildRequest(preset, task, overrides);
  const controller = new AbortController();
  const timeout = timeoutMs > 0
    ? setTimeout(() => controller.abort(new Error(`运行超过 ${Math.round(timeoutMs / 60000)} 分钟，已中止`)), timeoutMs)
    : undefined;
  const outer = signal;
  const onOuterAbort = () => controller.abort(outer && outer.reason ? outer.reason : new Error('已取消'));
  if (outer) {
    if (outer.aborted) onOuterAbort();
    else outer.addEventListener('abort', onOuterAbort, { once: true });
  }
  try {
    const run = await ctx.subagents.start(providerOf(ctx, preset, spawnProvider, forkProvider), {
      ...request,
      parent,
      signal: controller.signal,
    });
    return await collectForeground(run);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (outer) outer.removeEventListener('abort', onOuterAbort);
  }
}

/** 后台运行：交给 jobs 服务，立即返回 jobId（GUI 任务面板可见）。 */
export async function runBackground(ctx, preset, task, parent, overrides, spawnProvider, forkProvider) {
  const jobs = ctx.get('jobs');
  if (!jobs || typeof jobs.start !== 'function') {
    throw new Error('后台任务服务不可用（未加载 @deepseek-ai/dsh-jobs）');
  }
  const { request } = buildRequest(preset, task, overrides);
  return jobs.start({
    kind: 'agent-factory',
    label: `${preset.name || preset.id}${task ? ' · ' + String(task).slice(0, 24) : ''}`,
    owner: parent,
    run: () => {
      const controller = new AbortController();
      return {
        cancel: (reason) => controller.abort(reason || new Error('后台子智能体任务被取消')),
        done: (async () => {
          try {
            const run = await ctx.subagents.start(providerOf(ctx, preset, spawnProvider, forkProvider), {
              ...request,
              parent,
              signal: controller.signal,
            });
            const { stopReason, output } = await collectForeground(run);
            return { status: 'completed', stopReason, output };
          } catch (err) {
            return { status: 'failed', detail: err && err.message ? err.message : String(err) };
          }
        })(),
      };
    },
  });
}

/** 解析子智能体 provider（spawn / fork 或自定义配置），缺失时给出明确报错。 */
export function providerOf(ctx, preset, spawnProvider, forkProvider) {
  const name = preset.inheritContext ? forkProvider : spawnProvider;
  if (ctx.subagents.getProvider(name)) return name;
  let available = [];
  try {
    available = ctx.subagents.list();
  } catch {
    /* 枚举失败时只报缺省错误 */
  }
  throw new Error(`子智能体 provider「${name}」未注册（可用：${available.length ? available.join(', ') : '无'}）`);
}
