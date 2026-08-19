/**
 * dsh-memory-admin —— 记忆管理工具集
 *
 * 通过 ctx.tools.register 注册，Agent 可直接调用：
 *   memory_list    列出/过滤记忆
 *   memory_view    查看单条记忆
 *   memory_search  按语义相关度搜索召回记忆
 *   memory_add     新增记忆
 *   memory_edit    修改记忆内容（直接编辑）
 *   memory_delete  删除记忆
 *   memory_stats   记忆库统计（含最近加载记录）
 *   memory_loaded  当前会话已加载的记忆
 *
 * 注意：defineTool 的 parameters 根节点是"属性映射"（{参数名: 值规格}），
 * 不能包 { type:'object', properties } —— 后者会导致启动报
 * "parameters.type must be a value schema object"。
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { CATEGORIES, CATEGORY_LABELS, SCOPES, SCOPE_LABELS } from './store.js';
import { recall } from './recall.js';
import { currentContext, listWorkspaces } from './context.js';

function textBlock(text) {
  return [{ type: 'text', text }];
}

function scopeHint(m) {
  if (m.scope === 'workspace') return `工作区 ${String(m.workspaceId).slice(0, 12)}…`;
  if (m.scope === 'session') {
    return m.sessionId ? `会话 ${String(m.sessionId).slice(0, 8)}…` : '会话（未绑定）';
  }
  return '全局';
}

function fmtMemory(m) {
  const tags = Array.isArray(m.tags) && m.tags.length > 0 ? ` 标签:[${m.tags.join(', ')}]` : '';
  return [
    `【记忆 #${m.id}｜${SCOPE_LABELS[m.scope] ?? m.scope}｜${CATEGORY_LABELS[m.category] ?? m.category}｜重要度 ${m.importance}】${tags}`,
    m.content,
    `（归属 ${scopeHint(m)} · 创建 ${new Date(m.createdAt).toLocaleString()} · 更新 ${new Date(m.updatedAt).toLocaleString()} · 被加载 ${m.accessCount} 次）`,
  ].join('\n');
}

function fmtList(rows) {
  if (rows.length === 0) return '（没有找到匹配的记忆）';
  return rows.map((m) => fmtMemory(m)).join('\n\n');
}

function fmtLoads(loads) {
  if (!loads || loads.length === 0) return '（暂无加载记录）';
  return loads
    .map(
      (l) =>
        `  - ${new Date(l.loadedAt).toLocaleString()} 会话 ${String(l.sessionId).slice(0, 8)}… 相关度 ${l.score.toFixed(2)}`,
    )
    .join('\n');
}

/** 注册全部记忆管理工具；返回取消注册函数。 */
export function registerMemoryTools(ctx, store) {
  const disposers = [];

  const register = (tool) => {
    disposers.push(ctx.tools.register(tool));
  };

  register(
    defineTool({
      name: 'memory_list',
      description:
        '列出长期记忆库中的记忆条目，可按分类（模块）、关键词、标签、作用域过滤。默认只列出当前会话可见的记忆（全局 + 本工作区 + 本会话）；all=true 时列出全部记忆（含其他工作区/会话）。作用域：global全局（所有会话）/workspace工作区/session会话。分类：anchor锚点层/structure结构层/knowledge知识层/situation情境层/self自我层。',
      parameters: {
        category: {
          type: 'string',
          description: `可选，按分类过滤：${CATEGORIES.join('/')}`,
        },
        keyword: { type: 'string', description: '可选，按内容关键词过滤' },
        tag: { type: 'string', description: '可选，按标签过滤' },
        scope: {
          type: 'string',
          description: `可选，按作用域过滤：${SCOPES.join('/')}（global=全局，workspace=工作区，session=会话）`,
        },
        all: {
          type: 'boolean',
          description: '可选，true 时列出全部记忆（跨所有工作区/会话），默认 false（仅当前会话可见范围）',
        },
        limit: { type: 'integer', description: '返回条数上限，默认 50，最大 200' },
        offset: { type: 'integer', description: '分页偏移，默认 0' },
      },
      output: {
        schema: { type: 'json' },
        render(_args, value) {
          return textBlock(fmtList(value.memories ?? []));
        },
      },
      isConcurrencySafe: () => true,
      execute(args, exec) {
        const limit = Math.min(Math.max(Number(args.limit) || 50, 1), 200);
        const offset = Math.max(Number(args.offset) || 0, 0);
        const category = args.category && CATEGORIES.includes(args.category) ? args.category : undefined;
        const scope = args.scope && SCOPES.includes(args.scope) ? args.scope : undefined;
        const { sessionId, workspaceId } = currentContext(ctx, exec.agent?.session?.id);
        const filters = { category, keyword: args.keyword, tag: args.tag, limit, offset };
        const memories = args.all === true
          ? store.list({ ...filters, scope })
          : store.listVisible({ ...filters, sessionId, workspaceId, scope });
        return { count: memories.length, memories, context: { sessionId, workspaceId } };
      },
    }),
  );

  register(
    defineTool({
      name: 'memory_view',
      description: '查看单条记忆的完整内容与元数据。',
      parameters: {
        id: { type: 'integer', required: true, description: '记忆 ID' },
      },
      output: {
        schema: { type: 'json' },
        render(_args, value) {
          if (!value.memory) return textBlock('（未找到该记忆）');
          return textBlock(fmtMemory(value.memory) + `\n\n最近加载历史：\n${fmtLoads(value.loadHistory)}`);
        },
      },
      isConcurrencySafe: () => true,
      execute(args) {
        const memory = store.get(Number(args.id));
        if (!memory) return { found: false, memory: null, loadHistory: [] };
        return { found: true, memory, loadHistory: store.loadHistory(memory.id) };
      },
    }),
  );

  register(
    defineTool({
      name: 'memory_search',
      description:
        '按语义相关度在长期记忆库中搜索最相关的记忆（词元重叠 + 重要度 + 时效性打分，无需 embedding）。默认只检索当前会话可见范围（全局 + 本工作区 + 本会话）。适合"我记得之前聊过/做过…"的检索。',
      parameters: {
        query: { type: 'string', required: true, description: '检索查询，描述你想找的记忆内容' },
        topK: { type: 'integer', description: '返回条数，默认 5，最大 20' },
        recordLoad: {
          type: 'boolean',
          description: '是否记录本次搜索为"记忆加载"（默认 false；仅当你真正把这些记忆用于回答时设为 true）',
        },
      },
      output: {
        schema: { type: 'json' },
        render(_args, value) {
          if (!value.results || value.results.length === 0) return textBlock('（没有找到相关记忆）');
          return textBlock(
            value.results
              .map((r) => `[相关度 ${r.score.toFixed(2)}]\n${fmtMemory(r.memory)}`)
              .join('\n\n'),
          );
        },
      },
      isConcurrencySafe: () => true,
      execute(args, exec) {
        const topK = Math.min(Math.max(Number(args.topK) || 5, 1), 20);
        const sessionId = exec.agent?.session?.id ?? null;
        const { workspaceId } = currentContext(ctx, sessionId);
        const results = recall(store, args.query, { topK, sessionId, workspaceId });
        if (args.recordLoad === true) {
          for (const { memory, score } of results) {
            store.recordLoad(sessionId ?? 'unknown', memory.id, score);
          }
        }
        return {
          query: args.query,
          count: results.length,
          context: { sessionId, workspaceId },
          results: results.map(({ memory, score }) => ({ memory, score: Number(score.toFixed(4)) })),
        };
      },
    }),
  );

  register(
    defineTool({
      name: 'memory_add',
      description:
        '向长期记忆库新增一条记忆。作用域 scope 决定哪些会话会加载它：global=全局（所有对话，适合用户偏好/长期事实，需用户显式指定）、workspace=工作区（仅该工作区下的会话）、session=会话（仅当前会话，默认）。分类：anchor锚点（基础事实/身份设定）、structure结构（流程/方法论）、knowledge知识（事实/对话沉淀）、situation情境（具体场景/事件）、self自我（偏好/反思）。',
      parameters: {
        content: { type: 'string', required: true, description: '记忆内容（要长期记住的事实/信息）' },
        scope: {
          type: 'string',
          description: `作用域，默认 session（会话级）：global/workspace/session。工作区与全局级必须由用户显式指定，不要擅自把会话内容写成全局/工作区记忆`,
        },
        workspaceId: {
          type: 'string',
          description: 'scope=workspace 时的目标工作区 id，默认取当前会话所属工作区',
        },
        sessionId: {
          type: 'string',
          description: 'scope=session 时的目标会话 id，默认取当前会话',
        },
        category: { type: 'string', description: `分类，默认 knowledge：${CATEGORIES.join('/')}` },
        importance: { type: 'number', description: '重要度 0~1，默认 0.6，越重要越容易被召回' },
        tags: { type: 'array', items: { type: 'string' }, description: '标签数组，便于检索分类' },
      },
      output: {
        schema: { type: 'json' },
        render(_args, value) {
          return textBlock(`已新增记忆 #${value.id}（${SCOPE_LABELS[value.memory.scope] ?? value.memory.scope}）：\n${fmtMemory(value.memory)}`);
        },
      },
      isConcurrencySafe: () => true,
      execute(args, exec) {
        const { sessionId, workspaceId } = currentContext(ctx, exec.agent?.session?.id);
        const scope = args.scope && SCOPES.includes(args.scope) ? args.scope : 'session';
        if (scope === 'workspace' && !args.workspaceId && !workspaceId) {
          throw new Error('当前会话不属于任何工作区，无法添加工作区记忆；请显式提供 workspaceId，或改用全局/会话层级');
        }
        const id = store.add({
          content: args.content,
          category: args.category,
          importance: args.importance,
          tags: args.tags,
          scope,
          workspaceId: args.workspaceId ?? workspaceId,
          sessionId: args.sessionId ?? sessionId,
        });
        return { id, memory: store.get(id) };
      },
    }),
  );

  register(
    defineTool({
      name: 'memory_edit',
      description:
        '直接修改记忆库中已有的记忆条目：内容、分类（模块）、重要度、标签、作用域（scope）均可改；只修改传入的字段。改作用域时：global=所有会话可见、workspace=需指定工作区、session=需指定会话。',
      parameters: {
        id: { type: 'integer', required: true, description: '要修改的记忆 ID' },
        content: { type: 'string', description: '新的记忆内容（覆盖原内容）' },
        category: { type: 'string', description: `新的分类：${CATEGORIES.join('/')}` },
        importance: { type: 'number', description: '新的重要度 0~1' },
        tags: { type: 'array', items: { type: 'string' }, description: '新的标签数组（覆盖原标签）' },
        scope: {
          type: 'string',
          description: `新的作用域：${SCOPES.join('/')}（仅当需要迁移层级时传入）`,
        },
        workspaceId: { type: 'string', description: 'scope=workspace 时的目标工作区 id，默认取当前会话所属工作区' },
        sessionId: { type: 'string', description: 'scope=session 时的目标会话 id，默认取当前会话' },
      },
      output: {
        schema: { type: 'json' },
        render(_args, value) {
          if (!value.updated) return textBlock('（未找到该记忆，无法修改）');
          return textBlock(`已修改记忆 #${value.id}：\n${fmtMemory(value.memory)}`);
        },
      },
      isConcurrencySafe: () => true,
      execute(args, exec) {
        const { sessionId, workspaceId } = currentContext(ctx, exec.agent?.session?.id);
        const patch = {
          content: args.content,
          category: args.category,
          importance: args.importance,
          tags: args.tags,
        };
        if (args.scope !== undefined) {
          if (!SCOPES.includes(args.scope)) throw new Error(`作用域必须是以下之一：${SCOPES.join(', ')}`);
          if (args.scope === 'workspace' && !args.workspaceId && !workspaceId) {
            throw new Error('当前会话不属于任何工作区，无法迁移为工作区记忆；请显式提供 workspaceId');
          }
          patch.scope = args.scope;
          patch.workspaceId = args.workspaceId ?? workspaceId;
          patch.sessionId = args.sessionId ?? sessionId;
        }
        const updated = store.update(Number(args.id), patch);
        return updated
          ? { updated: true, id: updated.id, memory: updated }
          : { updated: false, id: Number(args.id), memory: null };
      },
    }),
  );

  register(
    defineTool({
      name: 'memory_delete',
      description: '从记忆库中永久删除一条记忆（同时保留加载历史）。',
      parameters: {
        id: { type: 'integer', required: true, description: '要删除的记忆 ID' },
      },
      output: {
        schema: { type: 'json' },
        render(_args, value) {
          return textBlock(
            value.deleted
              ? `已删除记忆 #${value.id}。`
              : `（未找到记忆 #${value.id}，未删除任何内容）`,
          );
        },
      },
      isConcurrencySafe: () => true,
      execute(args) {
        const deleted = store.delete(Number(args.id));
        return { deleted, id: Number(args.id) };
      },
    }),
  );

  register(
    defineTool({
      name: 'memory_stats',
      description: '查看记忆库统计：总数、各分类（模块）数量、各作用域（全局/工作区/会话）数量、最近加载记录、最常被加载的记忆。',
      parameters: {
        limit: { type: 'integer', description: '最近加载记录条数，默认 10' },
      },
      output: {
        schema: { type: 'json' },
        render(_args, value) {
          const s = value.stats;
          const lines = [`记忆库统计：共 ${s.total} 条记忆`, '按作用域：'];
          for (const sc of SCOPES) {
            lines.push(`  - ${SCOPE_LABELS[sc]}：${s.byScope[sc] ?? 0} 条`);
          }
          lines.push('按分类（模块）：');
          for (const cat of CATEGORIES) {
            lines.push(`  - ${CATEGORY_LABELS[cat]}：${s.byCategory[cat] ?? 0} 条`);
          }
          if (s.recentLoads.length > 0) {
            lines.push('最近加载记录：');
            for (const load of s.recentLoads) {
              lines.push(
                `  - #${load.memoryId} 被加载（相关度 ${load.score.toFixed(2)}）于 ${new Date(load.loadedAt).toLocaleString()}（会话 ${String(load.sessionId).slice(0, 8)}…）`,
              );
            }
          }
          if (s.topLoaded.length > 0) {
            lines.push(
              '最常被加载：' + s.topLoaded.map((t) => `#${t.memoryId}(${t.count}次)`).join('、'),
            );
          }
          return textBlock(lines.join('\n'));
        },
      },
      isConcurrencySafe: () => true,
      execute(args) {
        return { stats: store.stats({ limit: Number(args.limit) || 10 }) };
      },
    }),
  );

  register(
    defineTool({
      name: 'memory_loaded',
      description:
        '查看当前对话（会话）已经加载了哪些记忆模块——包括自动召回注入和 memory_search 标记为加载的。用于回答"这次对话加载了哪些记忆"。',
      parameters: {
        limit: { type: 'integer', description: '返回条数，默认 50' },
      },
      output: {
        schema: { type: 'json' },
        render(_args, value) {
          if (!value.loaded || value.loaded.length === 0) {
            return textBlock('（当前会话尚未加载任何记忆模块）');
          }
          return textBlock(
            `当前会话（${value.sessionId}）已加载 ${value.loaded.length} 条记忆模块：\n\n` +
              value.loaded
                .map(
                  (l) =>
                    `[#${l.memoryId}｜${SCOPE_LABELS[l.scope] ?? l.scope}｜${CATEGORY_LABELS[l.category] ?? l.category}｜相关度 ${l.score.toFixed(2)}｜${new Date(l.loadedAt).toLocaleTimeString()}]\n${l.content.slice(0, 120)}${l.content.length > 120 ? '…' : ''}`,
                )
                .join('\n\n'),
          );
        },
      },
      isConcurrencySafe: () => true,
      execute(args, exec) {
        const sessionId = exec.agent?.session?.id ?? null;
        if (!sessionId) return { sessionId: null, loaded: [] };
        const loaded = store.loadedForSession(sessionId, { limit: Number(args.limit) || 50 });
        return { sessionId, count: loaded.length, loaded };
      },
    }),
  );

  return () => {
    for (const dispose of disposers) dispose();
  };
}
