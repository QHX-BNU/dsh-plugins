/**
 * dsh-code-panel API 测试：用 fake webServer 端到端验证路由行为
 * （列表/读取/越界拦截/二进制/超限/符号链接逃逸）。
 * 运行：node test/api.test.mjs
 */
import { promises as fsp } from 'node:fs';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installCodePanelApi } from '../lib/api.js';

let failures = 0;
function assert(cond, name, extra = '') {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures += 1;
    console.error(`  ✗ FAIL: ${name}${extra ? ' | ' + extra : ''}`);
  }
}

/** 构造 fake webServer，捕获路由。 */
function makeServer() {
  const routes = [];
  const webServer = {
    register: (route) => {
      routes.push(route);
      return () => {};
    },
  };
  const logger = { info() {}, warn() {}, error() {} };
  return { routes, webServer, logger };
}

/** 调用一个路由 handler，返回 { status, body }（body 为 JSON 解析结果）。 */
async function call(route, url, method = 'GET', body = null) {
  let status = 0;
  let headers = null;
  let payload = null;
  const res = {
    writeHead: (s, h) => { status = s; headers = h; },
    end: (b) => { payload = b; },
  };
  const req = { url, method };
  if (body !== null) {
    req.on = (name, fn) => { if (name === 'data') fn(Buffer.from(JSON.stringify(body))); if (name === 'end') fn(); };
  }
  await route.handler(req, res);
  return { status, headers, body: payload ? JSON.parse(payload) : null };
}

/** 调用一个路由 handler，返回原始响应（用于图片二进制接口）。 */
async function callRaw(route, url) {
  let status = 0;
  let headers = null;
  let payload = null;
  const res = {
    writeHead: (s, h) => { status = s; headers = h; },
    end: (b) => { payload = b; },
  };
  await route.handler({ url, method: 'GET' }, res);
  return { status, headers, body: payload };
}

const dir = mkdtempSync(join(tmpdir(), 'dcp-test-'));
const wsRoot = join(dir, 'workspace');
const outside = join(dir, 'outside-secret.txt');
const outsideDir = join(dir, 'outside-dir');
mkdirSync(wsRoot, { recursive: true });
mkdirSync(outsideDir, { recursive: true });
await fsp.writeFile(join(wsRoot, 'hello.py'), 'print("hello")\n', 'utf8');
await fsp.writeFile(join(wsRoot, 'big.bin'), Buffer.concat([Buffer.from('x'.repeat(2000)), Buffer.from([0])]), );
await fsp.writeFile(join(wsRoot, 'big.txt'), 'y'.repeat(5000), 'utf8');
await fsp.writeFile(outside, 'TOP-SECRET', 'utf8');
await fsp.writeFile(join(outsideDir, 'outside.md'), '# outside', 'utf8');
mkdirSync(join(wsRoot, 'sub'), { recursive: true });
mkdirSync(join(wsRoot, 'node_modules'), { recursive: true });
await fsp.writeFile(join(wsRoot, 'sub', 'inner.md'), '# inner', 'utf8');
await fsp.writeFile(join(wsRoot, 'node_modules', 'noise.js'), '// noise', 'utf8');

// 符号链接（Windows 上可能因权限失败，失败则跳过相关断言）
let symlinkOk = true;
try {
  symlinkSync(outside, join(wsRoot, 'leak.txt'));
  symlinkSync(outsideDir, join(wsRoot, 'sub-link'));
} catch {
  symlinkOk = false;
}

const { routes, webServer, logger } = makeServer();
installCodePanelApi({ webServer, logger }, {
  snippetsDir: join(dir, 'snippets'),
  maxFileBytes: 4096,
  maxImageBytes: 300,
  excludeDirs: new Set(['node_modules']),
});

const route = (path) => routes.find((r) => r.path === path);
const qs = (params) => new URLSearchParams(params).toString();

// ---- 测试图片素材 ----
// 最小合法 PNG（文件头魔数 + 若干字节），真实 1x1 透明 PNG
const PNG_1x1 = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG 魔数
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
  0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54,
  0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05,
  0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00,
  0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);
