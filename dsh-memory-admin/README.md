# dsh-memory-admin · DSH 记忆管理插件

一个**零外部依赖**的 DeepSeek Harness 记忆模块，解决两件事：

1. **直接修改记忆模块的内容** —— 提供 `memory_list / memory_view / memory_search / memory_add / memory_edit / memory_delete / memory_stats` 工具。你直接在对话里说"帮我看看记忆里有什么"、"把记忆 #12 改成……"、"删掉记忆 #5"，Agent 就会直接读写记忆库。
2. **直接看到对话加载了哪些记忆模块** —— 每轮对话开始时自动从记忆库召回相关记忆并注入上下文，对话界面会直接显示一条"记忆模块加载"卡片，列出本次加载了哪些记忆（ID / 分类 / 相关度 / 内容）。也可以用 `memory_loaded` 工具随时查询。

## 特点

- **零外部依赖**：存储用 Node 内置 `node:sqlite`（Node ≥ 22.13），不需要 Python、不需要 pip 装任何库、不需要联网安装 npm 包。
- **三层作用域**（决定哪些会话会加载这条记忆）：
  | 作用域 | 说明 | 如何指定 |
  |---|---|---|
  | `global` 全局 | 所有对话都会加载（适合用户偏好、长期事实） | 需显式指定（对话里说明"全局记忆"或页面选择"全局"） |
  | `workspace` 工作区 | 仅该工作区下的会话会加载 | 需显式指定（自动绑定当前会话所属工作区） |
  | `session` 会话 | 仅该会话会加载 | **默认层级**，无需指定 |
- **五层记忆模块**（与灵枢 AEIS 对齐，与作用域正交）：
  | 分类 | 标签 | 用途 |
  |---|---|---|
  | `anchor` | 锚点层 | 基础事实、身份设定 |
  | `structure` | 结构层 | 流程、方法论、知识结构 |
  | `knowledge` | 知识层 | 事实性知识、对话沉淀 |
  | `situation` | 情境层 | 具体场景、事件、上下文 |
  | `self` | 自我层 | 自我认知、偏好、反思 |
- **自动记忆**：真实用户消息自动沉淀（默认落在**会话级**，不污染其他会话/工作区，去重）。
- **对话召回**：轻量相关度打分（词元重叠 + 重要度 + 时效），无需 embedding；只在"全局 + 本工作区 + 本会话"可见范围内召回。
- **可审计**：每次加载都写入 `memory_loads` 表（会话、记忆、相关度、时间），`memory_stats` 可查"最近加载了什么、哪条记忆最常用"。
- **旧库自动迁移**：升级后旧记忆自动标记为「全局」（保持升级前到处可见的行为），可在设置页里改成其他层级。

## 安装

把 `dsh-memory-admin` 目录放入 profile 的 `node_modules`（例如 `C:\Users\<你>\.dsh\profiles\desktop\node_modules\dsh-memory-admin`），然后在 profile 的 `cordis.patch.yml` 中追加：

```yaml
- insert:
    - id: dsh-memory-admin
      name: 'dsh-memory-admin'
      config:
        dbPath: 'C:/Users/<你>/.dsh/profiles/desktop/data/memory-admin.db'   # 记忆库文件（建议绝对路径）
        autoRemember: true         # 用户消息自动沉淀
        autoRememberImportance: 0.6
        recallEnabled: true        # 对话自动召回记忆
        recallTopK: 5              # 每轮最多加载几条
        recallMinScore: 0.4        # 相关度最低分
        injectContext: true        # 是否注入对话（关闭则只记录不注入）
```

重启 DSH Desktop 后生效。

## 使用方法

### 在对话里直接修改记忆（说人话就行）

- "看看我的记忆库有什么" → `memory_list`（默认只看当前会话可见范围；说"全部/所有工作区"会用 `all=true`）
- "搜索一下关于 XX 的记忆" → `memory_search`（默认在当前会话可见范围内检索）
- "记住：我每周五要开周会" → `memory_add`（默认**会话级**）
- "把这条设为全局记忆" → `memory_add scope=global` / `memory_edit scope=global`
- "把这条设为工作区记忆" → `memory_add scope=workspace`（自动绑定当前工作区）
- "把记忆 #12 的内容改成……" → `memory_edit`
- "把记忆 #5 删掉" → `memory_delete`
- "这次对话加载了哪些记忆？" → `memory_loaded`

### 可视化页面（设置面板）

打开 DSH 设置面板（右上角齿轮），左侧导航点 **「记忆管理」**，即可进入可视化记忆管理页面：

- **查看**：记忆卡片列表，显示 ID、**作用域（全局/工作区/会话 + 归属 id）**、分类（模块）、重要度、标签、内容、创建/更新时间、被加载次数
- **搜索**：关键词即时搜索 + **作用域筛选** + 分类筛选 + 刷新
- **新增**：「＋ 新增记忆」填写内容/分类/重要度/标签/作用域（默认会话级；工作区/会话可下拉选择或手填归属 id）
- **修改**：卡片上「编辑」直接改内容/分类/重要度/标签/作用域，保存即时生效
- **删除**：「删除」二次确认后永久删除
- 顶部统计芯片显示总数与各作用域、各分类数量

### 在对话里直接看到加载的记忆

每轮新对话，插件会自动在可见范围（全局 + 本工作区 + 本会话）内召回相关记忆并显示为一条"记忆模块加载"上下文卡片（含记忆 ID、**作用域**、分类、重要度、相关度、内容）。如果某轮没有相关记忆则不显示。

## 工具一览

| 工具 | 说明 |
|---|---|
| `memory_list` | 列出记忆，支持分类/关键词/标签/**作用域**过滤、`all=true` 跨工作区查看、分页 |
| `memory_view` | 查看单条记忆详情 + 加载历史 |
| `memory_search` | 语义相关度搜索（当前会话可见范围，可标记为"加载"） |
| `memory_add` | 新增记忆（内容/分类/重要度/标签/**作用域**，默认会话级） |
| `memory_edit` | **直接修改**记忆（内容/分类/重要度/标签/**作用域**，只改传入字段） |
| `memory_delete` | 永久删除记忆 |
| `memory_stats` | 统计：总数、作用域/分类分布、最近加载、最常加载 |
| `memory_loaded` | 当前会话已加载的记忆列表 |

## 数据文件

- `memory-admin.db` —— SQLite 记忆库（`memories` 表 + `memory_loads` 加载审计表），直接用 SQLite 工具即可查看/备份/迁移。

## 开发

```bash
node test/smoke.mjs    # 存储层 + 召回算法烟雾测试
```
