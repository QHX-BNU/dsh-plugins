/**
 * dsh-usage-panel —— DSH 用量/费用面板插件（服务端入口）
 *
 * 在 Web 侧边栏提供一个「用量」入口，面板显示：
 *   1. DeepSeek 官方账户余额（通过官方 /user/balance API）；
 *   2. 会话 Token 用量汇总（input / output / cacheRead / cacheWrite / reasoning）；
 *   3. 按模型的 Token 拆分与估算费用（价格表可在 profile 配置里覆盖）。
 *
 * 兼容性：适配 DSH Desktop 2.0.2 / @deepseek-ai/dsh-*@0.1.1-rc.2。
 * 客户端 bundle 使用已验证的 `sidebar.footer.action` 写法（见 lib/client.js），
 * 不使用会导致渲染崩溃的 `settings.section` 注入方式。
 *
 * 用法（profile 的 cordis.patch.yml）：
 * ```yaml
 * - insert:
 *     - id: dsh-usage-panel
 *       name: 'dsh-usage-panel'
 *       config:
 *         webApi: true
 *         currency: CNY
 *         balance: true
 *         # 默认价格表（CNY / 1M tokens），可按模型覆盖，如：
 *         # prices:
 *         #   deepseek-chat: { inputPerM: 2, cacheReadPerM: 0.2, cacheWritePerM: 2, outputPerM: 3 }
 * ```
 */
import z from '@deepseek-ai/schemastery';
import { installUsageApi } from './api.js';

export const name = 'dsh-usage-panel';

/** 声明依赖：会话查询服务（读取 Token 用量）。webServer 可能晚就绪，单独用 ctx.inject 延迟。 */
export const inject = ['sessionQuery'];

/** 默认价格表：CNY / 1M tokens。key 为模型 id 前缀匹配（小写）；未知模型用 default。 */
export const DEFAULT_PRICES = {
  'deepseek-chat': { inputPerM: 2, cacheReadPerM: 0.5, cacheWritePerM: 2, outputPerM: 3 },
  'deepseek-reasoner': { inputPerM: 4, cacheReadPerM: 0.5, cacheWritePerM: 4, outputPerM: 16 },
  'deepseek-v3': { inputPerM: 2, cacheReadPerM: 0.5, cacheWritePerM: 2, outputPerM: 3 },
  'deepseek-v4': { inputPerM: 2, cacheReadPerM: 0.5, cacheWritePerM: 2, outputPerM: 3 },
  default: { inputPerM: 2, cacheReadPerM: 0.5, cacheWritePerM: 2, outputPerM: 3 },
};

export const Config = z.object({
  /** 是否注册可视化页面 API（侧边栏「用量」面板依赖它）。 */
  webApi: z.boolean().default(true),
  /** 是否查询 DeepSeek 官方余额。 */
  balance: z.boolean().default(true),
  /** 余额展示的货币（CNY / USD）。 */
  currency: z.string().default('CNY'),
  /** 读取会话数上限（0 = 全部会话，取完整官方累计用量；大于 0 则只取最近 N 个会话，更快）。 */
  maxSessions: z.number().min(0).default(0),
  /** 价格覆盖表（模型 id 前缀 → 单价）。未覆盖的模型回退到内置默认价格。 */
  prices: z.any().default({}),
});

/**
 * 解析某模型的单价。key 用小写模型 id；按「模型以 key 开头」或「key === default」匹配。
 * 返回 { inputPerM, cacheReadPerM, cacheWritePerM, outputPerM }。
 */
export function priceOf(model, overrides) {
  const key = String(model || 'default').toLowerCase();
  const table = { ...DEFAULT_PRICES, ...(overrides || {}) };
  // 先精确匹配，再前缀匹配（deepseek-chat-xxx 命中 deepseek-chat）
  const exact = table[key];
  if (exact) return exact;
  const best = Object.keys(table).find((k) => k !== 'default' && key.startsWith(k));
  if (best) return table[best];
  return table.default;
}

export async function apply(ctx, config) {
  const overrides = config.prices || {};
  try {
    ctx.logger.info(
      `dsh-usage-panel: 激活（webApi=${config.webApi}，balance=${config.balance}，currency=${config.currency}，自定义价格表=${Object.keys(overrides).length} 项）`,
    );

    if (config.webApi) {
      ctx.inject(['webServer'], (httpCtx) => {
        httpCtx.effect(() => {
          const disposers = installUsageApi(httpCtx, {
            sessionQuery: ctx.sessionQuery,
            balanceEnabled: config.balance,
            currency: config.currency,
            priceOverrides: overrides,
            maxSessions: config.maxSessions,
          });
          return () => {
            for (const dispose of disposers) dispose();
          };
        }, 'dsh-usage-panel: web api');
      });
    }

    ctx.effect(() => {
      return () => {
        ctx.logger.info('dsh-usage-panel: 已卸载');
      };
    }, 'dsh-usage-panel');
  } catch (err) {
    // 防御：任何初始化异常都不能让宿主崩溃；记录日志并继续运行。
    ctx.logger.error(`dsh-usage-panel: 初始化失败（插件已安全跳过）：${err && err.message ? err.message : String(err)}`);
  }
}
