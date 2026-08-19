/**
 * dsh-memory-admin —— 召回算法（轻量相关度打分）
 *
 * 无外部依赖、无需 embedding：使用词元（token）重叠 + 重要度 + 时效性
 * 综合打分，足以支撑本地记忆库的相关记忆召回。
 *
 * 分词策略：
 *  - 拉丁字符按单词小写拆分；
 *  - CJK 文本按二元组（bigram）切分（对中文召回效果好且无需分词库）。
 */
export function tokenize(text) {
  const tokens = new Set();
  const normalized = String(text ?? '').toLowerCase();
  // 拉丁单词 / 数字
  for (const match of normalized.matchAll(/[a-z0-9][a-z0-9_\-.]*/g)) {
    const word = match[0];
    if (word.length >= 2) tokens.add(word);
  }
  // CJK 二元组
  const cjk = normalized.replace(/[^\u4e00-\u9fff\u3400-\u4dbf]/g, ' ');
  const chars = cjk.replace(/\s+/g, '');
  if (chars.length === 1) tokens.add(chars);
  for (let i = 0; i < chars.length - 1; i++) {
    tokens.add(chars.slice(i, i + 2));
  }
  return tokens;
}

/** 计算查询与一条记忆的相关度分数（0~1+）。 */
export function scoreMemory(queryTokens, memory) {
  if (queryTokens.size === 0) return 0;
  const contentTokens = tokenize(memory.content);
  if (contentTokens.size === 0) return 0;
  let overlap = 0;
  for (const token of queryTokens) {
    if (contentTokens.has(token)) overlap += 1;
  }
  if (overlap === 0) return 0;
  // 覆盖度：重叠词元占查询的比例（Jaccard 风格，带长度归一）
  const coverage = overlap / Math.sqrt(queryTokens.size * contentTokens.size);
  // 重要度加成（0~0.3）
  const importanceBonus = (memory.importance ?? 0.6) * 0.3;
  // 时效加成：最近 30 天内更新 +0.1，7 天内 +0.2
  const age = Date.now() - (memory.updatedAt ?? memory.createdAt ?? 0);
  const recencyBonus = age < 7 * 24 * 3600 * 1000 ? 0.2 : age < 30 * 24 * 3600 * 1000 ? 0.1 : 0;
  return coverage + importanceBonus + recencyBonus;
}

/**
 * 召回：从记忆库选出与查询最相关的 topK 条。
 * 传入 sessionId 时只在该会话可见范围内召回（全局 + 所属工作区 + 本会话），
 * 不传则跨全部记忆（供管理界面使用）。
 * 返回按分数降序的 [{ memory, score }]。
 */
export function recall(store, query, { topK = 5, minScore = 0.4, excludeIds = new Set(), sessionId, workspaceId } = {}) {
  const queryTokens = tokenize(query);
  if (queryTokens.size === 0) return [];
  const candidates = sessionId !== undefined && sessionId !== null
    ? store.listVisible({ sessionId: String(sessionId), workspaceId, limit: 1000, order: 'updated' })
    : store.list({ limit: 1000, order: 'updated' });
  const scored = [];
  for (const memory of candidates) {
    if (excludeIds.has(memory.id)) continue;
    const score = scoreMemory(queryTokens, memory);
    if (score >= minScore) scored.push({ memory, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}
