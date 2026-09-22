$ErrorActionPreference = "Stop"
$packageRoot = Split-Path -Parent $PSScriptRoot
$runtimeRoot = Join-Path $packageRoot "runtime"

function Stop-RecordedProcess {
  param([string]$PidFile, [string]$Name)
  if (-not (Test-Path -LiteralPath $PidFile)) { return }
  $rawPid = (Get-Content -LiteralPath $PidFile -Raw).Trim()
  if ($rawPid -match '^\d+$') {
    $targetProcess = Get-Process -Id ([int]$rawPid) -ErrorAction SilentlyContinue
    if ($targetProcess) {
      Stop-Process -Id $targetProcess.Id
      $targetProcess.WaitForExit(10000)
      Write-Host "$Name 已停止。"
    }
  }
  Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
}

Stop-RecordedProcess -PidFile (Join-Path $runtimeRoot "web.pid") -Name "Minerva Web"
Stop-RecordedProcess -PidFile (Join-Path $runtimeRoot "data-api.pid") -Name "Minerva 数据服务"

try { & (Join-Path $packageRoot "services\wikijs\stop.ps1") } catch { Write-Warning $_.Exception.Message }
try { & (Join-Path $packageRoot "backend\scripts\stop_postgres.ps1") } catch { Write-Warning $_.Exception.Message }

Write-Host "Minerva 本地服务已停止。" -ForegroundColor Green

