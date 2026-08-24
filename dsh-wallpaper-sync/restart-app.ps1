# 延迟重启 DSH Desktop（由 dsh-wallpaper-sync 部署/安装触发）
# 由当前对话回合结束后自动执行：等待一段时间，结束并重新拉起应用，使插件生效。
# 以独立 OS 进程运行，不依赖本会话存活。
$ErrorActionPreference = 'Continue'
$log = Join-Path $env:TEMP 'dsh-wallpaper-sync-restart.log'
try {
    Start-Sleep -Seconds 75
    "restart: killing at $(Get-Date -Format o)" | Out-File $log -Append
    Get-Process -Name 'DSH Desktop' -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds 4
    $exe = 'D:\Program Files\deepseek harness\DSH Desktop\DSH Desktop.exe'
    $started = $false
    for ($i = 0; $i -lt 8 -and -not $started; $i++) {
        if (-not (Get-Process -Name 'DSH Desktop' -ErrorAction SilentlyContinue)) {
            Start-Process -FilePath $exe
        }
        Start-Sleep -Seconds 3
        $started = [bool](Get-Process -Name 'DSH Desktop' -ErrorAction SilentlyContinue)
    }
    "restart: done started=$started at $(Get-Date -Format o)" | Out-File $log -Append
} catch {
    "restart: ERROR $($_.Exception.Message)" | Out-File $log -Append
}
