# dsh-scheduled-tasks —— DSH 定时任务插件

在 DeepSeek Harness 的**左侧边栏底部**新增 **「定时任务」** 入口（与「设置」
同级并列，点击打开独立面板），可以：

1. **设置任务执行时间**，支持四种模式：
   - **一次性**：指定某个日期时间，到点执行一次后自动停用；
   - **每天**：每天固定时刻（如 `09:00`）执行；
   - **每周**：勾选若干星期 + 时刻（如周一/周三/周五 10:00）；
   - **间隔**：每隔 N 分钟执行一次（跳过错过的周期，不积压）。
   - 每天 / 每周 / 间隔模式还可设置**起止日期**（可选）：限定执行区间，
     未到开始日期不执行，到达结束日期后任务自动停用并标记"已结束"。
2. **设置任务内容（动作）**，两种动作：
   - **发消息到会话**：到点后向指定会话投递一条用户消息并**唤醒 Agent** 处理
     （例如"每天 9 点提醒我：该整理今日待办了"）；
   - **执行命令**：到点通过系统 shell 运行一条命令，输出记录在任务历史中。

支持任务的新建 / 编辑 / 启用暂停 / 立即执行（手动触发一次）/ 删除，
并展示下次执行时间、上次执行结果与最近执行历史。

## 直接和 Agent 对话设置任务

插件注册了 5 个 Agent 工具，直接在对话里说即可，无需打开面板：

| 工具 | 作用 | 例子 |
| --- | --- | --- |
| `task_create` | 创建任务（一次性/每天/每周/间隔，支持起止日期） | "帮我设一个每天上午 9 点的定时任务，提醒我写日报，发到当前会话" |
| `task_list` | 查看全部任务 | "现在有哪些定时任务？" |
| `task_delete` | 删除任务 | "把『提醒写日报』这个任务删掉" |
| `task_toggle` | 启用/暂停任务 | "暂停那个每小时的任务" |
| `task_run_now` | 立即执行一次 | "现在手动跑一次那个清理任务" |

- 时间由 Agent 换算：支持带时区偏移的 ISO 8601，也支持无偏移的本地时间
  （按服务器本地时区解释，可用 `timeZone` 参数指定）；
- session 动作不填会话时默认投递到**当前会话**。

## 工作原理

- **时间计算**：任务按 IANA 时区（创建时取自浏览器本地时区）计算下次执行时刻，
  正确处理夏令时（DST）切换与负偏移时区；一次性任务保存为 UTC。
- **调度**：服务端维护一个 setTimeout 驱动的最小到期堆，到期后串行执行所有
  到期任务并重新排期；超过 Node 定时器上限（约 24.8 天）的等待会自动分片。
- **持久化**：任务列表保存为 JSON 文件（原子写入）；应用重启后自动恢复调度，
  过期未执行的一次性任务标记"错过"并停用，重复任务直接跳到下一个自然触发点；
  超出结束日期的任务自动停用并标记"已结束"。
- **消息投递**：通过 `agent.followup()` 官方通道投递（source 标记为
  `plugin: dsh-scheduled-tasks`），与手动发送走同一 inbox 流程。

## 安装

把插件放进 profile 的 `node_modules`（例如
`C:\Users\<你>\.dsh\profiles\desktop\node_modules\dsh-scheduled-tasks`），
并在 profile 的 `cordis.patch.yml` 追加：

```yaml
- insert:
    - id: dsh-scheduled-tasks
      name: 'dsh-scheduled-tasks'
      config:
        tasksPath: 'C:/Users/<你>/.dsh/profiles/desktop/data/scheduled-tasks.json'
```

重启 DSH Desktop 生效。

## 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `tasksPath` | `data/scheduled-tasks.json` | 任务存储文件路径（建议绝对路径） |
| `commandTimeoutMs` | `120000` | 命令动作超时（毫秒） |
| `commandCwd` | `''` | 命令动作工作目录（空 = 进程工作目录） |
| `webApi` | `true` | 是否注册可视化页面 API（侧边栏面板依赖） |
| `agentTools` | `true` | 是否注册 Agent 对话工具（task_create / task_list 等） |
| `fallbackToOpenSession` | `true` | 发消息动作的目标会话未打开时，自动转投到当前打开的根会话（避免提醒落空） |
| `missedGraceMinutes` | `30` | "刚错过"补执行窗口（分钟）：系统睡眠/重启导致定时器延迟时，窗口内自动补执行一次；`0` 关闭 |

## 关于准点与系统睡眠

定时器基于 Node `setTimeout`，**系统睡眠/休眠期间不会触发**（这是 JS 定时器的固有限制，
Electron/Node 应用都如此）。本插件做了两层兜底：

1. **唤醒后自动补执行**：DSH 恢复运行时（重启/唤醒），若重复任务的原计划时刻落在
   `missedGraceMinutes`（默认 30 分钟）窗口内，立即补执行一次，历史中标注
   "错过原计划 … 后补执行"；超过窗口则跳过，直接等下一次（避免补无意义的旧提醒）。
2. **延迟标注**：定时器延迟触发（如睡眠唤醒）执行时，历史中注明
   "原计划 … 实际延迟 N 分钟"，方便排查。

若电脑在任务时刻处于睡眠状态，提醒会在唤醒后第一时间送达（窗口内）。

## HTTP API（同源）

```
GET  /scheduled-tasks/api/list
POST /scheduled-tasks/api/save     { id?, task }
POST /scheduled-tasks/api/delete   { id }
POST /scheduled-tasks/api/toggle   { id, enabled }
POST /scheduled-tasks/api/run-now  { id }
```

## 说明与限制

- 服务端仅依赖 Node 内置模块与 DSH 注入的服务（webServer / agents / sessions），
  无外部依赖。
- **发消息动作要求目标会话已打开**（Agent 处于活动状态）；会话未打开时执行
  失败并记录在任务历史中。
- 命令动作使用系统 shell（Windows 为 cmd，其余为 /bin/sh），请确认命令内容
  可信；输出最多记录 2000 字符。
- 界面适配深浅两套主题（按钮使用深底白字，不依赖 brand-primary 背景）。
