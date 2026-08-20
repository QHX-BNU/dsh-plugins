/**
 * dsh-skill-manager —— DSH Skill 管理插件（服务端入口）
 *
 * 为 DeepSeek Harness 提供 skills 管理能力：
 * - 侧边栏"Skill 管理"入口（Web 客户端 bundle 见 lib/client.js）：
 *   列出已安装 skills、启用/禁用、删除、从 GitHub 市场仓库下载、刷新；
 * - 对话输入框输入 @ 弹出 skills 选择器（支持搜索），选择后插入
 *   `/skill-name` 用户显式调用手势；
 * - 直接管理 <dshHome>/skills 目录（官方 filesystem provider 的
 *   user-dsh root），文件变化由官方 watcher 自动发现并刷新 catalog。
 *
 * 用法（profile 的 cordis.patch.yml）：
 * ```yaml
 * - insert:
 *     - id: dsh-skill-manager
 *       name: 'dsh-skill-manager'
 *       config:
 *         skillsDir: 'C:/Users/<你>/.dsh/skills'
 *         statePath: 'C:/Users/<你>/.dsh/profiles/desktop/data/skill-manager.json'
 * ```
 */
import z from '@deepseek-ai/schemastery';
import { defaultSkillsDir, SkillState } from './fs-store.js';
import { installSkillsApi } from './api.js';

export const name = 'dsh-skill-manager';

/** skills 服务（读取全量 catalog 用于展示）；webServer 单独用 ctx.inject 延迟。 */
export const inject = ['skills'];

export const Config = z.object({
  /** 本地 skills 根目录（默认 <DSH_HOME>/skills）。 */
  skillsDir: z.string().default(''),
  /** 安装来源状态存储 JSON 路径（默认 <skillsDir 上级>/skill-manager-state.json）。 */
  statePath: z.string().default(''),
  /** 可选的 GitHub Token（提高 API 限流上限）。 */
  githubToken: z.string().default(''),
  /** 是否注册可视化页面 API（侧边栏"Skill 管理"面板依赖它）。 */
  webApi: z.boolean().default(true),
});

export async function apply(ctx, config) {
  const skillsDir = config.skillsDir && config.skillsDir.trim() !== ''
    ? config.skillsDir.trim()
    : defaultSkillsDir();
  const statePath = config.statePath && config.statePath.trim() !== ''
    ? config.statePath.trim()
    : skillsDir.replace(/[\\/]+$/, '') + '.state.json';
  const state = new SkillState(statePath);
  await state.load();
  ctx.logger.info(`dsh-skill-manager: 插件激活（skillsDir=${skillsDir}，statePath=${statePath}）`);

  const disposers = [];
  try {
    if (config.webApi) {
      const skillsService = ctx.skills;
      ctx.inject(['webServer'], (httpCtx) => {
        httpCtx.effect(() => {
          const routes = installSkillsApi(httpCtx, {
            skillsDir,
            state,
            skills: skillsService,
            logger: ctx.logger,
            githubToken: config.githubToken,
          });
          return () => {
            for (const dispose of routes) dispose();
          };
        }, 'dsh-skill-manager: web api');
      });
    }
  } catch (err) {
    for (const dispose of disposers) dispose();
    throw err;
  }

  ctx.effect(() => {
    return () => {
      for (const dispose of disposers) dispose();
      ctx.logger.info('dsh-skill-manager: 已卸载');
    };
  }, 'dsh-skill-manager');
}
