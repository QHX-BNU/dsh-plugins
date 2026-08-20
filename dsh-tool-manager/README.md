# dsh-tool-manager —— DSH 工具管理器

[DeepSeek Harness (DSH)](https://github.com/QHX-BNU/dsh-plugins) 的插件：集中管理 DSH 的**工具**（tools）。

## 功能

- **显示已有工具**：列出全部已注册工具（名称、描述、参数 schema、来源：系统/自定义、禁用状态、Agent 局部注册标记）。
- **制作对应工具**：在面板中定义工具名/描述/参数 schema/执行代码（JS），保存后立即注册为真实 DSH 工具，主 Agent 与模型马上就能调用；提供「计算转换 / 执行 PowerShell / 读取文件 / 调用 HTTP API」四种模板一键起步。
- **禁用 / 启用**：任意已注册工具（系统工具与自定义工具均可）可全局禁用——禁用后该工具从**所有 agent（含之后新建的会话/子 Agent）的可见工具列表消失**（模型看不到、调用报未知工具），启用即恢复。工具管理器自身的 `toolmgr_*` 受保护不可禁用。
- **删除 / 添加**：自定义工具可彻底删除（从注册表与存储移除）；系统工具只能禁用不能删除。
- **试运行**：面板中直接填参数运行工具代码，查看日志、返回值与耗时（未保存的代码也可试）。
- **主 Agent 也能管理**：注册 `toolmgr_list / toolmgr_create / toolmgr_edit / toolmgr_delete / toolmgr_toggle` 五个工具，Agent 可以自行查看、制作、修改、删除、禁用/启用工具。

## 自定义工具怎么写

执行代码是 `async (args, helpers) => { ...; return value; }` 的**函数体**，在 `node:vm` 沙箱中运行：

```js
// 例：把两个数相加并返回
const a = Number(args.a || 0);
const b = Number(args.b || 0);
return { sum: a + b };
```

| helpers | 说明 |
| --- | --- |
| `helpers.require` | Node `require`（相对插件目录解析），可引入 `node:fs`、`node:child_process` 等内置模块 |
| `helpers.fetch` | 全局 fetch，调用外部 HTTP 服务 |
| `helpers.log(...)` | 写入运行日志（面板与模型输出可见，`console.log` 亦可） |
| `helpers.now()` | 当前时间戳 |
| `helpers.env` | 只读环境变量快照 |

参数定义用 DSH 值 schema JSON：

```json
{
  "query": { "type": "string", "required": true, "description": "搜索关键词" }
}
```

支持类型：`string / number / integer / boolean / array / object / json`，属性可加 `required: true` 与 `description`。

## 安全说明

自定义工具代码在 DSH 主进程的 vm 沙箱中执行，沙箱不暴露 `process` / `require` 全局，宿主能力只能通过 `helpers` 显式获取；但 `helpers.require` 可按需引入任意 Node 模块（如 `child_process`），**权限与 pwsh/bash 工具同级**——只建议添加你自己信任的代码。执行有超时保护（默认 30s，可配置 `runTimeoutMs`）。

## 安装

将插件目录放到 DSH 插件工作区，然后在 profile（如 `C:\Users\<你>\.dsh\profiles\desktop`）的 `cordis.patch.yml` 追加：

```yaml
- insert:
    - id: dsh-tool-manager
      name: 'dsh-tool-manager'
      config:
        statePath: 'C:/Users/<你>/.dsh/profiles/desktop/data/tool-manager.json'
        runTimeoutMs: 30000
        tools: true
        promptSection: true
        webApi: true
```

或直接运行 `deploy.ps1 -Restart`（复制到 profile 并延迟重启 DSH Desktop）。

重启后侧边栏底部出现「工具管理」入口；主 Agent 可通过 `toolmgr_list` 等工具自行管理。

## 配置项

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `statePath` | `<home>/.dsh/tool-manager/state.json` | 自定义工具与禁用名单的存储路径 |
| `runTimeoutMs` | 30000 | 自定义工具单次执行超时（毫秒） |
| `tools` | true | 是否注册 `toolmgr_*` 五个管理工具 |
| `promptSection` | true | 是否向主 Agent 注入工具管理提示片段 |
| `webApi` | true | 是否注册可视化页面 API（侧边栏面板依赖） |

## 目录结构

```
dsh-tool-manager/
├── lib/
│   ├── index.js    # 插件入口（注册工具/API/提示片段/恢复状态）
│   ├── store.js    # 自定义工具 + 禁用名单持久化（JSON 文件，原子写入）
│   ├── registry.js # 工具注册表管理核心（列出/禁用/启用/注册）
│   ├── runtime.js  # 自定义工具执行器（node:vm 沙箱 + 超时保护）
│   ├── tools.js    # toolmgr_list/create/edit/delete/toggle 五个管理工具
│   ├── api.js      # Web HTTP API（/tool-manager/api/*）
│   └── client.js   # 侧边栏「工具管理」面板（浏览器 bundle）
├── cordis.patch.yml
├── package.json
├── deploy.ps1
└── restart-app.ps1
```

## 许可

MIT
