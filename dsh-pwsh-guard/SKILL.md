---
name: pwsh-guard
description: 在 Windows 上写或执行 PowerShell 之前必读。本机 DSH 实际运行 Windows PowerShell 5.1；先查坑再执行，优先用 pwsh_run 绕开引号与编码问题，原生程序用 run_argv。
---

# PowerShell 守门规范（dsh-pwsh-guard）

## 0. 本机事实（先记住）

- DSH 的 `pwsh` 工具在这台机器上实际执行的是 **Windows PowerShell 5.1**（`powershell.exe`），不是 PowerShell 7。
- 控制台代码页是 936（GBK）：中文与原生程序输出容易乱码；插件内置的 `pwsh_run` 会强制 UTF-8 前导。
- 只读沙箱下 PowerShell 运行在 ConstrainedLanguage：`.NET` 静态调用、`Add-Type`、COM 会直接失败。
- 由此推出：没有三元 `?:`；没有 `&&` / `||`；没有 `??` / `?.`；`-AsHashtable` 等 7+ 参数不存在；`npm` / `npx` / `pnpm` 要写 `npm.cmd` / `npx.cmd` / `pnpm.cmd`。

## 1. 该用哪个工具

| 场景 | 用什么 |
| --- | --- |
| 命令含引号、`$`、`%`、反斜杠、中文路径，或有多行逻辑 | `pwsh_run`：脚本体逐字传入，数据放 `args`，脚本里读 `$DSH_ARGS[0]`、`$DSH_ARGS[1]` |
| 只是想先检查命令/脚本有没有已知坑 | `pwsh_check`（不会执行） |
| 检查/安装 PSScriptAnalyzer | `pwsh_analyzer`（action: status / install） |
| 看防护实际拦了什么、修复器改了什么 | `pwsh_audit`（action: stats / tail） |
| 需要长期运行的任务（dev server、监听、下载） | `pwsh_run { background: true }` → 拿 jobId。有官方 job 控制器用 `job_output` / `job_kill`；否则用 `pwsh_job { action: "read"|"kill"|"list" }` |
| 调 git / node / python 等原生程序，参数可能含引号 | `run_argv`：argv 逐字传递，完全不经 shell |
| 简单、无引号无变量的命令 | 直接用内置 `pwsh` 工具（会被本插件静态检查） |

自动修复只负责"改对语法"：如果修复把命令变成了破坏性操作（递归删除系统路径、磁盘操作、持久化写入等），`pwsh_run` 默认拒绝执行，需要显式 `dangerous: true` 才放行。

`pwsh_run` 会在执行前自动做两件事：把 bash 风格写法修成 PowerShell（`&&`、`npm`、`ls -la`、`rm -rf`、`/dev/null`、`export` 等），再做静态检查；命中阻断级坑位就拒绝执行并给出修复建议。真的需要原样执行时传 `force: true`（不建议）。

## 2. 高频坑清单（插件会自动拦截 blocking 项）

### 硬错误（blocking，命中会被拒绝执行）

- **R2** `$var:` 会被解析成驱动器语法。要写 `${var}:`；`$env:` 这类作用域前缀是安全的。
- **R3** PS 5.1 没有三元 `?:`。用 `if/else` 赋值。
- **R5** `Start-Process` 包外部命令时引号规则极其别扭。直接 `& exe arg`。
- **R6** `-FeatureName A, B` 不是数组。用 `foreach` 每次传一个。
- **R7** DISM 没有 `/Dismount-Image`，正确写法是 `/Unmount-Image`。
- **R10** 裸 `npm` / `npx` / `pnpm` 会命中 `npm.ps1` 执行策略。写 `npm.cmd`。
- **R11** PS 5.1 不支持 `&&` / `||`。用 `;`、分行，或 `if ($LASTEXITCODE -eq 0) { ... }`。
- **R14** `if ($x = 5)` 是赋值不是比较（条件恒真）。比较用 `-eq`。

### 容易出错（advisory，会提示但放行）

