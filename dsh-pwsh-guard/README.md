# dsh-pwsh-guard

融合版 DSH（DeepSeek Harness）PowerShell 守门插件：**在命令执行前发现坑、自动修复 bash 风格写法、并提供无需转义的结构化执行入口**。

它把社区四个插件的能力合并成一个零依赖包：

| 能力 | 来源思路 | 本插件里的形态 |
| --- | --- | --- |
| 静态检查 + 拦截 | chaggle/dsh-powershell-check | `tools/pre-execute` 闸门（命中阻断级规则 → deny + 修复建议） |
| 自动修复 | GuTianshuo/powershell-fix | `fixer`：行卫生 + bash 语义转换 + 命令 shim（幂等） |
| 免转义结构化执行 | fengbai2233/dsh-pwsh-quoting-guard | `pwsh_run` / `run_argv`：正文单 argv、数据走 `$DSH_ARGS`、argv 直传 |
| 超长脚本兜底 | sryimnoob123/dsh-tool-pwsh-safe | 脚本超过 24KB 自动切 `-EncodedCommand` |
| 真语法校验 | 自研 | AST 解析（PowerShell 内置 Parser），给出带行列的语法错误 |
| 工具接管 | 自研 | per-agent restriction 隐藏内置 pwsh（`takeover: replace`） |
| 分析器管理 | 自研 | `pwsh_analyzer` 检测/一键安装 PSScriptAnalyzer |
| 后台任务 | 自研 | `pwsh_run { background: true }`：有 job 控制器走官方 jobs，否则插件托管（`pwsh_job`） |
| 破坏性操作闸 | 自研 | 自动修复产生的破坏性命令必须 `dangerous: true` 确认才执行 |
| 审计日志 | 自研 | deny / fix / force / danger 落盘 `audit.jsonl`，用 `pwsh_audit` 查看 |

## 为什么需要它（本机实测环境）

- DSH 的 `pwsh` 工具在这台机器上实际运行 **Windows PowerShell 5.1**（`powershell.exe`），`pwsh` 并不在 PATH。
- 控制台代码页 936（GBK）：中文与原生程序输出容易乱码。
- 只读沙箱下运行在 ConstrainedLanguage：`.NET` 静态调用、`Add-Type`、COM 直接失败。

由此产生的典型错误：`&&` / `||`（5.1 不支持）、`?:` 三元、`$var:` 解析、`npm` 裸调用被执行策略拦截、`if ($x = 5)` 恒真、`ConvertTo-Json` 截断、原生程序吞引号……本插件把这些整理成 22 条规则，其中 8 条为阻断级。

## 三个工具 + 一个闸门 + 一个 skill

### 闸门：`tools/pre-execute`

每次 `pwsh` 工具调用前做静态检查：

- 命中**阻断级**规则（R2/R3/R5/R6/R7/R10/R11/R14）→ 返回 `deny`，拒绝原因是规则的修复指引 **以及自动修复后的可执行命令**；
- 命中**建议级**规则 → 记录日志后放行；
- 配置 `mode: warn` 时全部放行只记日志，`mode: off` 关闭。

### 工具：`pwsh_run`（推荐执行入口）

```
pwsh_run { script, args?, cwd?, fix?, force?, background? }
```

- `script` 逐字传入，**不需要任何引号转义**；多行脚本直接贴；
- 数据放 `args`，脚本里读 `$DSH_ARGS[0]`、`$DSH_ARGS[1]`（由插件负责转义，模型永不转义）；
- 默认先自动修复 bash 风格写法，再静态检查，最后经 `ctx.sandbox` 与内置 `pwsh` 相同的沙箱执行；
- 内置 UTF-8 前导（`[Console]::OutputEncoding` + `chcp 65001`），中文与原生程序输出不再乱码；
- 输出词表与内置 `pwsh` 一致：`[stderr]`、`[output truncated; full output: ...]`、`[exit code: N]`、`[sandbox: ...]`；
- `dangerous: true` 才允许执行"自动修复产生的破坏性命令"（见下文"破坏性操作闸"）；
- `background: true` 时启动后台任务并立即返回 `jobId`，模式自动选择：
  - 部署有 job 控制器时注册进官方 `ctx.jobs`（kind=`pwsh`），用内置 `job_output` / `job_list` / `job_kill` 操作——同一张任务表，天然互通；
  - 精简 profile 没有 job 控制器时（`jobs.start` 会拒绝：`no job controller serves this agent`），自动降级为**插件托管的本地任务**，用 `pwsh_job { action: "read" | "kill" | "list" }` 操作；输出按 offset 增量读取，每次 read 附带状态（running / exited: N / failed）。

