# dsh-usage-panel

DeepSeek Harness（DSH）**用量/费用面板**插件。在 Web 界面侧边栏底部提供一个「用量」入口，点击打开独立面板，展示：

- **DeepSeek 官方账户余额**（通过 `/user/balance` API）
- **会话 Token 用量汇总**：输入（缓存未命中 / 命中）、输出、缓存写入、推理
- **按模型的 Token 拆分** 与 **估算费用**（价格表可按模型配置）
- 近 7 天每日 token

**兼容性**：适配 DSH Desktop 2.0.2 / `@deepseek-ai/dsh-*@0.1.1-rc.2`。
客户端 bundle 使用已验证的 `sidebar.footer.action` 注入方式（与 dsh-scheduled-tasks 一致），
不使用会导致渲染崩溃的 `settings.section` 方式。

> ⚠️ 说明：官方插件市场里的 `dsh-token-usage@2.2.0`（按 `0.1.0-rc.6` 构建）在
> `0.1.1-rc.2` harness 上 web 面板渲染即崩溃，已确认不可用。本插件为本机 `0.1.1-rc.2`
> 自研适配版。

## 安装

1. 把插件目录复制到 profile 的 `node_modules`：
   ```powershell
   Copy-Item -Recurse -Force "D:\Agent\DSH\plugins\dsh-usage-panel" `
     "C:\Users\<你>\.dsh\profiles\desktop\node_modules\dsh-usage-panel"
   ```
2. 在 profile 的 `cordis.patch.yml` 追加：
   ```yaml
   - insert:
       - id: dsh-usage-panel
         name: 'dsh-usage-panel'
         config:
           webApi: true
           balance: true
           currency: CNY
   ```
3. 重启 DSH Desktop 生效。

## 数据来源

> DeepSeek 官方 API **没有**"用量统计"汇总接口——它只在**每次请求的响应**里返回本次的 `usage`。
> 你的 harness（`dsh-llm-deepseek`）已在每条请求后把官方 `usage` **原样记录**进会话 telemetry。
> 本插件读取的就是这份**官方逐次返回的实际用量**（非估计），聚合后即为累计官方用量。

| 字段 | 来源 |
| --- | --- |
| 账户余额 | `GET https://api.deepseek.com/user/balance`（使用 `~/.dsh/.credentials.yaml` 中的 `DEEPSEEK_API_KEY`） |
| Token 用量 | **官方逐次返回的实际值**：读取全部本地会话（`sessionQuery`，含 live + 持久化），聚合事件 `data.usage`（`inputTokens`/`outputTokens`/`cacheReadTokens`/`cacheWriteTokens`/`reasoningTokens`）。`maxSessions=0`（默认）读取全部会话；设大于 0 只取最近 N 个（更快） |
| 估算费用 | **估算**：内置价格表（CNY/1M tokens）× 上述官方用量；DeepSeek 不返回每次请求花费，故费用必须按价格表计算。可按模型在 `config.prices` 覆盖；USD 按 ≈7.1 换算 |

> Token 用量是**官方实际值**；费用是**估算**（按价格表 × 官方用量），仅供参考，实际计费以 DeepSeek 官方为准。

## 目录结构

```
dsh-usage-panel/
├── lib/
│   ├── index.js   # 宿主入口（name/Config/inject/apply）
│   ├── api.js     # /dsh-usage/api/summary 路由（余额 + session 汇总 + 费用）
│   └── client.js  # Web 客户端 bundle（sidebar.footer.action 面板）
├── cordis.patch.yml  # profile 启用配置示例
└── package.json      # 插件元信息（dsh.client 声明 web 客户端）
```

## 许可

MIT
