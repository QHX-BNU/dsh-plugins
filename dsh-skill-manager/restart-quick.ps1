# 快速重启 DSH Desktop（30 秒延迟，让当前回合收尾）
$ErrorActionPreference = 'Continue'
$log = Join-Path $env:TEMP 'dsh-restart-sm3.log'
try {
    Start-Sleep -Seconds 30
    "restart: killing at $(Get-Date -Format o)" | Out-File $log -Append
    Get-Process -Name 'DSH Desktop' -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds 5
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
