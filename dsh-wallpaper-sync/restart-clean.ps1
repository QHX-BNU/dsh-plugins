$ErrorActionPreference = 'Continue'
$log = Join-Path $env:TEMP 'dswp-final-restart.log'
try {
    $dst = "C:\Users\20230\.dsh\profiles\desktop\node_modules\dsh-wallpaper-sync"
    # 清理调试脚本
    Remove-Item "$dst\restart-debug2.ps1" -ErrorAction SilentlyContinue
    Remove-Item "D:\Agent\DSH\plugins\dsh-wallpaper-sync\restart-debug2.ps1" -ErrorAction SilentlyContinue
    "cleanup done at $(Get-Date -Format o)" | Out-File $log -Append
    # 若当前实例带调试端口则正常重启（不带 --remote-debugging-port）
    $hasDbg = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -eq 9222 }
    if ($hasDbg) {
        "restarting to drop debug port at $(Get-Date -Format o)" | Out-File $log -Append
        Get-Process -Name 'DSH Desktop' -ErrorAction SilentlyContinue | Stop-Process -Force
        Start-Sleep -Seconds 4
        $exe = 'D:\Program Files\deepseek harness\DSH Desktop\DSH Desktop.exe'
        $started = $false
        for ($i = 0; $i -lt 8 -and -not $started; $i++) {
            if (-not (Get-Process -Name 'DSH Desktop' -ErrorAction SilentlyContinue)) { Start-Process -FilePath $exe }
            Start-Sleep -Seconds 3
            $started = [bool](Get-Process -Name 'DSH Desktop' -ErrorAction SilentlyContinue)
        }
        "done started=$started at $(Get-Date -Format o)" | Out-File $log -Append
    } else {
        "no debug port; nothing to restart at $(Get-Date -Format o)" | Out-File $log -Append
    }
} catch {
    "ERROR $($_.Exception.Message)" | Out-File $log -Append
}