### 工具：`pwsh_check`

只做检查、不执行：`pwsh_check { script, fix? }`。适合在生成 `.ps1` 或复杂命令前自查，`fix: true` 时同时输出修复后的版本。

### 工具：`run_argv`

`run_argv { program, args?, cwd? }`：argv 逐字传递、完全不经 shell。用于 git / node / python 等原生程序——PS 5.1 会把内嵌双引号静默吞掉，这里不会。

### 工具：`pwsh_analyzer`（v0.3）

`pwsh_analyzer { action }`：

- `action: "status"`：检测官方 PSScriptAnalyzer 是否安装，返回版本或未安装提示；
- `action: "install"`：一键安装到当前用户（先尝试把 PSGallery 标记为 Trusted，再 `Install-Module PSScriptAnalyzer -Scope CurrentUser -Force`），完成后自动复检版本并回报。

`analyzer: psscriptanalyzer` 且模块缺失时，`pwsh_check` 会直接给出 `pwsh_analyzer { action: "install" }` 这条一键指引。

### 工具：`pwsh_job`（v0.5）

`pwsh_job { action }` 管理插件托管的本地后台任务：

- `action: "list"`：列出全部本地任务（id / 状态 / 标签）；
- `action: "read", jobId`：读取**自上次读取以来**的增量输出，并附当前状态；
- `action: "kill", jobId`：终止任务。

若任务注册在官方 jobs 表里，会提示你改用内置 `job_output` / `job_kill`；`action: "read"|"kill"` 遇到未知本地 id 时也会给出这条提示。

### 破坏性操作闸（v0.6）

自动修复**不得成为破坏性操作的执行路径**。`pwsh_run` 在修复后会评估危险级别，命中以下任一项且命令**确实被修复改过**时，默认拒绝执行并列出原因：

- 对根路径 / 盘符 / 用户主目录 / 系统目录做递归或强制删除（`rm -rf /`、`Remove-Item C:\ -Recurse -Force`、`$env:USERPROFILE` …）；
- 磁盘/分区级操作（`Format-Volume`、`Clear-Disk`、`diskpart` …）；
- 修改执行策略（非 `-Scope Process`）；
- 系统/用户级持久化（`setx`、`[Environment]::SetEnvironmentVariable`、`Run` 注册表项、计划任务、`New-Service`）；
- 关机/重启。

确认执行请显式传 `dangerous: true`（会记审计）；用 `fix: false` 执行你自己写的原命令则不受此闸限制（那道边界交给 DSH 的沙箱与审批）。项目目录内的普通递归删除（`rm -rf ./dist`）不在此列，照常执行。

### 工具：`pwsh_audit`（v0.6）

`pwsh_audit { action }` 读取审计日志（`$DSH_HOME/storages/dsh-pwsh-guard/audit.jsonl`）：

- `action: "stats"`：聚合统计——事件计数（deny / warn / fix / force / danger-block / danger-confirm / deep-block / background）、最常命中的规则、最常触发的修复转换；
- `action: "tail", limit?`：最近 N 条原始记录（默认 20，最大 200）。

用途：规则该留该删、修复器有没有改错，都有数据可查。日志里包含命令片段（最多 300 字符），注意不要把它提交到公开仓库。

### 深度检查：AST 语法 + PSScriptAnalyzer（v0.2）

规则是启发式的，AST 才是真解析。`pwsh_run` / `pwsh_check` 会先跑一次「深度检查」：

- 用 PowerShell 内置的 `[System.Management.Automation.Language.Parser]::ParseInput` 解析脚本，
  任何语法错误都以 `L行:C列 + 错误信息 + 片段` 返回（例如 `缺少右 }`）；
- 脚本通过 stdin 以 `base64(UTF-16LE)` 传入探针进程：不写临时文件、不受命令行长度限制、编码无歧义；
- 探针只解析、不执行用户脚本，因此不走沙箱 confine；
- 配置 `deepCheck: run`（默认）只在 `pwsh_run` / `pwsh_check` 里做；`all` 时连 `pwsh` 闸门也做（每条命令多约 0.3s 启动开销）；`off` 关闭；
- 配置 `analyzer: psscriptanalyzer` 时，同一进程内再跑官方 PSScriptAnalyzer（`-ScriptDefinition`，不落盘），Error/ParseError 视为阻断、Warning 提示；未安装模块时自动跳过（`missing`）。

