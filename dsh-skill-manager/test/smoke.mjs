/**
 * dsh-skill-manager 服务端核心逻辑冒烟测试（node:test）
 * 运行：node --test test/smoke.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseFrontmatter,
  parseSkillText,
  scanSkillsDir,
  setSkillEnabled,
  removeSkill,
  writeBundleSkill,
  SkillState,
} from '../lib/fs-store.js';

const GOOD_SKILL = `---
name: my-test-skill
description: 测试 skill 描述
whenToUse: 需要测试时
invocation:
  modelInvocable: true
  userInvocable: true
---
这是 skill 的正文内容。
第二行。
`;

test('parseFrontmatter 基础解析', () => {
  const parsed = parseFrontmatter(GOOD_SKILL);
  assert.ok(parsed);
  assert.equal(parsed.data.name, 'my-test-skill');
  assert.equal(parsed.data.description, '测试 skill 描述');
  assert.equal(parsed.data.whenToUse, '需要测试时');
  assert.equal(parsed.data.invocation.modelInvocable, true);
  assert.ok(parsed.body.includes('这是 skill 的正文内容'));
});

test('parseFrontmatter 缺 frontmatter / 未闭合', () => {
  assert.equal(parseFrontmatter('plain text no frontmatter'), null);
  assert.throws(() => parseFrontmatter('---\nname: x\n（无闭合）'));
});

test('parseSkillText 校验 name/description', () => {
  const ok = parseSkillText(GOOD_SKILL);
  assert.equal(ok.name, 'my-test-skill');
  assert.equal(ok.description, '测试 skill 描述');
  // 非法 name（大写/下划线）
  const bad = parseSkillText('---\nname: Bad_Name\n---\ncontent', undefined, 'x.md');
  assert.equal(bad, null);
  // 缺 description
  const noDesc = parseSkillText('---\nname: ok-skill\n---\ncontent', undefined, 'x.md');
  assert.equal(noDesc, null);
});

test('块标量 frontmatter（>- 折叠 / | 字面）', () => {
  const folded = parseSkillText(`---
name: folded-skill
description: >-
  第一行描述，
  第二行描述。
whenToUse: >-
  需要测试时
  使用本 skill。
---
正文
`, undefined, 'x.md');
  assert.ok(folded);
  assert.equal(folded.description, '第一行描述， 第二行描述。');
  assert.equal(folded.whenToUse, '需要测试时 使用本 skill。');

  const literal = parseSkillText(`---
name: literal-skill
description: |
  多行
  保留
---
正文
`, undefined, 'x.md');
  assert.ok(literal);
  assert.equal(literal.description, '多行\n保留');
});

test('扫描 + 启用/禁用（bundle 与 flat）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-sm-'));
  try {
    // bundle
    await writeBundleSkill(dir, 'alpha-skill', GOOD_SKILL);
    // flat
    await writeFile(join(dir, 'beta-skill.md'), GOOD_SKILL.replace('my-test-skill', 'beta-skill'));
    // 无效文件
    await writeFile(join(dir, 'notes.md'), 'no frontmatter here');
    await writeFile(join(dir, 'random.txt'), 'x');
    // 无 SKILL.md 的目录
    await mkdir(join(dir, 'empty-dir'));

    let items = await scanSkillsDir(dir, undefined);
    const names = items.map((i) => i.name).sort();
    // bundle 目录 alpha-skill（frontmatter name 为 my-test-skill，name 以目录名为准）
    assert.deepEqual(names, ['alpha-skill', 'beta-skill', 'notes']);
    const alpha = items.find((i) => i.name === 'alpha-skill');
    assert.equal(alpha.parsedName, 'my-test-skill');
    const notes = items.find((i) => i.name === 'notes');
    assert.equal(notes.parseError, true);
    assert.ok(items.filter((i) => !i.parseError).every((i) => i.enabled === true));

    // 禁用 bundle
    let r = await setSkillEnabled(dir, 'alpha-skill', false);
    assert.equal(r.enabled, false);
    assert.ok((await readdir(join(dir, 'alpha-skill'))).includes('SKILL.md.disabled'));
    // 禁用 flat
    r = await setSkillEnabled(dir, 'beta-skill', false);
    assert.equal(r.enabled, false);
    assert.ok((await readdir(dir)).includes('beta-skill.md.disabled'));

    items = await scanSkillsDir(dir, undefined);
    assert.equal(items.length, 3);
    assert.ok(items.filter((i) => !i.parseError).every((i) => i.enabled === false));

    // 重新启用
    r = await setSkillEnabled(dir, 'alpha-skill', true);
    assert.equal(r.enabled, true);
    r = await setSkillEnabled(dir, 'beta-skill', true);
    assert.equal(r.enabled, true);
    assert.ok((await readdir(dir)).includes('beta-skill.md'));

    // 未知 skill
    r = await setSkillEnabled(dir, 'nope-skill', false);
    assert.equal(r.ok, false);

    // 删除
    r = await removeSkill(dir, 'alpha-skill');
    assert.equal(r.ok, true);
    assert.ok(!(await readdir(dir)).includes('alpha-skill'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('SkillState 持久化', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-sm-'));
  try {
    const path = join(dir, 'state.json');
    const state = new SkillState(path);
    await state.load();
    state.set('a', { repo: 'x/y', skillPath: 'SKILL.md', installedAt: 1 });
    await state.persist();
    const state2 = new SkillState(path);
    await state2.load();
    assert.equal(state2.get('a').repo, 'x/y');
    state2.remove('a');
    assert.equal(state2.get('a'), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('写入 bundle 后文本保留原样（含 frontmatter）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-sm-'));
  try {
    const target = await writeBundleSkill(dir, 'alpha-skill', GOOD_SKILL);
    const text = await readFile(target, 'utf8');
    assert.ok(text.startsWith('---'));
    assert.ok(text.includes('这是 skill 的正文内容'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
