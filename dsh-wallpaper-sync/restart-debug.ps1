# 带 remote-debugging-port 重启 DSH Desktop，便于 CDP 诊断客户端
$ErrorActionPreference = 'Continue'
$log = Join-Path $env:TEMP 'dsh-wallpaper-sync-debug.log'
try {
    Start-Sleep -Seconds 75
    "debug: killing at $(Get-Date -Format o)" | Out-File $log -Append
    Get-Process -Name 'DSH Desktop' -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds 4
    $exe = 'D:\Program Files\deepseek harness\DSH Desktop\DSH Desktop.exe'
    $started = $false
    for ($i = 0; $i -lt 8 -and -not $started; $i++) {
        if (-not (Get-Process -Name 'DSH Desktop' -ErrorAction SilentlyContinue)) {
            Start-Process -FilePath $exe -ArgumentList '--remote-debugging-port=9222'
        }
        Start-Sleep -Seconds 3
        $started = [bool](Get-Process -Name 'DSH Desktop' -ErrorAction SilentlyContinue)
    }
    "debug: done started=$started at $(Get-Date -Format o)" | Out-File $log -Append
} catch {
    "debug: ERROR $($_.Exception.Message)" | Out-File $log -Append
}