### 输出防护：乱码提示（v0.2）

`tools/post-execute` 钩子检查内置 `pwsh` 工具的返回文本，命中高置信度乱码特征（`锟斤拷` / `ï»¿` / `â€` / 大量替换字符）时，在结果里追加一条提示：改用 `pwsh_run`（内置 UTF-8 前导）或前置 `chcp 65001`。正常文本不受影响。

### 工具接管：用 pwsh_run 顶掉 pwsh（v0.3）

配置 `takeover: replace` 后，插件监听 `agent/created`，在每个 agent（含子代理）的 scope 上用官方 per-scope restriction API 隐藏全局 `pwsh`：

```js
agent.ctx.tools.restrict({ deny: ["pwsh"] })
```

- 模型可见的 shell 工具只剩 `pwsh_run` / `run_argv` / `pwsh_check`；
- 这是官方 scoped restriction：**可逆、可热卸载**（agent 释放或插件卸载时自动 dispose）；
- 全局注册的 `pwsh_run` 等不受影响；但其他按名字调用 `pwsh` 的插件/预设会看不到该工具，介意就保持默认 `off`；
- 接管只改可见性，不碰官方实现：把 `takeover` 改回 `off` 即恢复。

### 教学：`pwsh-guard` skill

内置 `SKILL.md`，通过 `ctx.skills.registerProvider` 注册到会话 skill 目录，模型可在需要时加载完整规范（本机事实、工具选择、22 条坑位、示例）。
## 安装

### 本地 link（开发态）

```powershell
dsh plugin --profile desktop add link:D:/Agent/DSH/plugins/dsh-pwsh-guard
```

该命令会：pnpm 安装（零依赖，几乎立即完成）→ 识别包内 `dsh.bundle.patch` → 把 `dsh-pwsh-guard` 登记进 profile 的 `dsh.profile.bundles`。重启 `dsh web` / DSH Desktop 后生效。

### 发布后

```powershell
dsh plugin --profile <name> add dsh-pwsh-guard
```

### 只装 skill（不装插件）

仓库根目录就是一个 skill bundle：把 `SKILL.md` 放到 `$env:USERPROFILE/.dsh/skills/pwsh-guard/` 即可（只影响提示词，不改执行链）。

### 卸载

```powershell
dsh plugin --profile desktop remove dsh-pwsh-guard
```

## 配置

配置位于 `cordis.patch.yml` 的 `config`（用户 patch 层可覆盖，热应用）：

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `mode` | `deny` | `deny` 拦截阻断级规则；`warn` 只记日志放行；`off` 关闭闸门 |
| `lang` | `zh` | 规则说明与 deny 原因的语言：`zh` / `en` |
| `autoFix` | `true` | `pwsh_run` 是否默认自动修复 bash 风格写法 |
| `shell` | `auto` | PowerShell 可执行文件：`auto`（优先 pwsh，回退 powershell.exe）/ `pwsh` / `powershell` |
| `deepCheck` | `run` | 深度检查范围：`off` / `run`（pwsh_run + pwsh_check）/ `all`（含 pwsh 闸门） |
| `analyzer` | `builtin` | `builtin` 只用内置 AST；`psscriptanalyzer` 额外跑 PSScriptAnalyzer（未装则跳过） |
| `outputGuard` | `true` | 内置 pwsh 输出疑似乱码时追加提示 |
| `takeover` | `off` | `replace` = 在每个 agent 的可见工具里隐藏内置 `pwsh`，只能用 `pwsh_run` / `run_argv` |
| `disableRules` | `[]` | 临时关闭的规则 id，例如 `["R10", "R17"]` |

## 规则表（22 条）

阻断级（命中即拒绝执行）：

| 规则 | 检测 |
| --- | --- |
| R2 | `$var:` 被解析为驱动器限定语法 |
| R3 | PS 5.1 没有三元 `?:` |
| R5 | `Start-Process` 包裹外部命令 |
| R6 | `-FeatureName A, B` 逗号数组形式 |
| R7 | DISM 没有 `/Dismount-Image` 动词 |
| R10 | 裸 `npm` / `npx` / `pnpm`（执行策略） |
| R11 | PS 5.1 不支持 `&&` / `||` |
| R14 | `if/while` 条件里单 `=`（赋值不是比较） |

