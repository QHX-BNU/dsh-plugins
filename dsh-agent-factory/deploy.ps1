# dsh-agent-factory 部署脚本：把插件同步到 desktop profile 并注册
# 用法：powershell -ExecutionPolicy Bypass -File deploy.ps1 [-Restart]
param(
    [switch]$Restart   # 加上 -Restart 则延迟 90 秒后重启 DSH Desktop（先让当前回合收尾）
)
$ErrorActionPreference = 'Stop'
$plugin = $PSScriptRoot        # 本脚本位于插件根目录
$name = Split-Path -Leaf $plugin
$profile = Join-Path $env:USERPROFILE '.dsh\profiles\desktop'
$dest = Join-Path $profile "node_modules\$name"
$patch = Join-Path $profile 'cordis.patch.yml'

Write-Host "==> 复制插件到 $dest"
if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
# robocopy：/XD node_modules 排除本地测试用的 @deepseek-ai junction
robocopy $plugin $dest /E /XD node_modules /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy 复制失败（exit=$LASTEXITCODE）" }

$entry = @"

- insert:
    - id: $name
      name: '$name'
      config:
        statePath: 'C:/Users/$env:USERNAME/.dsh/profiles/desktop/data/agent-factory.json'
        spawnProvider: 'spawn'
        forkProvider: 'fork'
        runTimeoutMs: 900000
        tools: true
        promptSection: true
        webApi: true
"@
if (Select-String -Path $patch -Pattern "- id: $name" -Quiet) {
    Write-Host '==> cordis.patch.yml 已包含该插件，跳过追加'
} else {
    Add-Content -Path $patch -Value $entry -Encoding UTF8
    Write-Host '==> 已追加 cordis.patch.yml 注册条目'
}

if ($Restart) {
    Write-Host '==> 90 秒后重启 DSH Desktop（让当前回合收尾）...'
    $restartScript = Join-Path $PSScriptRoot 'restart-app.ps1'
    Start-Process powershell -WindowStyle Hidden -ArgumentList @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$restartScript`""
    )
} else {
    Write-Host '==> 部署完成。请重启 DSH Desktop 使插件生效（本会话会中断）。'
}
