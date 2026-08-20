/**
 * @ 两级菜单（路由）+ 结构引用（chip）时序仿真测试
 *
 * 按宿主 @deepseek-ai/dsh-client-ui-input-trigger 与
 * dsh-client-ui-conversation 的源码忠实还原关键机制：
 *   - detectTrigger / menuReduce / pick / toggleSource / track 的核心顺序
 *   - zustand store 同步通知订阅者（菜单关闭回调与微任务重开的先后关系）
 *   - 输入机器 insert-ref 的 span draftRev CAS 与 occurrence mint
 *   - 提交时 occurrence 经源 codec.serialize 展开
 * 再把 dsh-skill-manager 客户端的阶段逻辑（stages/pendingCat/路由源）与
 * 引用产出（insert + codec）原样嵌入，验证主流程：
 *   1) @ 只显示「选择」分类层（技能/文件分组不渲染）
 *   2) 点「技能」→ 微任务后打开技能单分组菜单，查询词延续
 *   3) 第二级输入时 track 重播种后仍只显示技能分组
 *   4) 选中技能 → 插入真实文本 /skill-name（光标可自由移动，无占位符）
 *   5) 选中文件 → mint 文件 chip（label「文件 · 相对路径」），提交序列化为 @相对路径
 *   6) 菜单关闭（Esc/选中）后阶段复位
 * 运行：node test/menu-flow.mjs
 */
import assert from 'node:assert/strict';

// ---------------------------------------------------------------- 宿主还原（简化但保序）

let menuListeners = new Set();
let state = { open: false, hit: null, generation: 0, groups: [], highlight: null };
const setState = (next) => {
  state = next;
  for (const fn of [...menuListeners]) fn(state); // zustand：同步通知
};
const closed = () => ({ open: false, hit: null, generation: state.generation, groups: [], highlight: null });
const seedGroups = (sources) => ({ ...state, groups: sources.map((s) => ({ source: s, status: 'pending', items: [] })), highlight: null });
const menuReduce = (ev) => {
  switch (ev.type) {
    case 'hit':
      if (ev.hit === null) return closed();
      return { open: true, hit: ev.hit, generation: state.generation + 1, groups: state.groups.map((g) => ({ source: g.source, status: 'pending', items: [] })), highlight: null };
    case 'source-settled': {
      if (!state.open || ev.generation !== state.generation) return state;
      const idx = state.groups.findIndex((g) => g.source === ev.source);
      if (idx < 0) return state;
      const groups = state.groups.map((g, i) => (i === idx ? { ...g, status: 'ready', items: ev.items } : g));
      return { ...state, groups };
    }
    case 'close': return closed();
  }
  return state;
};
const reduce = (ev) => {
  const next = menuReduce(ev);
  if (next !== state) setState(next);
};

let controllerHit = null;
let launcher = null;
let draftRev = 0;
/** 输入机器状态：每个 occurrence（chip）在 draft 中占一个 ￼ 位置 */
let occurrences = [];

const WORD_CHAR = /[\p{L}\p{N}_]/u;
const WHITESPACE = /\s/u;
function boundaryOk(draft, index) {
  if (index === 0) return true;
  const prev = draft.charAt(index - 1);
  if (WHITESPACE.test(prev)) return true;
  if (WORD_CHAR.test(prev)) return false;
  return true;
}
function detectTrigger(draft, caret) {
  for (let i = caret - 1; i >= 0; i--) {
    const ch = draft.charAt(i);
    if (WHITESPACE.test(ch)) return null;
    if (ch !== '@') continue;
    if (!boundaryOk(draft, i)) continue;
    return {
      trigger: ch,
      query: draft.slice(i + 1, caret),
      position: draft.search(/\S/) === i ? 'leading' : 'inline',
      span: { start: i, end: caret },
    };
  }
  return null;
}

const roster = () => ['选择', 'skill', '工作区文件']; // 注册顺序（order 10/20/30）

function fetchCandidates(hit, sources) {
  for (const name of sources) {
    const items = candidatesOf(name, hit.query);
    reduce({ type: 'source-settled', generation: state.generation, source: name, items });
  }
}

function track(draft, caret) {
  const raw = detectTrigger(draft, caret);
  if (raw === null) {
    controllerHit = null;
    reduce({ type: 'close' });
    return;
  }
  const hit = { ...raw, span: { ...raw.span, draftRev } };
  const prev = state;
  const same = launcher === null && prev.open && prev.hit !== null
    && prev.hit.trigger === hit.trigger && prev.hit.query === hit.query
    && prev.hit.span.start === hit.span.start && prev.hit.span.end === hit.span.end;
  controllerHit = hit;
  if (same) return;
  if (launcher !== null || !prev.open || prev.hit === null || prev.hit.trigger !== hit.trigger) {
    setState(seedGroups(roster()));
  }
  reduce({ type: 'hit', hit });
  fetchCandidates(hit, roster());
}