建议级（提示但放行）：R1（GBK 乱码）、R4（双引号内 `$NAME.`）、R8（RestoreHealth 源版本）、R9（curl -L 与 -C -）、R12（ConvertTo-Json -Depth）、R13（foreach 里的 `$_`）、R15（PS 7+ 语法）、R16（cmd 风格 / `%VAR%`）、R17（Write-Host）、R18（乱码痕迹）、R19（Remove-Item 位置对象）、R20（ConstrainedLanguage 下的 .NET 静态调用/Add-Type/COM）、R21（内联 `-Command` 下的 `$PSScriptRoot`）、R22（原生程序吞引号）。

## 修复器会做的转换（幂等）

```
export NAME=value      -> $env:NAME='value'
unset NAME             -> if (Test-Path Env:NAME) { Remove-Item Env:NAME }
a && b / a || b        -> a; if ($?) { b } / if (-not $?) { b }
> /dev/null            -> > $null（含 2> 与 &>）
npm / npx / pnpm       -> 追加 .cmd
ls -l/-a               -> Get-ChildItem
rm -r/-f               -> Remove-Item -Recurse/-Force
mkdir -p               -> New-Item -ItemType Directory -Force
touch                  -> Test-Path + New-Item 或更新时间戳
grep [-r] [-v]         -> Select-String（-r 走 Get-ChildItem -Recurse）
which                  -> (Get-Command x ...).Source
head/tail(-f)          -> Get-Content -TotalCount / -Tail / -Wait
cp / mv 带参数         -> Copy-Item / Move-Item
行卫生                  -> CRLF、粘贴的提示符、反斜杠续行、缺失续行、悬空反引号
```

无法安全改写的（`sed` / `awk` / `chmod` / `sudo`）只输出提示，不猜。
## 开发

```powershell
cd D:\Agent\DSH\plugins\dsh-pwsh-guard
npm test          # node --test：规则 26 + 修复器 8 + AST 3 + 危险识别 3 + 审计 3 + 插件集成 37 + 后台 7 = 87 例
npm run check     # 四个模块的语法检查
```

零运行时依赖，纯 ESM JavaScript，不需要构建步骤。

```
lib/rules.js    22 条静态检查规则 + check() / formatHits()
lib/fixer.js    行卫生 + bash->PowerShell 转换 + 命令 shim，fix() / formatNotes()
lib/exec.js     UTF-8 前导、$DSH_ARGS 绑定、-EncodedCommand 兜底、沙箱 confine、输出渲染
lib/index.js    插件入口：pre-execute 闸门 + pwsh_run / pwsh_check / run_argv + skill provider
test/           规则、修复器、假 ctx 集成测试（全部离线可跑）
SKILL.md        给模型的规范（由 skill provider 提供）
```

## 已知限制

- 规则是**启发式正则**，不是 PowerShell 解析器：极端写法可能误报/漏报。误报时可用 `disableRules` 关闭单条规则，或在 `pwsh_run` 上传 `force: true`（不建议）。
- `fixer` 对多级链式组合（`a && b || c`）生成的是**近似语义**（`a; if ($?) { b }; if (-not $?) { c }`），与原 shell 的短路细节可能不同；复杂脚本请改写后再执行。
- 默认按 **PowerShell 5.1** 假设工作（R3/R11/R15 等）。切换到 PS 7 后可用 `disableRules` 关掉这些规则，或等后续版本加 `shellProfile` 配置。
- 插件不改变 DSH 的沙箱与审批策略：`pwsh_run` 与内置 `pwsh` 走同一条执行/审批通道。

## 与参考插件的关系

- 想只要**拦截检查**：`chaggle/dsh-powershell-check` 更轻（本插件的 R1–R19 即其规则表）。
- 想只要**修复后执行**：`GuTianshuo/powershell-fix` 更专注。
- 想只要**免转义执行**：`dsh-tool-pwsh-safe` / `dsh-pwsh-quoting-guard` 已经够用。
- 本插件的价值：把三层合成一个包，并补上 DSH 环境专属规则（R20–R22）、双语规则说明、修复后命令回显、`force` 逃生阀与离线测试。

## 许可

MIT。来源与致谢见 [NOTICE](./NOTICE)。