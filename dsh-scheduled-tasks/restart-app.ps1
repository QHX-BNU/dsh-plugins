# 延迟重启 DSH Desktop（由 dsh-scheduled-tasks 部署触发）
# 等待一段时间让当前对话回合正常收尾，然后结束并重新拉起应用。
$ErrorActionPreference = 'Continue'
$log = Join-Path $env:TEMP 'dsh-restart-scheduled-tasks.log'
try {
    Start-Sleep -Seconds 90
    "restart: killing at $(Get-Date -Format o)" | Out-File $log -Append
    Get-Process -Name 'DSH Desktop' -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds 4
    $exe = 'D:\Program Files\deepseek harness\DSH Desktop\DSH Desktop.exe'
    $started = $false
    for ($i = 0; $i -lt 6 -and -not $started; $i++) {
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