function pick(source, index) {
  const group = state.groups.find((g) => g.source === source);
  const candidate = group && group.status === 'ready' ? group.items[index] : void 0;
  if (candidate === void 0) return;
  const hit = state.hit || controllerHit;
  const outcome = onPickOf(source)({ candidate, session: { sessionId: 's1' }, position: hit.position, span: hit.span });
  reduce({ type: 'close' });
  return execute(outcome, hit.span);
}

function toggleSource(source, hit) {
  if (launcher === source && state.open) {
    reduce({ type: 'close' });
    launcher = null;
    return;
  }
  launcher = source;
  controllerHit = hit;
  setState(seedGroups([source]));
  reduce({ type: 'hit', hit });
  fetchCandidates(hit, [source]);
}

// 输入机器 insert-ref：CAS + mint occurrence（replaceSpanWithChip 语义）
function insertReference(reference, span) {
  if (span.draftRev !== draftRev) return false;
  occurrences = [...occurrences, { ...reference, offset: span.start }];
  lastInsert = { kind: 'insert', reference };
  return true;
}
// 输入机器 insert-text：CAS + 替换 span 为文本（技能引用走真实文本）
function insertText(text, span) {
  if (span.draftRev !== draftRev) return false;
  lastInsert = { kind: 'text', text };
  return true;
}
let lastInsert = null;
const execute = (outcome, span) => {
  if (outcome === void 0 || outcome === 'handled') return false;
  if ('insert' in outcome) return insertReference(outcome.insert, span);
  if ('text' in outcome) return insertText(outcome.text, span);
  return false;
};

// 提交序列化：每个 occurrence 经 owner codec 展开（sinkSerialized 语义）
async function sinkSerialized() {
  const parts = [];
  for (const o of occurrences) {
    parts.push({ offset: o.offset, text: await codecOf(o.source).serialize(o.ref) });
  }
  return parts.map((p) => p.text).join(' ');
}

// ---------------------------------------------------------------- 插件阶段逻辑（原样嵌入）

const stages = new Map();
const pendingCat = new Map();
const stageOf = (sid) => stages.get(sid) || 'category';

const menuSubscribe = (fn) => { menuListeners.add(fn); return () => menuListeners.delete(fn); };
menuSubscribe((s) => {
  if (s.open) return;
  if (!pendingCat.has('s1')) stages.set('s1', 'category');
});

const candidatesOf = (name, query) => {
  if (name === '选择') {
    if (stageOf('s1') !== 'category') return [];
    const q = (query || '').toLowerCase();
    const items = [
      { name: '技能', category: 'skill' },
      { name: '工作区文件', category: '工作区文件' },
    ];
    if (!q) return items;
    const hit = items.filter((i) => i.name.toLowerCase().includes(q));
    return hit.length === 0 ? [{ name: '无匹配："' + query + '"', noMatch: true }] : hit;
  }
  if (name === 'skill') {
    if (stageOf('s1') !== 'skill') return [];
    const skills = [{ name: 'alpha-skill' }, { name: 'beta-skill' }];
    const q = (query || '').toLowerCase();
    if (!q) return skills.map((s) => ({ name: s.name }));
    const hit = skills.filter((s) => s.name.includes(q)).map((s) => ({ name: s.name }));
    return hit.length === 0 ? [{ name: '无匹配："' + query + '"', noMatch: true }] : hit;
  }
  if (name === '工作区文件') {
    if (stageOf('s1') !== '工作区文件') return [];
    const files = [{ name: 'a.py', rel: 'src/a.py' }, { name: 'b.md', rel: 'docs/b.md' }];
    const q = (query || '').toLowerCase();
    if (!q) return files.map((f) => ({ name: f.name, file: { rel: f.rel } }));
    const hit = files.filter((f) => f.name.includes(q) || f.rel.includes(q)).map((f) => ({ name: f.name, file: { rel: f.rel } }));
    return hit.length === 0 ? [{ name: '无匹配："' + query + '"', noMatch: true }] : hit;
  }
  return [];
};

const onPickOf = (name) => ({ candidate, position, span }) => {
  if (name === '选择') {
    if (!candidate || candidate.noMatch || !candidate.category) return void 0;
    const cat = candidate.category;
    const query = state.hit && state.hit.query ? state.hit.query : '';
    stages.set('s1', cat);
    pendingCat.set('s1', cat);
    Promise.resolve().then(() => {
      if (pendingCat.get('s1') !== cat) return;
      toggleSource(cat, { trigger: '@', query, position: position || 'leading', span });
      pendingCat.delete('s1');
      if (!state.open) stages.set('s1', 'category');
    });
    return 'handled';
  }
  if (name === '工作区文件') {
    if (!candidate || candidate.noMatch || !candidate.file) return void 0;
    return {
      insert: {
        source: '工作区文件',
        ref: candidate.file.rel,
        label: '文件 · ' + candidate.file.rel,
        clipboardText: candidate.file.rel,
      },
    };
  }
  if (name === 'skill') {
    if (!candidate || candidate.noMatch) return void 0;
    // 纯文本插入：真实文本，光标可自由移动；由 text-ref 扫描装饰
    return { text: '/' + candidate.name + ' ' };
  }
  return void 0;
};