- **R1** WSL / DISM 相关输出前加 `chcp 65001 | Out-Null`（或用 `pwsh_run`）。
- **R4** 双引号里 `$NAME.` 会被当属性访问。路径含 `.` 时用单引号或 `${NAME}.`。
- **R8** `RestoreHealth` 带 `/Source` 时源版本必须不高于当前系统。
- **R9** `curl -L` 不要和 `-C -` 混用。
- **R12** `ConvertTo-Json` 默认 `-Depth 2` 会截断嵌套，加 `-Depth 100`。
- **R13** `foreach ($x in ...)` 里 `$_` 不是循环变量。
- **R15** 不要用 PS 7+ 专有语法（本机是 5.1）。
- **R16** 不要写 cmd 风格（`del`、`copy`、`%VAR%`）。
- **R17** `Write-Host` 输出不进管道；要捕获结果用 `Write-Output`。
- **R18** 文本里出现乱码痕迹时重新生成；`.ps1` 用 UTF-8 with BOM 保存。
- **R19** `Remove-Item $items` 若 `$items` 来自 `Get-ChildItem`，应传 `-LiteralPath $items.FullName` 或管道。
- **R20** 只读沙箱下不要用 `[System.IO.File]::`、`[math]::`、`Add-Type`、COM。
- **R21** 内联 `-Command` 下 `$PSScriptRoot` / `$MyInvocation` 是空的；要写 `.ps1` 文件执行。
- **R22** PS 5.1 给原生程序传含引号的参数会被静默吞掉；用 `run_argv` 或临时文件。

## 3. 修复器会自动做的转换

```
export NAME=value            -> $env:NAME='value'
unset NAME                   -> if (Test-Path Env:NAME) { Remove-Item Env:NAME }
a && b  /  a || b            -> a; if ($?) { b } / if (-not $?) { b }
> /dev/null                  -> > $null   （2> 与 &> 同理）
npm install x                -> npm.cmd install x
ls -la .                     -> Get-ChildItem . -Force
rm -rf x                     -> Remove-Item x -Recurse -Force
mkdir -p a/b                 -> New-Item -ItemType Directory -Force -Path a/b
touch f                      -> Test-Path + New-Item 或更新时间戳
grep [-r] [-v] pat path      -> Select-String（-r 走 Get-ChildItem -Recurse）
which x                      -> (Get-Command x -ErrorAction SilentlyContinue).Source
head -n N / tail -n N / tail -f -> Get-Content -TotalCount / -Tail / -Wait
cp / mv 带参数               -> Copy-Item / Move-Item
行尾反斜杠续行、粘贴的提示符、CRLF、缺失续行 -> 规范化
```

## 4. 不会自动改写的（只提示）

`sed`、`awk`、`chmod`、`sudo`：没有安全的一一对应，插件只提示，请人工改写；`sed` 通常可用 `-replace` + `Set-Content` 代替。

## 5. 示例

```powershell
# 推荐：数据走 args，正文里不出现任何字面量
pwsh_run: script = "(Get-Content -LiteralPath $DSH_ARGS[0] -Raw).Trim()"
          args   = ["E:\\目录 with space\\$100 %TEMP% it's file.txt"]

# 原生程序传参
run_argv: program = "git", args = ["commit", "-m", "fix: 含空格与 \"引号\" 的消息"]

# 自查
pwsh_check: script = "npm install x && ls -la", fix = true
```

## 6. 深度检查（v0.2，pwsh_run / pwsh_check 自动执行）

- AST 语法解析：真正的解析器（不是模式匹配），语法错误带 `L行:C列`，例如 `[语法] (L2:C14) 缺少右 }`。
- `pwsh_check` 会同时给出规则命中、AST 结果，以及 `fix: true` 时的修复后版本。
- 配置 `analyzer: psscriptanalyzer` 时还会跑官方 PSScriptAnalyzer（未安装则跳过，不报错）。
- 语法错误会被 `pwsh_run` 拒绝执行（除非 `force: true`，不建议）。

另外：插件对 `@'...'@` here-string 内的内容不做规则检查与自动修复——写数据/其他语言代码时不会误报；要检查其中的 PowerShell 代码，请单独把代码片段传给 `pwsh_check`。

## 7. 工具接管与分析器管理（v0.3）

- 若配置了 `takeover: replace`，内置 `pwsh` 工具在本会话里**不可见**：PowerShell 一律用 `pwsh_run`，原生程序用 `run_argv`，查错用 `pwsh_check`。看不到 `pwsh` 不是故障，是接管生效。
- `pwsh_analyzer { action: "status" }` 查看 PSScriptAnalyzer 是否安装；`{ action: "install" }` 一键安装（当前用户范围，需要能访问 PSGallery）。安装后在 `pwsh_check` / `pwsh_run` 里启用 `analyzer: psscriptanalyzer` 即可获得官方规则检查。