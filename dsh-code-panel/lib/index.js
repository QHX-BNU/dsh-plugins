/**
 * dsh-code-panel —— DSH 右侧代码面板插件（宿主端）
 *
 * 在 Web 界面右侧（details 栏）提供代码显示区域：
 * 1. 工作区代码：按目录懒加载浏览当前会话工作区（cwd）下的文件并高亮显示；
 * 2. 我的代码（Agent 片段）：显示 data/code-panel/snippets/ 目录下的代码文件，
 *    你（Agent）只要把写好的代码放进该目录，面板"我的代码"标签即可看到；
 * 3. 选中代码后可直接作为用户引用发给 Agent 解释（客户端 bundle 实现）。
 *
 * 零外部依赖：仅使用 Node 内置 node:fs / node:path。
 *
 * 用法（profile 的 cordis.patch.yml）：
 * ```yaml
 * - insert:
 *     - id: dsh-code-panel
 *       name: 'dsh-code-panel'
 *       config:
 *         snippetsDir: 'C:/Users/<你>/.dsh/profiles/desktop/data/code-panel/snippets'
 *         webApi: true
 * ```
 */
import z from '@deepseek-ai/schemastery';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { DEFAULT_EXCLUDE_DIRS, installCodePanelApi } from './api.js';

export const name = 'dsh-code-panel';

export const Config = z.object({
  /** 是否注册可视化页面 API（浏览器端代码面板依赖它）。 */
  webApi: z.boolean().default(true),
  /** 单文件预览大小上限（字节），超过则提示用编辑器打开。 */
  maxFileBytes: z.number().min(1024).max(64 * 1024 * 1024).default(1024 * 1024),
  /** 图片预览大小上限（字节），超过则提示无法预览。 */
  maxImageBytes: z.number().min(1024).max(256 * 1024 * 1024).default(20 * 1024 * 1024),
  /** 文件树中忽略的目录名（小写，不含路径）。 */
  excludeDirs: z.array(z.string()).default(DEFAULT_EXCLUDE_DIRS),
  /** Agent 代码片段目录（"我的代码"标签显示此目录下的文件）。 */
  snippetsDir: z.string().default('data/code-panel/snippets'),
});

const SNIPPETS_README = `# Agent 代码片段目录

本目录下的文件会显示在 Web 界面右侧「代码面板 → 我的代码」标签中。

- Agent（AI）在对话中写好的代码，可以保存到这里，之后随时在面板中
  选中并「作为引用发给 Agent 解释」。
- 文件名建议带扩展名（.py / .js / .ps1 / .md 等），面板会按扩展名高亮。
- 删除文件即可从面板中移除；刷新面板可见最新列表。
`;

export async function apply(ctx, config) {
  ctx.logger.info(
    `dsh-code-panel: 激活（webApi=${config.webApi}，maxFileBytes=${config.maxFileBytes}，maxImageBytes=${config.maxImageBytes}，snippetsDir=${config.snippetsDir}）`,
  );

  try {
    // 确保片段目录存在，并写入引导说明（首次）
    const snippetsDir = path.resolve(config.snippetsDir);
    await fsp.mkdir(snippetsDir, { recursive: true });
    const readmePath = path.join(snippetsDir, 'README.md');
    try {
      await fsp.access(readmePath);
    } catch {
      await fsp.writeFile(readmePath, SNIPPETS_README, 'utf8');
    }

    if (config.webApi) {
      ctx.inject(['webServer'], (httpCtx) => {
        httpCtx.effect(() => {
          const routes = installCodePanelApi(httpCtx, {
            snippetsDir,
            maxFileBytes: config.maxFileBytes,
            maxImageBytes: config.maxImageBytes,
            excludeDirs: new Set(config.excludeDirs.map((d) => String(d).toLowerCase())),
          });
          return () => {
            for (const dispose of routes) dispose();
          };
        }, 'dsh-code-panel: web api');
      });
    }
  } catch (err) {
    ctx.logger.error(`dsh-code-panel: 初始化失败：${err.message}`);
    throw err;
  }

  ctx.effect(() => {
    return () => {
      ctx.logger.info('dsh-code-panel: 已卸载');
    };
  }, 'dsh-code-panel');
}
