/**
 * dsh-retract-prompt —— DSH 撤回指令插件（服务端入口）。
 *
 * 功能：在每条用户指令消息下方的操作区提供「撤回」按钮 ——
 *  1. Agent 正在运行时点击：先停止当前运行（等价于「停止生成」）；
 *  2. 然后把这条指令从会话中真正撤回（连同其后的回复一起移除，
 *     不再参与对话），内容放回主输入框，修改后重新发送。
 *
 * 说明：DSH 会话事件日志是 append-only，官方没有删除 API；本插件在会话
 * 静止后截断内存日志并重写持久化文件（详见 lib/retract.js）。
 *
 * 依赖：仅使用 Node 内置模块；服务通过 ctx 注入（sessions / sessionPersistence /
 * webServer）。
 */
import z from '@deepseek-ai/schemastery';
import { installRetractApi } from './retract.js';

export const name = 'dsh-retract-prompt';

export const Config = z.object({
  /** 点击撤回时若 Agent 正在运行，是否先自动停止当前运行（否则仅放回输入框）。 */
  autoStop: z.boolean().default(true),
});

export async function apply(ctx, config) {
  ctx.logger.info(`dsh-retract-prompt: 已激活（autoStop=${config.autoStop}）`);
  // 显式声明所有依赖服务：webServer（可能晚就绪）+ sessions + sessionPersistence
  // （cordis 要求先 inject 才能访问 ctx 服务，否则报 “cannot get property ... without inject”）
  ctx.inject(['webServer', 'sessions', 'sessionPersistence'], (httpCtx) => {
    httpCtx.effect(() => {
      const routes = installRetractApi(httpCtx);
      ctx.logger.info(`dsh-retract-prompt: 撤回 API 已注册（${routes.length} 条路由）`);
      return () => {
        for (const dispose of routes) dispose();
      };
    }, 'dsh-retract-prompt: web api');
  });
  ctx.effect(() => {
    return () => {
      ctx.logger.info('dsh-retract-prompt: 已卸载');
    };
  }, 'dsh-retract-prompt');
}
