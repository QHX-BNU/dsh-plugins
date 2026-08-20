# dsh-skill-manager

DSH Skill 管理插件：下载、启用/禁用、删除 skills；对话输入框输入 `@` 弹出选择器，可选用 **skill** 或**工作区文件**并支持搜索。

## 功能

- **侧边栏入口**：与"定时任务 / 插件市场 / 设置"同级的"Skill 管理"入口，打开独立面板：
  - **已安装**：列出本地 skills（启用/禁用状态、来源、安装时间），支持搜索、启用/禁用、删除、按来源刷新；同时展示系统级（其他来源）skills 供参考。
  - **市场**：从 GitHub 仓库扫描 `SKILL.md` 并一键下载安装（内置精选仓库，也支持任意 `owner/repo`）。
- **@ 输入选择器（两级路由）**：对话输入框输入 `@` 先弹出「技能 / 工作区文件」两个分类（与"子智能体/命令"并列），点击分类后再显示对应内容：
  - **技能**：按名称/描述/适用场景模糊搜索，选中后以**引用框（chip）**插入输入框（label 为「技能 · 名称」），发送时序列化为 `/skill-name` 用户显式调用手势（服务端 `SKILL_GESTURE` 识别，等价于直接输入 `/skill-name`）；
  - **工作区文件**：按文件名/路径搜索当前会话工作区（cwd）下的文件（依赖 `dsh-code-panel` 的 `/code-panel/api/search`，未安装时显示提示），选中后以**引用框（chip）**插入输入框（label 为「文件 · 相对路径」），发送时序列化为 `@相对路径`，模型可据此直接读取工作区文件；
  - 两种引用框都带背景色与圆角边框，与"子智能体"引用同一套宿主 chip 样式，一眼可辨类型；点击分类后 `@` 后已输入的查询词自动延续到第二级；菜单关闭（选中/Esc）后，下一次 `@` 重新从分类层开始。

## 原理

- 直接管理 `<dshHome>/skills`（官方 `dsh-skill-filesystem` 的 user-dsh root），目录被官方 watcher 监听，**任何改动即时反映到模型可见的 skill catalog**，无需自定义 provider。
- 下载格式为标准目录 bundle：`<skillsDir>/<name>/SKILL.md`（frontmatter 必须含 kebab-case `name` 与非空 `description`）。
- **禁用 = 把 `SKILL.md` 改名为 `SKILL.md.disabled`**（目录与资源保留，官方发现规则不再匹配，catalog 中消失）；启用则改回。扁平格式 `<name>.md` 同理改为 `<name>.md.disabled`。
- **@ 工作区文件（两级菜单 + 结构引用）**：`@` 菜单先显示「选择」分类层（技能 / 工作区文件），点击分类后通过宿主 launcher（`controller.toggleSource`）打开只含该分类的单分组菜单，`@` 后已输入的查询词延续；三个 @ 源（选择/技能/工作区文件）始终注册，按会话内当前阶段返回候选（非当前阶段返回空数组，空分组不渲染）。文件分组从 `sessions` 服务取当前会话 `cwd`，调用 `dsh-code-panel` 的 `/code-panel/api/search` 递归搜索（文件名/路径子串匹配、前缀优先）。选中技能/文件返回 `{ insert: { source, ref, label, clipboardText } }`——宿主输入机器 mint 为 occurrence chip（占位符 `￼` + 背景色引用框，`「技能 · 」/「文件 · 」` 前缀 label 区分类型），提交时经各源 `codec.serialize` 展开为 `/skill-name` 或 `@相对路径`（与宿主 subagent 引用 `@name` 惯例一致）。两个插件通过 `dsh-code-panel:probe` 事件做能力探测。

## 安装

```powershell
powershell -ExecutionPolicy Bypass -File deploy.ps1 -Restart
```

（`-Restart` 会延迟 90 秒重启 DSH Desktop 使插件生效。）

或手动：复制插件到 profile 的 `node_modules`，并在 profile 的 `cordis.patch.yml` 追加：

```yaml
- insert:
    - id: dsh-skill-manager
      name: 'dsh-skill-manager'
      config:
        skillsDir: 'C:/Users/<你>/.dsh/skills'
        statePath: 'C:/Users/<你>/.dsh/profiles/desktop/data/skill-manager.json'
        githubToken: ''
        webApi: true
```

## 配置项

| 字段 | 说明 | 默认 |
| --- | --- | --- |
| `skillsDir` | 本地 skills 根目录 | `<DSH_HOME>/skills` |
| `statePath` | 安装来源状态 JSON（用于"刷新"） | `<skillsDir>.state.json` |
| `githubToken` | 可选 GitHub Token（提高 API 限流上限） | 空 |
| `webApi` | 是否注册可视化页面 API | `true` |

## 开发

```
dsh-skill-manager/
├── lib/
│   ├── index.js      # 服务端入口（Cordis 插件）
│   ├── fs-store.js   # 文件扫描 / 启用禁用 / 状态存储 / frontmatter 解析
│   ├── market.js     # GitHub 仓库扫描与下载
│   ├── api.js        # HTTP API（/skill-manager/api/*）
│   └── client.js     # Web 客户端 bundle（侧边栏入口 + 面板 + @ 选择器）
├── cordis.patch.yml  # 启用配置示例
└── deploy.ps1        # 一键部署（复制 + 注册 + 可选重启）
```

## 许可

MIT