// 最小合法 GIF
const GIF_1x1 = Buffer.from([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, // GIF89a
  0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00,
  0x00, 0x00, 0x00, 0xff, 0xff, 0xff,
  0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00,
  0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  0x02, 0x02, 0x44, 0x01, 0x00, 0x3b,
]);
// 最小合法 WebP（RIFF....WEBP + VP8L）
const WEBP_1x1 = Buffer.concat([
  Buffer.from('RIFF', 'latin1'),
  Buffer.from([0x1a, 0x00, 0x00, 0x00]),
  Buffer.from('WEBPVP8L', 'latin1'),
  Buffer.from([0x0f, 0x00, 0x00, 0x00, 0x2f, 0x00, 0x00, 0x00, 0x00, 0x88, 0x88, 0x08]),
]);
await fsp.writeFile(join(wsRoot, 'pic.png'), PNG_1x1);
await fsp.writeFile(join(wsRoot, 'anim.gif'), GIF_1x1);
await fsp.writeFile(join(wsRoot, 'pic.webp'), WEBP_1x1);
await fsp.writeFile(join(wsRoot, 'pic.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>', 'utf8');
await fsp.writeFile(join(wsRoot, 'fake.png'), 'not a real png', 'utf8'); // 伪装成图片的文本
await fsp.writeFile(join(wsRoot, 'huge.png'), Buffer.concat([PNG_1x1, Buffer.alloc(500, 0x00)])); // 超过 maxImageBytes=300

console.log('== 路由注册 ==');
{
  const paths = routes.map((r) => r.path).sort();
  const expected = [
    '/code-panel/api/image',
    '/code-panel/api/list',
    '/code-panel/api/read',
    '/code-panel/api/search',
    '/code-panel/api/snippets',
    '/code-panel/api/snippets/image',
    '/code-panel/api/snippets/read',
  ].sort();
  assert(JSON.stringify(paths) === JSON.stringify(expected), `注册 7 条路由（${paths.join(', ')}）`);
}

console.log('== 列表 ==');
{
  const r = await call(route('/code-panel/api/list'), '/code-panel/api/list?' + qs({ root: wsRoot, rel: '' }));
  assert(r.status === 200 && r.body.ok === true, '根目录列表成功');
  const names = r.body.entries.map((e) => e.name);
  assert(names.includes('hello.py') && names.includes('sub'), '包含文件与目录');
  assert(!names.includes('node_modules'), 'excludeDirs 生效（node_modules 被忽略）');
  const dirEntry = r.body.entries.find((e) => e.name === 'sub');
  assert(dirEntry.dir === true && dirEntry.rel === 'sub', '目录条目带 rel');
  const fileEntry = r.body.entries.find((e) => e.name === 'hello.py');
  assert(fileEntry.dir === false && fileEntry.size > 0, '文件条目带 size');

  const sub = await call(route('/code-panel/api/list'), '/code-panel/api/list?' + qs({ root: wsRoot, rel: 'sub' }));
  assert(sub.body.ok === true && sub.body.entries[0].name === 'inner.md', '子目录列表成功（rel 懒加载）');

  if (symlinkOk) {
    assert(!names.includes('leak.txt') && !names.includes('sub-link'), '符号链接条目不展示');
  } else {
    console.log('  - 跳过符号链接断言（当前环境无法创建符号链接）');
  }
}

console.log('== 读取 ==');
{
  const r = await call(route('/code-panel/api/read'), '/code-panel/api/read?' + qs({ root: wsRoot, rel: 'hello.py' }));
  assert(r.status === 200 && r.body.ok === true, '读取文本文件成功');
  assert(r.body.lang === 'python' && r.body.content.includes('hello'), `语言推断 + 内容（${r.body.lang}）`);

  const big = await call(route('/code-panel/api/read'), '/code-panel/api/read?' + qs({ root: wsRoot, rel: 'big.txt' }));
  assert(big.status === 200 && big.body.ok === false && big.body.error === 'file-too-large', '超过 maxFileBytes 返回 file-too-large');

  const bin = await call(route('/code-panel/api/read'), '/code-panel/api/read?' + qs({ root: wsRoot, rel: 'big.bin' }));
  assert(bin.body.ok === false && bin.body.error === 'binary', '二进制文件返回 binary');

  const missing = await call(route('/code-panel/api/read'), '/code-panel/api/read?' + qs({ root: wsRoot, rel: 'nope.js' }));
  assert(missing.status === 404 && missing.body.error === 'not-found', '不存在的文件返回 404');
}

console.log('== 越界防护 ==');
{
  const cases = [
    ['../outside-secret.txt', '.. 穿越'],
    ['..\\..\\windows', '反斜杠穿越'],
    ['sub/../../outside-secret.txt', '深层 .. 穿越'],
  ];
  for (const [rel, label] of cases) {
    const r = await call(route('/code-panel/api/read'), '/code-panel/api/read?' + qs({ root: wsRoot, rel }));
    assert(r.status === 400 && r.body.ok === false && r.body.error.includes('越界'), `越界拦截：${label}`);
  }

  // 前导斜杠被剥离后按相对路径解析（安全），不应命中工作区外的文件
  const absRel = await call(route('/code-panel/api/read'), '/code-panel/api/read?' + qs({ root: wsRoot, rel: '/absolute/path' }));
  assert(absRel.status === 404, '绝对路径风格的 rel 被当作相对路径（未逃逸，404）');

  const relRoot = await call(route('/code-panel/api/list'), '/code-panel/api/list?' + qs({ root: 'relative-dir', rel: '' }));
  assert(relRoot.status === 400 && relRoot.body.error.includes('绝对路径'), '相对 root 被拒绝');

  if (symlinkOk) {
    const leak = await call(route('/code-panel/api/read'), '/code-panel/api/read?' + qs({ root: wsRoot, rel: 'leak.txt' }));
    assert(leak.status === 400 && leak.body.error.includes('越界'), '符号链接指向工作区外被拦截');
    const subLink = await call(route('/code-panel/api/list'), '/code-panel/api/list?' + qs({ root: wsRoot, rel: 'sub-link' }));
    assert(subLink.status === 400 && subLink.body.error.includes('越界'), '目录符号链接指向工作区外被拦截');
  }
}

console.log('== 搜索 ==');
{
  // 无关键词：递归返回全部文件（目录不返回），excludeDirs / 符号链接同样生效
  const all = await call(route('/code-panel/api/search'), '/code-panel/api/search?' + qs({ root: wsRoot }));
  assert(all.status === 200 && all.body.ok === true, '无关键词搜索成功');
  assert(all.body.files.length === 10, `返回全部 10 个文件（${all.body.files.length}）`);
  assert(all.body.files.every((f) => f.dir === false), '搜索结果不含目录');
  assert(!all.body.files.some((f) => f.rel.includes('node_modules')), 'excludeDirs 生效（node_modules 被忽略）');
  if (symlinkOk) {
    assert(!all.body.files.some((f) => f.rel === 'leak.txt'), '符号链接不进入搜索结果');
  }
  const sub = all.body.files.find((f) => f.rel === 'sub/inner.md');
  assert(sub && sub.size > 0, '子目录文件带相对路径与 size');

  // 关键词：按文件名/路径子串匹配（大小写不敏感）
  const hit = await call(route('/code-panel/api/search'), '/code-panel/api/search?' + qs({ root: wsRoot, query: 'HELLO' }));
  assert(hit.body.files.length === 1 && hit.body.files[0].name === 'hello.py', '大小写不敏感子串匹配');
  const deep = await call(route('/code-panel/api/search'), '/code-panel/api/search?' + qs({ root: wsRoot, query: 'inner' }));
  assert(deep.body.files.length === 1 && deep.body.files[0].rel === 'sub/inner.md', '按相对路径匹配子目录文件');
  const img = await call(route('/code-panel/api/search'), '/code-panel/api/search?' + qs({ root: wsRoot, query: 'pic' }));
  assert(img.body.files.some((f) => f.image === true), '图片文件带 image 标记');

  // 前缀命中优先
  const prefix = await call(route('/code-panel/api/search'), '/code-panel/api/search?' + qs({ root: wsRoot, query: 'in' }));
  assert(prefix.body.files.length > 0 && prefix.body.files[0].name.startsWith('in'), '前缀命中排在最前');

  // limit 生效；无匹配返回空
  const limited = await call(route('/code-panel/api/search'), '/code-panel/api/search?' + qs({ root: wsRoot, limit: '3' }));
  assert(limited.body.files.length === 3, `limit 生效（${limited.body.files.length}）`);
  const none = await call(route('/code-panel/api/search'), '/code-panel/api/search?' + qs({ root: wsRoot, query: 'zzzz-not-exist' }));
  assert(none.body.files.length === 0, '无匹配返回空数组');

  // 越界与非法 root
  const relRoot = await call(route('/code-panel/api/search'), '/code-panel/api/search?' + qs({ root: 'relative-dir' }));
  assert(relRoot.status === 400 && relRoot.body.error.includes('绝对路径'), '相对 root 被拒绝');
  const missing = await call(route('/code-panel/api/search'), '/code-panel/api/search?' + qs({ root: join(dir, 'nope') }));
  assert(missing.body.ok === false, '不存在的 root 返回错误');
}

console.log('== 图片预览 ==');
{
  // list 条目带 image 标记
  const list = await call(route('/code-panel/api/list'), '/code-panel/api/list?' + qs({ root: wsRoot, rel: '' }));
  const byName = Object.fromEntries(list.body.entries.map((e) => [e.name, e]));
  assert(byName['pic.png'].image === true && byName['pic.svg'].image === true && byName['anim.gif'].image === true, 'list 标记图片条目');
  assert(byName['hello.py'].image === false && byName['sub'].image === false, 'list 非图片不标记');

  // 合法 PNG → 图片二进制 + 正确 content-type
  const png = await callRaw(route('/code-panel/api/image'), '/code-panel/api/image?' + qs({ root: wsRoot, rel: 'pic.png' }));
  assert(png.status === 200 && png.headers['content-type'] === 'image/png', `PNG content-type（${png.headers['content-type']}）`);
  assert(Buffer.isBuffer(png.body) && png.body.equals(PNG_1x1), 'PNG 字节原样返回');

  // GIF / WebP / SVG
  const gif = await callRaw(route('/code-panel/api/image'), '/code-panel/api/image?' + qs({ root: wsRoot, rel: 'anim.gif' }));
  assert(gif.headers['content-type'] === 'image/gif', 'GIF content-type');
  const webp = await callRaw(route('/code-panel/api/image'), '/code-panel/api/image?' + qs({ root: wsRoot, rel: 'pic.webp' }));
  assert(webp.headers['content-type'] === 'image/webp', 'WebP content-type');
  const svg = await callRaw(route('/code-panel/api/image'), '/code-panel/api/image?' + qs({ root: wsRoot, rel: 'pic.svg' }));
  assert(svg.status === 200 && svg.headers['content-type'] === 'image/svg+xml', 'SVG content-type');

  // 伪装图片（文本内容 .png）→ 魔数校验失败
  const fake = await call(route('/code-panel/api/image'), '/code-panel/api/image?' + qs({ root: wsRoot, rel: 'fake.png' }));
  assert(fake.status === 200 && fake.body.ok === false && fake.body.error === 'not-image', '伪装图片被魔数校验拦截');

  // 超大图片 → image-too-large
  const huge = await call(route('/code-panel/api/image'), '/code-panel/api/image?' + qs({ root: wsRoot, rel: 'huge.png' }));
  assert(huge.body.ok === false && huge.body.error === 'image-too-large', '超大图片返回 image-too-large');

  // 越界与不存在
  const escape = await call(route('/code-panel/api/image'), '/code-panel/api/image?' + qs({ root: wsRoot, rel: '../outside-secret.txt' }));
  assert(escape.status === 400 && escape.body.error.includes('越界'), '图片接口越界拦截');
  const missing = await callRaw(route('/code-panel/api/image'), '/code-panel/api/image?' + qs({ root: wsRoot, rel: 'nope.png' }));
  assert(missing.status === 404, '图片接口 404');

  // 旧客户端 bundle 仍会请求 /read：图片应得到图片引导而非"二进制/文件过大"误导
  const pngRead = await call(route('/code-panel/api/read'), '/code-panel/api/read?' + qs({ root: wsRoot, rel: 'pic.png' }));
  assert(pngRead.body.ok === false && pngRead.body.error === 'image' && pngRead.body.mime === 'image/png', '/read 对魔数合法图片返回图片引导（含 mime）');
  const bigRead = await call(route('/code-panel/api/read'), '/code-panel/api/read?' + qs({ root: wsRoot, rel: 'huge.png' }));
  assert(bigRead.body.ok === false && bigRead.body.error === 'image' && bigRead.body.image === true, '/read 对图片扩展名的大文件返回图片引导');
  const binRead = await call(route('/code-panel/api/read'), '/code-panel/api/read?' + qs({ root: wsRoot, rel: 'big.bin' }));
  assert(binRead.body.ok === false && binRead.body.error === 'binary', '/read 对非图片二进制仍返回 binary');
}

console.log('== 片段 ==');
{
  const sdir = join(dir, 'snippets');
  await fsp.mkdir(sdir, { recursive: true });
  await fsp.writeFile(join(sdir, 'check.ps1'), 'Get-Process\n', 'utf8');
  await fsp.writeFile(join(sdir, 'shot.png'), PNG_1x1);
  await fsp.writeFile(join(sdir, 'fake-snip.png'), 'not a png', 'utf8');
  const list = await call(route('/code-panel/api/snippets'), '/code-panel/api/snippets');
  assert(list.body.ok === true && list.body.snippets.length === 3, '片段列表 3 项');
  const shot = list.body.snippets.find((s) => s.name === 'shot.png');
  assert(shot && shot.image === true && shot.lang === 'text', '片段列表标记图片');
  const read = await call(route('/code-panel/api/snippets/read'), '/code-panel/api/snippets/read?' + qs({ name: 'check.ps1' }));
  assert(read.body.ok === true && read.body.content.includes('Get-Process'), '读取片段');
  const bad = await call(route('/code-panel/api/snippets/read'), '/code-panel/api/snippets/read?' + qs({ name: '../outside-secret.txt' }));
  assert(bad.status === 400 && bad.body.error === '非法的片段名', '片段名穿越被拒绝');
  const img = await callRaw(route('/code-panel/api/snippets/image'), '/code-panel/api/snippets/image?' + qs({ name: 'shot.png' }));
  assert(img.status === 200 && img.headers['content-type'] === 'image/png' && img.body.equals(PNG_1x1), '片段图片预览');
  const fakeImg = await call(route('/code-panel/api/snippets/image'), '/code-panel/api/snippets/image?' + qs({ name: 'fake-snip.png' }));
  assert(fakeImg.body.ok === false && fakeImg.body.error === 'not-image', '片段伪装图片被拦截');
  const badImg = await call(route('/code-panel/api/snippets/image'), '/code-panel/api/snippets/image?' + qs({ name: '../evil.png' }));
  assert(badImg.status === 400 && badImg.body.error === '非法的片段名', '片段图片名穿越被拒绝');
  if (symlinkOk) {
    symlinkSync(outside, join(sdir, 'leak-snippet.txt'));
    const leak = await call(route('/code-panel/api/snippets/read'), '/code-panel/api/snippets/read?' + qs({ name: 'leak-snippet.txt' }));
    assert(leak.status === 400 && leak.body.error.includes('越界'), '片段符号链接逃逸被拦截');
  }
}

rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? '\n== 全部通过 ==' : `\n== ${failures} 项失败 ==`);
process.exit(failures === 0 ? 0 : 1);
