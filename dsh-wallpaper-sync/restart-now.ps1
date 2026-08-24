$ErrorActionPreference = 'Continue'
$log = Join-Path $env:TEMP 'dsh-wallpaper-sync-restart.log'
try {
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
