# DSH Plugins

[DeepSeek Harness (DSH)](https://github.com/QHX-BNU/dsh-plugins) 的插件集合。每个插件是一个独立的 [Cordis](https://cordis.js.org/) 插件包，包含服务端入口（`lib/index.js`）与 Web 客户端 bundle（`lib/client.js`）。

## 插件列表

| 插件 | 版本 | 说明 |
| --- | --- | --- |
| [dsh-code-panel](./dsh-code-panel) | 0.1.0 | 右侧代码面板：浏览工作区代码与 Agent 代码片段，选中代码即可作为引用直接发给 Agent 解释 |
| [dsh-memory-admin](./dsh-memory-admin) | 0.1.0 | 记忆管理：直接修改记忆模块内容 + 对话中直接看到加载了哪些记忆模块（零外部依赖，`node:sqlite`） |
| [dsh-retract-prompt](./dsh-retract-prompt) | 0.1.0 | 撤回指令：停止当前运行并把最后一条用户指令放回编辑器重新编辑，修改后再发送，避免错误指令被继续误执行 |
| [dsh-scheduled-tasks](./dsh-scheduled-tasks) | 0.1.0 | 定时任务：设置任务执行时间（一次性/每天/每周/间隔）与内容，到点自动向会话发消息唤醒 Agent 或执行系统命令 |
| [dsh-skill-manager](./dsh-skill-manager) | 0.1.0 | Skill 管理：侧边栏管理入口（下载/启用/禁用/删除 skills），对话输入框输入 @ 弹出 skills 选择器并支持搜索 |
| [dsh-agent-factory](./dsh-agent-factory) | 0.1.0 | Agent 工厂：可复用的 subagent 模板库（指定子智能体做任务，模板可编辑——含模型供应商/模型名等，可复用；侧边栏管理面板 + agent_list/agent_save/agent_run/agent_delete 四个工具） |
| [dsh-tool-manager](./dsh-tool-manager) | 0.1.0 | 工具管理：显示 DSH 全部工具，制作自定义工具（定义参数与执行代码，保存后主 Agent 立即可用），禁用/启用/删除任意工具（侧边栏面板 + toolmgr_list/create/edit/delete/toggle 五个工具） |

## 安装

将插件目录放到 DSH 的插件工作区中，DSH 会通过 `cordis.patch.yml` 自动应用补丁并加载插件。

## 开发

每个插件目录结构：

```
<plugin>/
├── lib/               # 服务端 + 客户端 bundle
├── cordis.patch.yml   # Cordis 补丁配置
├── package.json       # 插件元信息（dsh.client 声明 Web 客户端入口）
└── README.md          # 插件说明
```

## 许可

MIT
