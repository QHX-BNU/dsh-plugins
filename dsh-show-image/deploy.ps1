# dsh-show-image 部署脚本：把插件同步到 desktop profile 并注册
# 用法：& .\deploy.ps1              # 只复制 + 注册，稍后手动重启
#       & .\deploy.ps1 -Restart     # 复制 + 注册后延迟重启（让当前回合收尾）
param(
    [switch]$Restart
)
$ErrorActionPreference = 'Stop'
$plugin = $PSScriptRoot        # 本脚本位于插件根目录
$name = Split-Path -Leaf $plugin
$profile = Join-Path $env:USERPROFILE '.dsh\profiles\desktop'
$dest = Join-Path $profile "node_modules\$name"
$patch = Join-Path $profile 'cordis.patch.yml'

Write-Host "==> Copy plugin to $dest"
if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
# robocopy：/XD node_modules 排除本地测试用的 @deepseek-ai junction
robocopy $plugin $dest /E /XD node_modules /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy copy failed (exit=$LASTEXITCODE)" }

$entry = @(
    ''
    '- insert:'
    "    - id: $name"
    "      name: '$name'"
    '      config:'
    '        maxImages: 12'
    '        maxBytes: 83886080'
    '        maxEmbedBytes: 2097152'
    '        defaultColumns: 3'
) -join [Environment]::NewLine

if (Select-String -Path $patch -Pattern "id: $name" -Quiet) {
    Write-Host '==> cordis.patch.yml already contains this plugin, skip append'
} else {
    Add-Content -Path $patch -Value $entry -Encoding UTF8
    Write-Host '==> Appended cordis.patch.yml entry'
}

if ($Restart) {
    Write-Host '==> Restarting DSH Desktop in 90s (let the current turn finish)...'
    $restartScript = Join-Path $PSScriptRoot 'restart-app.ps1'
    Start-Process powershell -WindowStyle Hidden -ArgumentList @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$restartScript`""
    )
} else {
    Write-Host '==> Deploy done. Please restart DSH Desktop for the plugin to take effect.'
}
