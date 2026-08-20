# dsh-code-panel —— DSH 右侧代码面板

在 DeepSeek Harness 的 Web 界面右侧（details 栏）提供一个**代码显示区域**：

- **工作区文件**：懒加载浏览当前会话工作区（cwd）下的目录与文件，语法高亮显示；
  图片文件（png/jpg/gif/webp/svg/bmp 等）按文件头魔数校验后直接在面板中预览；
- **我的代码（Agent 片段）**：显示 `data/code-panel/snippets/` 目录下的代码文件——
  Agent（AI）在对话中写好的代码保存到该目录即可出现在面板中；图片片段同样可预览；
- **选中即引用**：在代码区选中文本（或未选中则整文件），点「解释这段代码」，
  代码会作为**用户引用**直接发给 Agent 解释；也可「插入输入框」先编辑再发送，
  或「复制」「编辑器打开」（利用系统关联，已安装 VSCode 时会在 VSCode 中打开）。

## 安装

把插件放进 profile 的 node_modules（如 `C:\Users\<你>\.dsh\profiles\desktop\node_modules\dsh-code-panel`），
并在 profile 的 `cordis.patch.yml` 追加：

```yaml
- insert:
    - id: dsh-code-panel
      name: 'dsh-code-panel'
      config:
        snippetsDir: 'C:/Users/<你>/.dsh/profiles/desktop/data/code-panel/snippets'
        maxFileBytes: 1048576
        maxImageBytes: 20971520
        webApi: true
```

重启 DSH Desktop 生效（浏览器会自动重新加载）。

## 使用

1. 会话输入框下方会出现「代码面板」按钮，点击打开右侧面板；
2. 「工作区文件」标签：展开目录 → 点击文件查看代码（自动按扩展名高亮）；
3. 「我的代码」标签：查看 Agent 代码片段；
4. 在代码区用鼠标选中要解释的代码（不选则发送整个文件），
   点「解释这段代码」——代码以引用形式作为用户消息发出，Agent 会解释它；
5. 「插入输入框」把代码放进输入框供编辑后自行发送。

## Agent 如何添加片段

把写好的代码保存为文件到 `snippetsDir`（例如：
`C:\Users\20230\.dsh\profiles\desktop\data\code-panel\snippets\check-disk.ps1`），
面板「我的代码」标签即会列出；删除文件即可移除。

## 配置项

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `webApi` | `true` | 是否注册面板所需的 HTTP API |
| `maxFileBytes` | `1048576` | 单文件预览大小上限（字节），超出提示用编辑器打开 |
| `maxImageBytes` | `20971520` | 图片预览大小上限（字节，默认 20MB），超出提示无法预览 |
| `excludeDirs` | `node_modules/.git/dist/...` | 文件树忽略的目录名（小写） |
| `snippetsDir` | `data/code-panel/snippets` | Agent 代码片段目录（相对路径基于 profile 目录） |

## 说明

- 面板占用的是界面右侧原有的 details 栏（与工具调用详情面板互斥，本插件优先级更高；
  如需恢复工具调用详情，禁用本插件即可）。
- 文件读取仅限当前会话工作区（cwd）之内，片段仅限 snippetsDir 之内；
  二进制文件与超限文件只提示、不读取内容；图片必须通过文件头魔数校验才会被
  当作图片返回（防伪装），图片预览同样受大小上限与符号链接逃逸防护约束。
- 符号链接（symlink）条目不会出现在文件树中，且读取时会按真实路径再次校验
  是否仍位于工作区之内，防止链接指向工作区之外的文件。
- 零外部依赖：宿主端仅用 Node 内置 `node:fs` / `node:path`；浏览器端自带轻量高亮器。