const codecOf = (source) => ({
  skill: { clipboardText: (ref) => '/' + ref, serialize: (ref) => Promise.resolve('/' + ref) },
  '工作区文件': { clipboardText: (ref) => ref, serialize: (ref) => Promise.resolve('@' + ref) },
}[source]);

// ---------------------------------------------------------------- 测试

let failures = 0;
const check = (cond, name) => {
  if (cond) console.log('  ✓ ' + name);
  else { failures += 1; console.error('  ✗ FAIL: ' + name); }
};
const tick = () => new Promise((r) => setImmediate(r)); // 让微任务跑完

const visibleGroups = () => state.groups.filter((g) => g.status === 'ready' && g.items.length > 0).map((g) => g.source);

console.log('== 流程 1：@ 只显示分类层 ==');
{
  track('@', 1);
  check(state.open === true, '@ 打开菜单');
  check(JSON.stringify(visibleGroups()) === JSON.stringify(['选择']), '只渲染「选择」分组（技能/文件空分组不渲染）');
  const items = state.groups.find((g) => g.source === '选择').items;
  check(items.length === 2 && items[0].category === 'skill' && items[1].category === '工作区文件', '分类候选为技能/工作区文件');
}

console.log('== 流程 2：点「技能」→ 微任务后打开技能菜单，查询词延续 ==');
await (async () => {
  track('@技', 2);
  const routerItems = state.groups.find((g) => g.source === '选择').items;
  check(routerItems.length === 1 && routerItems[0].category === 'skill', '输入「技」过滤出技能分类');
  pick('选择', 0); // 点「技能」
  check(state.open === false, '点击后菜单先关闭');
  check(stages.get('s1') === 'skill', '阶段已切换为 skill');
  check(pendingCat.get('s1') === 'skill', '切换在途标记存在（关闭回调不会复位）');
  await tick();
  check(state.open === true, '微任务后菜单重新打开');
  check(JSON.stringify(visibleGroups()) === JSON.stringify(['skill']), '只显示技能分组');
  check(launcher === 'skill', 'launcher 指向技能源');
  check(pendingCat.get('s1') === void 0, '在途标记已清除');
})();

console.log('== 流程 3：选中技能 → 插入真实文本 /skill-name（光标可自由移动） ==');
{
  draftRev += 1; // 模拟输入（fresh hit / span CAS 通过）
  track('@al', 3);
  check(JSON.stringify(visibleGroups()) === JSON.stringify(['skill']), '输入后仍只显示技能分组');
  const items = state.groups.find((g) => g.source === 'skill').items;
  check(items.length === 1 && items[0].name === 'alpha-skill', '查询词延续（al → alpha-skill）');
  pick('skill', 0);
  check(state.open === false, '选中后菜单关闭');
  check(lastInsert !== null && lastInsert.kind === 'text' && lastInsert.text === '/alpha-skill ', '插入真实文本 /alpha-skill（非占位符 chip）');
  check(occurrences.length === 0, '技能引用不 mint occurrence（文本可编辑，光标可进入文字中间）');
  check(stages.get('s1') === 'category', '菜单关闭后阶段复位到分类层');
}

console.log('== 流程 4：文件 → mint 文件 chip，提交序列化为 @相对路径 ==');
await (async () => {
  track('@', 1);
  pick('选择', 1); // 点「工作区文件」
  await tick();
  check(JSON.stringify(visibleGroups()) === JSON.stringify(['工作区文件']), '只显示工作区文件分组');
  draftRev += 1;
  track('@b', 2);
  const items = state.groups.find((g) => g.source === '工作区文件').items;
  check(items.length === 1 && items[0].file.rel === 'docs/b.md', '文件查询延续（b → docs/b.md）');
  pick('工作区文件', 0);
  check(lastInsert !== null && lastInsert.kind === 'insert', '文件以结构引用插入');
  check(lastInsert.reference.source === '工作区文件' && lastInsert.reference.ref === 'docs/b.md', '引用指向文件源');
  check(lastInsert.reference.label === '文件 · docs/b.md', 'chip label 带「文件 · 」前缀');
  check(occurrences.length === 1, '仅文件 mint occurrence（技能走文本，无占位符）');
  const serialized = await sinkSerialized();
  check(serialized.includes('@docs/b.md'), `提交序列化：@docs/b.md（实际：${serialized}）`);
  check(stages.get('s1') === 'category', '菜单关闭且阶段复位');
  track('@', 1);
  check(JSON.stringify(visibleGroups()) === JSON.stringify(['选择']), '下一次 @ 从分类层开始');
})();

console.log('== 流程 5：Esc 关闭第二级后复位 ==');
await (async () => {
  pick('选择', 1);
  await tick();
  check(stages.get('s1') === '工作区文件', '进入文件层');
  reduce({ type: 'close' }); // Esc
  check(stages.get('s1') === 'category', 'Esc 关闭后阶段复位');
})();

console.log(failures === 0 ? '\n== 全部通过 ==' : `\n== ${failures} 项失败 ==`);
process.exit(failures === 0 ? 0 : 1);
