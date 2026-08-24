/**
 * dsh-wallpaper-sync —— DSH 背景与 Windows 桌面壁纸同步插件（宿主端）
 *
 * 读取 Wallpaper Engine 当前激活的壁纸源，经同源 HTTP 路由供给浏览器端，
 * 浏览器端把它作为 DSH 全界面背景渲染，并轮询跟随桌面壁纸切换。
 *
 * 零外部依赖：仅使用 Node 内置 node:fs / node:path / node:child_process。
 *
 * 用法（profile 的 cordis.patch.yml）：
 * ```yaml
 * - insert:
 *     - id: dsh-wallpaper-sync
 *       name: 'dsh-wallpaper-sync'
 *       config:
 *         weConfigPath: 'D:/Program Files/Steam/steamapps/common/wallpaper_engine/config.json'
 *         monitor: 'Monitor0'
 *         pollIntervalMs: 3000
 *         webApi: true
 * ```
 */
import z from '@deepseek-ai/schemastery';
import { installWallpaperSyncApi } from './api.js';
import { detectWeConfigPath } from './we.js';

export const name = 'dsh-wallpaper-sync';

export const Config = z.object({
  /** Wallpaper Engine 的 config.json 路径；留空则自动探测。 */
  weConfigPath: z.string().default(''),
  /** WE selectedwallpapers 里要跟随的显示器 key（默认取第一个非空）。 */
  monitor: z.string().default(''),
  /** 前端轮询配置变更的间隔（毫秒）。 */
  pollIntervalMs: z.number().min(500).max(60000).default(3000),
  /** 壁纸加载失败时是否降级为纯色背景（false 则恢复 DSH 默认背景）。 */
  fallbackOnError: z.boolean().default(true),
  /** 是否注册可视化 API（浏览器端背景依赖它）。 */
  webApi: z.boolean().default(true),
});

export async function apply(ctx, config) {
  ctx.logger.info(
    `dsh-wallpaper-sync: 激活（weConfigPath=${config.weConfigPath || 'auto'}，monitor=${config.monitor || 'auto'}，pollIntervalMs=${config.pollIntervalMs}）`,
  );

  try {
    const resolvedCfg = (await detectWeConfigPath(config.weConfigPath)) || config.weConfigPath;
    if (resolvedCfg) {
      ctx.logger.info(`dsh-wallpaper-sync: WE config = ${resolvedCfg}`);
    } else {
      ctx.logger.warn('dsh-wallpaper-sync: 未能定位到 Wallpaper Engine config.json，请设置 weConfigPath');
    }

    if (config.webApi) {
      ctx.inject(['webServer'], (httpCtx) => {
        httpCtx.effect(() => {
          const routes = installWallpaperSyncApi(httpCtx, {
            weConfigPath: resolvedCfg,
            monitor: config.monitor,
            pollIntervalMs: config.pollIntervalMs,
            fallbackOnError: config.fallbackOnError,
          });
          return () => {
            for (const dispose of routes) dispose();
          };
        }, 'dsh-wallpaper-sync: web api');
      });
    }
  } catch (err) {
    ctx.logger.error(`dsh-wallpaper-sync: 初始化失败：${err.message}`);
    throw err;
  }

  ctx.effect(() => {
    return () => {
      ctx.logger.info('dsh-wallpaper-sync: 已卸载');
    };
  }, 'dsh-wallpaper-sync');
}
