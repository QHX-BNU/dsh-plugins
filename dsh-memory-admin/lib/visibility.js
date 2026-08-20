/**
 * dsh-memory-admin —— 记忆可见性机制
 *
 * 1. 自动记忆：真实用户消息自动沉淀进记忆库（会话级留档，可配置开关）。
 * 2. 对话开始加载记忆（核心需求）：在 agent/pre-step 钩子中，只在
 *    「对话开始」（每个会话首次用户消息）时，把 全局记忆 + 当前工作区
 *    记忆 作为一条 "context" 消息注入本次请求——
 *    · 模型可见：注入的消息进入 LLM 请求历史，模型真正"用上"记忆；
 *    · 用户可见：注入的消息以 source.kind !== 'user' 的 user/message
 *      追加进会话日志，Web UI 会把它渲染为上下文块（context chip），
 *      对话里直接看到"本次对话加载了哪些记忆模块"。
 *    会话记忆仅作留档，不注入 context；之后的用户消息也不再注入。
 * 3. 每次注入都写入 memory_loads 表（审计 + memory_loaded 查询）。
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { CATEGORY_LABELS, SCOPE_LABELS } from './store.js';
import { resolveWorkspaceId, hasPriorUserMessage } from './context.js';

/** 从 ContentBlock[] 提取纯文本。 */
export function extractText(blocks) {
  const parts = [];
  for (const block of blocks ?? []) {
    if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join('\n').trim();
}

/** 渲染注入的"记忆加载"上下文消息文本。 */
export function renderMemoryContext(loaded, config) {
  const lines = [];
  lines.push(`<memory-context>`);
  lines.push(`【记忆模块加载】本次对话从长期记忆库加载了 ${loaded.length} 条记忆模块，供你参考（用户可通过 memory_edit/memory_delete 直接修改它们）：`);
  lines.push('');
  for (const { memory, score } of loaded) {
    lines.push(`[记忆 #${memory.id} · ${SCOPE_LABELS[memory.scope] ?? memory.scope} · ${CATEGORY_LABELS[memory.category] ?? memory.category} · 重要度 ${memory.importance} · 相关度 ${score.toFixed(2)}]`);
    lines.push(memory.content);
    lines.push('');
  }
  lines.push(`</memory-context>`);
  return lines.join('\n');
}

/** 安装自动记忆 + 对话加载钩子（随插件卸载自动移除）。 */
export function installMemoryHooks(ctx, store, config) {
  const processedMessages = new Map(); // sessionId -> Set<messageId>：已处理过召回的 user 消息
  // 会话可能长期存在/大量切换，跟踪表需设上限，超出时淘汰最旧会话（Map 插入序）
  const PROCESSED_SESSION_CAP = 200;
  const markProcessed = (sessionId, seen) => {
    processedMessages.delete(sessionId);
    processedMessages.set(sessionId, seen);
    while (processedMessages.size > PROCESSED_SESSION_CAP) {
      const oldest = processedMessages.keys().next().value;
      if (oldest === undefined) break;
      processedMessages.delete(oldest);
    }
  };

  // ---- 自动记忆：真实用户消息沉淀进记忆库 ----
  if (config.autoRemember) {
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'user/message') return;
      const source = event.data.source;
      if (!source || source.kind !== 'user') return; // 只记真实用户输入，跳过插件注入
      const text = extractText(event.data.content);
      if (!text) return;
      // 子代理的提示词也是 kind:'user'，但不应污染主记忆库（除非显式开启）
      if (!config.autoRememberSubagent) {
        try {
          const agent = ctx.agents?.get?.(session.id);
          const roots = ctx.agents?.roots?.();
          if (agent !== undefined && Array.isArray(roots) && !roots.includes(agent)) return;
        } catch {
          /* agents 服务不可用时回退为全部记录 */
        }
      }
      try {
        const dup = store.findDuplicate(text);
        if (dup === undefined) {
          // 自动记忆默认落在"会话"层：只对当前会话可见，不污染其他会话/工作区。
          const id = store.add({
            content: text,
            category: 'knowledge',
            importance: config.autoRememberImportance,
            tags: ['dsh', 'user', 'auto'],
            scope: 'session',
            sessionId: session.id,
          });
          ctx.logger.info(`dsh-memory-admin: 已自动记忆用户消息 #${id}（会话级）`);
        }
      } catch (err) {
        ctx.logger.warn(`dsh-memory-admin: 自动记忆失败: ${err.message}`);
      }
    });
  }

  // ---- 对话开始加载记忆（用户需求）：只在会话开始时注入一次 ----
  // · 只有「对话开始」（该会话的第一条真实用户消息）才加载并注入
  //   「全局记忆 + 当前工作区记忆」（按重要度降序，全部注入）；
  // · 判断依据是会话历史：只要本次消息之前已经存在更早的真实用户消息，
  //   就不算对话开始（即使插件/运行时中途重启过，也不会重复注入）；
  // · 会话记忆仅作留档，不注入 context；之后的用户消息也不再注入。
  if (config.recallEnabled) {
    ctx.on('agent/pre-step', async ({ agent, messages, step, signal }, next) => {
      const decision = await next();
      if (!decision || decision.kind !== 'enter') return decision;
      if (step !== 1) return decision; // 只在回合第一步处理
      const session = agent.session;
      const sessionId = String(session.id ?? 'unknown');

      // 找到本次被 claim 的真实用户消息（还没有处理过的）
      const claimedIds = new Set(messages.map((m) => m.id));
      const freshUserMessages = decision.messages.filter(
        (m) => m && m.role === 'user' && m.source?.kind === 'user' && claimedIds.has(m.id),
      );
      if (freshUserMessages.length === 0) return decision;
      const seen = processedMessages.get(sessionId) ?? new Set();
      const newMessages = freshUserMessages.filter((m) => !seen.has(m.id));
      if (newMessages.length === 0) return decision;

      // 历史里是否已有更早的真实用户消息（= 这个会话不是刚刚开始）
      // 注意：decision.messages 只含本次 claim 的消息，必须查会话事件日志 session.log
      const priorUser = hasPriorUserMessage(session.log, claimedIds);

      const query = newMessages.map((m) => extractText(m.content)).join('\n').trim();
      for (const m of newMessages) seen.add(m.id);
      markProcessed(sessionId, seen);
      // 非对话开始（或空消息）：只标记已处理，不注入
      if (priorUser || !query) return decision;

      // 全局 + 当前工作区记忆（会话记忆仅留档，不注入）
      const workspaceId = resolveWorkspaceId(ctx, sessionId);
      const loaded = store.listInjectionCandidates({ workspaceId }).map((memory) => ({ memory, score: 1 }));

      if (loaded.length === 0) return decision;
      if (!config.injectContext) {
        // 不注入时仍记录加载（供 memory_loaded 查询）
        for (const { memory, score } of loaded) store.recordLoad(sessionId, memory.id, score);
        return decision;
      }

      signal?.throwIfAborted?.();
      for (const { memory, score } of loaded) store.recordLoad(sessionId, memory.id, score);

      const text = renderMemoryContext(loaded, config);
      const contextMessage = createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'memory-admin', plugin: 'dsh-memory-admin' },
      });

      // 插到被 claim 消息之后（与 agent-instructions 相同的插入策略）
      const claimedSet = new Set(decision.messages.map((m, i) => (claimedIds.has(m.id) ? i : -1)));
      let lastClaimedIndex = -1;
      for (let i = 0; i < decision.messages.length; i++) {
        if (claimedSet.has(i)) lastClaimedIndex = i;
      }
      const messages2 = [...decision.messages];
      messages2.splice(lastClaimedIndex + 1, 0, contextMessage);
      ctx.logger.info(
        `dsh-memory-admin: 会话 ${sessionId.slice(0, 8)}… 对话开始时加载了 ${loaded.length} 条记忆（${loaded.map((l) => `#${l.memory.id}`).join(', ')}）`,
      );
      return { ...decision, messages: messages2 };
    });
  }
}
