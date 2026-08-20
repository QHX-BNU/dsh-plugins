# dsh-agent-factory

DSH「Agent 工厂」插件：**可复用的 subagent 模板库**。你可以（或让主 Agent 自行）为子智能体设定名称、职责、系统提示、**模型供应商（provider）与模型名**、token 上限、工具限制等，保存为模板；之后一句话即可让指定模板的子智能体去执行任务，模板可随时编辑、反复复用。

## 功能

- **侧边栏「Agent 工厂」入口**（与"定时任务 / 插件市场 / 设置"同级），独立面板：
  - **我的 Agent**：模板卡片列表（id / 名称 / 描述 / 系统提示预览 / 模型路由 / 使用次数），支持搜索、**运行**（填写任务即可试运行，前台直接展示结果，后台提交到任务面板）、**编辑 / 复制 / 删除**；
  - **新建 Agent**：表单编辑器——id、名称、职责描述、系统提示（persona）、模型供应商（自动列出当前已注册的供应商）、模型名（按供应商自动拉取模型列表）、maxTokens、递归委派深度、是否继承父对话上下文（fork）、工具白/黑名单。
- **主 Agent 可直接使用四个工具**：
  - `agent_list` 列出全部模板；
  - `agent_save` 新建或更新模板（**Agent 可自行编辑，包括模型供应商/模型名等全部字段**）；
  - `agent_run` 按模板委派子智能体执行任务（可临时覆盖模型路由，支持后台运行）；
  - `agent_delete` 删除模板。
- **系统提示片段**：启动后自动告知主 Agent 当前有哪些模板可用（`promptSection` 可关）。
- 对话里直接说「用 xx 模板跑一下……」即可，无需打开面板。

## 原理

- 运行时通过官方 `ctx.subagents.start(provider, request)` 委派**真实的 DSH 子智能体**：
  - `inheritContext=false` 走 `spawn` provider（全新上下文，子智能体看不到父对话）；`inheritContext=true` 走 `fork` provider（继承父对话已完成回合）；
  - 模型路由经 `request.agentOptions.{provider, model, maxTokens}` 覆盖——与官方 `dsh-tool-subagent` 的 `agentOptions` 配置（如 `subagent_vision` 强制 `aliyun/qwen3.7-flash-2026-07-15`）同一条路径；
  - 模板的系统提示经 `request.persona` 注入子智能体，`toolFilter` 限制其可见工具，`maxDepth` 限制递归委派深度。
- 模板库是单个 JSON 文件（`statePath`），原子写入，改动即时生效。
- 试运行（面板）以当前会话为父级：前台运行等待结果并展示（超时自动中止、关面板自动取消）；后台运行提交到官方任务面板（jobId），与 Agent 用 `agent_run` 后台运行一致。

## 安装

```powershell
powershell -ExecutionPolicy Bypass -File deploy.ps1 -Restart
```

（`-Restart` 会延迟 90 秒重启 DSH Desktop 使插件生效。）

或手动：复制插件到 profile 的 `node_modules`，并在 profile 的 `cordis.patch.yml` 追加：

```yaml
- insert:
    - id: dsh-agent-factory
      name: 'dsh-agent-factory'
      config:
        statePath: 'C:/Users/<你>/.dsh/profiles/desktop/data/agent-factory.json'
        webApi: true
```

## 配置项

| 字段 | 说明 | 默认 |
| --- | --- | --- |
| `statePath` | 模板库 JSON 存储路径 | `<home>/.dsh/agent-factory/agents.json` |
| `spawnProvider` | 全新上下文时的子智能体 provider | `spawn` |
| `forkProvider` | 继承上下文时的子智能体 provider | `fork` |
| `runTimeoutMs` | 面板前台运行超时（毫秒），超时自动中止 | `900000`（15 分钟） |
| `tools` | 是否注册 `agent_list/agent_save/agent_run/agent_delete` | `true` |
| `promptSection` | 是否注入系统提示片段（告知主 Agent 可用模板） | `true` |
| `webApi` | 是否注册可视化页面 API | `true` |

## 开发

```
dsh-agent-factory/
├── lib/
│   ├── index.js      # 服务端入口（Cordis 插件）
│   ├── store.js      # 模板库 JSON 存储（原子写入）
│   ├── runner.js     # 子智能体运行逻辑（spawn/fork、agentOptions 覆盖、超时）
│   ├── tools.js      # agent_list / agent_save / agent_run / agent_delete
│   ├── api.js        # HTTP API（/agent-factory/api/*）
│   └── client.js     # Web 客户端 bundle（侧边栏面板）
├── test/store.test.mjs   # 存储层测试
├── deploy.ps1 / restart-app.ps1
└── cordis.patch.yml
```

## 许可

MIT
