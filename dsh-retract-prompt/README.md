# dsh-retract-prompt —— DSH 撤回指令插件

在 DeepSeek Harness 的 Web 界面上，**每条用户指令消息下方**的操作区都会多出
一个 **「✎ 撤回」** 按钮（Agent 运行时显示为 **「⏹ 停止并撤回」**，红色提示）：

1. 发现指令输错了 → 点该条指令下方的 **「撤回」**；
2. 若 Agent 正在运行，会先自动停止当前运行（与「停止生成」同一机制）；
3. 这条指令会**从对话中真正撤回**：连同其后的所有内容（Agent 的回复、工具
   调用等）一起从会话历史中移除，**不再参与对话**；
4. 指令原文**直接放回会话主输入框**，修改后点发送即可重新发起。

同时保留原版的 **「复制」** 按钮与消息时间（悬停显示），操作区位于每条
用户消息气泡下方、与复制按钮同一行。

## 工作原理与限制

- DSH 的会话事件日志是 append-only，官方**没有删除消息的 API**。本插件在
  会话静止后执行"截断回退"：截断内存会话日志到目标消息之前，并用内存事件
  重写持久化文件（原子替换），同时同步持久化层的写游标，保证后续消息正常
  落盘；客户端随后重载会话窗口，被撤回的消息立即从界面消失。
- 若目标消息位于某个尚未结束的回合内（运行中输入的消息），撤回边界会
  自动前移到该回合开始之前（连同该回合一起撤回）。
- **不可恢复**：撤回会永久删除该消息及其后的会话记录（包括 Agent 对它的
  回复），请确认后再操作。
- 系统注入的上下文（context / command / compaction 等消息）不显示撤回按钮。
- 实现方式：接管 `conversation.chat.node` 的 `user` / `steering` 渲染（优先级
  最低），若本插件的渲染器出错会自动回退到 DSH 原版渲染器，不影响正常使用。

## 安装

把插件放进 profile 的 `node_modules`（例如
`C:\Users\<你>\.dsh\profiles\desktop\node_modules\dsh-retract-prompt`），
并在 profile 的 `cordis.patch.yml` 追加：

```yaml
- insert:
    - id: dsh-retract-prompt
      name: 'dsh-retract-prompt'
      config:
        autoStop: true
```

重启 DSH Desktop 生效。

## 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `autoStop` | `true` | 点击撤回时若 Agent 正在运行，是否先自动停止当前运行 |

## 说明

- 服务端仅依赖 Node 内置模块（fs / zlib）与 DSH 注入的服务
  （sessions / sessionPersistence / webServer），无外部依赖。
- 界面适配深浅两套主题（气泡背景沿用 `--dsw-specific-bubble`，toast 使用
  深底白字，深色主题下同样清晰）。
