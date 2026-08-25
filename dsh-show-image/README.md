# dsh-show-image

DSH（DeepSeek Harness）界面内嵌图片插件：模型调用 `show_image` 工具，把本地图片
以**内联卡片**显示在 WebUI 对话里，点击图片打开页面内**灯箱大图**。

图片字节只走**展示通道**（工具结果 presentation），**永远不进模型历史** ——
对纯文本模型、多模态模型都安全，不会触发 `UNSUPPORTED_CONTENT`，会话不会损坏。

> 正好解决你「界面不能展示图片 / 点击图片后消失 / 那个展示图片工具不稳定」的痛点：
> `show_image` 是一条独立、可靠的用户可见展示通道，不依赖会出问题的原生消息图片渲染。

## 功能

- **`show_image` 工具**：传绝对路径数组，一次显示 1–12 张 png/jpg/jpeg/webp/gif。
- **内联图片网格**：按 `columns`（1–6 列，默认 3）排布，悬停显示完整路径，光标放大镜。
- **点击看大图**：全屏灯箱，✕ / 点遮罩 / Esc 三种方式关闭。
- **可选 caption**：`captions` 参数为每张图配说明文字。
- **模型只看到文本**：工具返回给模型的是路径列表，图片字节不进模型上下文。
- **主题适配**：同时适配深浅两套主题（统一用 `--dsw-alias-*` 语义变量，不用
  `--dsw-alias-brand-primary` 做背景，深色主题下它是近白色）。

## 安装

把本目录放到 DSH 插件工作区（如 `D:\Agent\DSH\plugins`），然后用 PowerShell 执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\deploy.ps1 -Restart
```

或手动：复制整目录到
`C:\Users\<你>\.dsh\profiles\desktop\node_modules\dsh-show-image`，
并在 profile 的 `cordis.patch.yml` 追加：

```yaml
- insert:
    - id: dsh-show-image
      name: 'dsh-show-image'
      config:
        maxImages: 12
        maxBytes: 83886080
        maxEmbedBytes: 2097152
        defaultColumns: 3
```

## 用法

重启后让模型调用：

> 请调用 show_image 工具，把 `C:\Users\xxx\shot.png` 显示给我。

模型调用 `show_image(paths=[...], captions=[...], columns=...)` → 对话出现内联图片卡片。

## 配置

| 配置项 | 默认 | 说明 |
| --- | --- | --- |
| `maxImages` | 12 | 单次最多显示的图片数 |
| `maxBytes` | 8 MiB | 单张读取上限（与附件服务上限取更小者） |
| `maxEmbedBytes` | 2 MiB | 单张可嵌入会话展示的最大字节数；data URL 随会话日志持久化，超限直接报错，避免日志膨胀 |
| `defaultColumns` | 3 | 默认网格列数（1-6） |

## 工作原理

```
模型调用 show_image(路径)
        │
        ▼
Host 端 execute
  ├─ 读取本地图片（png/jpg/jpeg/webp/gif）
  ├─ 存入附件库（内容寻址去重 + 元数据校验）
  └─ 生成 base64 data URL
        │
        ▼
render（模型可见）        presentationMeta（用户可见）
┌─────────────────┐     ┌──────────────────────────┐
│ 1. C:\a.png     │     │ images: [{ dataUrl, ... }]│
│ 2. C:\b.png     │     └──────────────────────────┘
└─────────────────┘                 │
        │                           ▼
   纯文本，安全                Client 端 tool.call.toolview
                                       渲染图片卡片
                                            │ 点击
                                            ▼
                              shell.overlay 灯箱（✕/点外部/Esc 关闭）
```

## 边界与限制

- 单张超过 `maxEmbedBytes` 会**报错**而不是静默降级（防止日志膨胀），调大配置即可。
- 图片以 base64 存于工具结果 meta，会随会话日志持久化——单会话大量大图会增大日志体积。
- 只支持 png / jpg / jpeg / webp / gif（附件库媒体类型）。
- 本插件只解决「给用户看图」方向；「模型看图」（`read_image`）走原生多模态通道。

## 许可

MIT
