# DSH Plugins

[DeepSeek Harness (DSH)](https://github.com/QHX-BNU/dsh-plugins) 的插件集合。每个插件是一个独立的 [Cordis](https://cordis.js.org/) 插件包，包含服务端入口（`lib/index.js`）与 Web 客户端 bundle（`lib/client.js`）。

## 插件列表

| 插件 | 版本 | 说明 |
| --- | --- | --- |
| [dsh-code-panel](./dsh-code-panel) | 0.1.0 | 右侧代码面板：浏览工作区代码与 Agent 代码片段，选中代码即可作为引用直接发给 Agent 解释 |
| [dsh-memory-admin](./dsh-memory-admin) | 0.1.0 | 记忆管理：直接修改记忆模块内容 + 对话中直接看到加载了哪些记忆模块（零外部依赖，`node:sqlite`） |
| [dsh-retract-prompt](./dsh-retract-prompt) | 0.1.0 | 撤回指令：停止当前运行并把最后一条用户指令放回编辑器重新编辑，修改后再发送，避免错误指令被继续误执行 |

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
