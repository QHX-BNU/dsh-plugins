/**
 * dsh-memory-admin —— 会话/工作区上下文解析
 *
 * 三层作用域架构依赖"当前会话"与"当前会话所属工作区"：
 *  - 会话 id 直接来自 agent.session.id；
 *  - 工作区 id 通过宿主 workspaceRegistry 服务解析（session → workspace 成员关系）。
 *
 * 宿主服务不可用或会话不属于任何工作区时返回 null，调用方按
 * "无工作区上下文"降级（工作区记忆不参与召回）。
 */

/** 解析会话所属工作区 id；无法解析返回 null。 */
export function resolveWorkspaceId(ctx, sessionId) {
  try {
    const registry = ctx.get('workspaceRegistry');
    if (!registry || typeof registry.list !== 'function') return null;
    const sid = String(sessionId ?? '');
    if (!sid) return null;
    const workspace = registry.list().find(
      (w) => w && Array.isArray(w.sessionIds) && w.sessionIds.some((id) => String(id) === sid),
    );
    return workspace ? String(workspace.id) : null;
  } catch {
    return null;
  }
}

/** 汇总当前执行上下文：{ sessionId, workspaceId }（均可为 null）。 */
export function currentContext(ctx, sessionId) {
  const sid = sessionId !== undefined && sessionId !== null ? String(sessionId) : null;
  return { sessionId: sid, workspaceId: sid ? resolveWorkspaceId(ctx, sid) : null };
}

/** 列出全部工作区（供工具/API 展示可选归属），失败返回空数组。 */
export function listWorkspaces(ctx) {
  try {
    const registry = ctx.get('workspaceRegistry');
    if (!registry || typeof registry.list !== 'function') return [];
    return registry.list().map((w) => ({
      id: String(w.id),
      title: w.title,
      path: w.path,
      sessionCount: Array.isArray(w.sessionIds) ? w.sessionIds.length : 0,
    }));
  } catch {
    return [];
  }
}
