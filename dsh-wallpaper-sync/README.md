# dsh-wallpaper-sync —— DSH 背景与桌面壁纸同步

让 DeepSeek Harness 的 Web 界面**背景使用 Windows 桌面当前的壁纸**，并在你在桌面上切换壁纸时**自动跟随**。

- 面向 **Wallpaper Engine**（动态壁纸）设计：读取其当前激活壁纸，而不是只读 Windows 注册表静态壁纸。
- 按壁纸类型自动选择渲染方式：
  - **视频**（`.mp4/.webm`）→ `<video>` 静音循环播放；
  - **网页**（`.html`）→ `<iframe>` 渲染；
  - **Scene 场景**（`.pkg`，WE 私有格式）→ 取其同目录**静态预览帧**作为替代画面（浏览器无法播放 WE 私有场景）；
  - **静态图**（`.jpg/.png/.gif/.webp`）→ `<img>` 铺满。
- 内容面板做成"浮于壁纸之上"的半透明效果，保证可读性（深浅主题分别适配）。
- 右下角小浮钮打开设置面板：启用 / 跟随切换 / 内容不透明度 / 背景模糊 / 遮罩强度。

## 原理

Wallpaper Engine **不会**改写 Windows 注册表的桌面壁纸（注册表仍显示系统默认），所以读注册表拿不到 WE 的壁纸。本插件改为读取 WE 自己的配置：

```text
<WE 安装目录>/config.json  →  general.wallpaperconfig.selectedwallpapers.<monitor>.file
```

该路径指向当前正在用的壁纸源，宿主端经**同源 HTTP 路由**把媒体流式喂给浏览器端作背景层；浏览器轮询 `/wallpaper-sync/api/status` 发现 `file/monitor/kind` 变化即重新加载——这就是"跟随桌面切换"。

## 安装

1. 把插件放进 profile 的 node_modules（如 `C:\Users\<你>\.dsh\profiles\desktop\node_modules\dsh-wallpaper-sync`）。
2. 在 profile 的 `cordis.patch.yml` 追加：

```yaml
- insert:
    - id: dsh-wallpaper-sync
      name: 'dsh-wallpaper-sync'
      config:
        weConfigPath: 'D:/Program Files/Steam/steamapps/common/wallpaper_engine/config.json'
        monitor: 'Monitor0'
        pollIntervalMs: 3000
        webApi: true
```

3. 重启 DSH Desktop 生效（浏览器会自动重新加载）。

## 配置项

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `webApi` | `true` | 是否注册背景所需的 HTTP API |
| `weConfigPath` | 自动探测 | WE 的 `config.json` 路径。自动探测会读注册表 `HKCU\Software\WallpaperEngine\installPath`，失败再试常见 Steam 路径 |
| `monitor` | 自动 | `selectedwallpapers` 里要跟随的显示器 key；留空取第一个非空 |
| `pollIntervalMs` | `3000` | 轮询 WE 配置变更的间隔（毫秒） |
| `fallbackOnError` | `true` | 壁纸加载失败时是否降级为纯色背景 |

## HTTP API（webServer 注册）

- `GET /wallpaper-sync/api/current` → 当前壁纸元数据（kind / mediaUrl / sceneFrame / title / monitor）。
- `GET /wallpaper-sync/api/status` → 轮询用（file / monitor / kind / size），前端据此判断是否切换。
- `GET /wallpaper-sync/api/media` → 直接把当前壁纸源文件（或 Scene 静态帧）流式返回，支持 HTTP Range；带 `?key=` 时返回库中指定壁纸。
- `GET /wallpaper-sync/api/library` → 壁纸库列表（id / kind / title / current / previewUrl / mediaUrl），供选择器。
- `GET /wallpaper-sync/api/preview?key=` → 返回库条目的缩略图/预览帧。

## 安全边界

`/api/media` 与 `/api/preview` 只接受壁纸库白名单内的 `key`（规范化后的库文件路径），不接受任意路径参数，杜绝目录穿越读取任意文件。

## 说明

- 零外部依赖：宿主端仅用 Node 内置 `node:fs` / `node:path` / `node:child_process`；浏览器端仅原生 DOM + fetch。
- Scene 类型只能出**静态帧**（非逐帧动画）：WE 的 Scene 是私有着色器格式，浏览器无法播放；这是本插件对 Scene 的已知限制。
- 深浅主题均适配：控件用静态深底白字，背景遮罩与内容表面透明度按 `body[data-ds-dark-theme]` 分别配置。
- 本插件不修改 DSH 核心文件，卸载后界面即恢复默认。

## 设置面板（右下角 🖼 浮钮）

| 控件 | 默认 | 说明 |
| --- | --- | --- |
| 启用背景壁纸 | 开 | 开关背景壁纸 |
| 跟随桌面切换 | 开 | 开=同步当前桌面壁纸；关=用手动从壁纸库选的壁纸 |
| **壁纸库（点选即用）** | — | 列出 WE 壁纸库（视频/网页/场景/图片，带缩略图与类型角标），点某张即设为 DSH 背景；「刷新」重新扫描 |
| 动/静模式 | `自动` | `自动`=视频动播、Scene/图静态；`静态帧`=强制定格首帧/预览帧；`动态视频`=强制视频循环播放（仅对视频壁纸有效） |
| 屏幕适配 | `铺满(同桌面)` | `铺满`=cover 裁边铺满（与 Windows 桌面一致）；`完整显示`=contain 完整显示留白 |
| 背景位置 | `居中` | center / top / bottom / left / right |
| 内容不透明度 | `55%` | 越小越透出壁纸 |
| 背景模糊 | `0` | 壁纸模糊 px |
| 遮罩强度 | `30%` | 壁纸上叠加的纱帘，提升可读性 |
