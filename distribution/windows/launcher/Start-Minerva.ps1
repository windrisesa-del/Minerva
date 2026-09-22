$ErrorActionPreference = "Stop"
$packageRoot = Split-Path -Parent $PSScriptRoot
$runtimeRoot = Join-Path $packageRoot "runtime"
$logsRoot = Join-Path $packageRoot "logs"
$nodeRoot = Join-Path $runtimeRoot "node"
$uvRoot = Join-Path $runtimeRoot "uv"
$nodeExe = Join-Path $nodeRoot "node.exe"
$webUrl = "http://127.0.0.1:30141"
$apiHealthUrl = "http://127.0.0.1:8000/api/health"
$workspaceUrl = "$webUrl/?cwd=$([Uri]::EscapeDataString($packageRoot))"

function Test-HttpReady {
  param([string]$Uri)
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $Uri -TimeoutSec 2
    return $response.StatusCode -lt 500
  } catch {
    return $false
  }
}

function Wait-HttpReady {
  param([string]$Uri, [int]$Seconds, [string]$Name)
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-HttpReady -Uri $Uri) { return }
    Start-Sleep -Milliseconds 500
  }
  throw "$Name 未能在 $Seconds 秒内启动。"
}

function Test-RecordedProcess {
  param([string]$PidFile)
  if (-not (Test-Path -LiteralPath $PidFile)) { return $false }
  $rawPid = (Get-Content -LiteralPath $PidFile -Raw).Trim()
  if ($rawPid -notmatch '^\d+$') { return $false }
  return $null -ne (Get-Process -Id ([int]$rawPid) -ErrorAction SilentlyContinue)
}

function Get-PackagePortOwnerId {
  param([int]$Port)
  $root = [IO.Path]::GetFullPath($packageRoot).TrimEnd("\")
  $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
  foreach ($listener in $listeners) {
    $listenerProcess = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
    if (-not $listenerProcess) { continue }
    try {
      $executable = [IO.Path]::GetFullPath($listenerProcess.Path)
      if ($executable.StartsWith("$root\", [StringComparison]::OrdinalIgnoreCase)) {
        return $listenerProcess.Id
      }
    } catch {
      continue
    }
  }
  return $null
}

try {
  if (-not [Environment]::Is64BitOperatingSystem) {
    throw "该交付包仅支持 64 位 Windows。"
  }

  New-Item -ItemType Directory -Force -Path $logsRoot | Out-Null
  & (Join-Path $PSScriptRoot "Bootstrap-Minerva.ps1") -PackageRoot $packageRoot
  $env:PATH = "$nodeRoot;$uvRoot;$env:PATH"
  $env:DATABASE_URL = "postgresql+psycopg://minerva@127.0.0.1:5432/minerva"
  $env:MINERVA_DATA_API_URL = "http://127.0.0.1:8000"
  $env:PI_CODING_AGENT_DIR = Join-Path $runtimeRoot "pi-agent"
  $env:MINERVA_STATE_DIR = Join-Path $runtimeRoot "minerva-state"
  $env:NODE_ENV = "development"
  New-Item -ItemType Directory -Force -Path $env:PI_CODING_AGENT_DIR | Out-Null
  New-Item -ItemType Directory -Force -Path $env:MINERVA_STATE_DIR | Out-Null

  $apiPidFile = Join-Path $runtimeRoot "data-api.pid"
  $apiReady = Test-HttpReady -Uri $apiHealthUrl
  $apiOwned = (Test-RecordedProcess -PidFile $apiPidFile) -or ($null -ne (Get-PackagePortOwnerId -Port 8000))
  if ($apiReady -and -not $apiOwned) {
    throw "端口 8000 已由当前安装包之外的服务占用，请先关闭其他 Minerva 实例。"
  }
  if (-not $apiReady -and $apiOwned) {
    Wait-HttpReady -Uri $apiHealthUrl -Seconds 60 -Name "Minerva 数据服务"
    $apiReady = $true
  }
  if (-not $apiReady) {
    $portOwner = Get-NetTCPConnection -State Listen -LocalPort 8000 -ErrorAction SilentlyContinue
    if ($portOwner) { throw "端口 8000 已被其他程序占用。" }

    $backendRoot = Join-Path $packageRoot "backend"
    & (Join-Path $backendRoot "scripts\start_postgres.ps1")
    $pythonExe = Join-Path $backendRoot ".venv\Scripts\python.exe"
    $apiProcess = Start-Process -FilePath $pythonExe `
      -ArgumentList @("-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "8000") `
      -WorkingDirectory $backendRoot -WindowStyle Hidden `
      -RedirectStandardOutput (Join-Path $logsRoot "data-api.stdout.log") `
      -RedirectStandardError (Join-Path $logsRoot "data-api.stderr.log") -PassThru
    Set-Content -LiteralPath $apiPidFile -Value $apiProcess.Id -Encoding ascii
    Wait-HttpReady -Uri $apiHealthUrl -Seconds 60 -Name "Minerva 数据服务"
  }

  try {
    & (Join-Path $packageRoot "services\wikijs\ensure.ps1")
  } catch {
    Write-Warning "Wiki.js 暂时不可用，知识图谱仍会使用 Minerva 数据显示。$($_.Exception.Message)"
  }

  $webPidFile = Join-Path $runtimeRoot "web.pid"
  $webReady = Test-HttpReady -Uri $webUrl
  $webOwned = (Test-RecordedProcess -PidFile $webPidFile) -or ($null -ne (Get-PackagePortOwnerId -Port 30141))
  if ($webReady -and -not $webOwned) {
    throw "端口 30141 已由当前安装包之外的服务占用，请先关闭其他 Minerva 实例。"
  }
  if (-not $webReady -and $webOwned) {
    Wait-HttpReady -Uri $webUrl -Seconds 90 -Name "Minerva Web"
    $webReady = $true
  }
  if (-not $webReady) {
    $portOwner = Get-NetTCPConnection -State Listen -LocalPort 30141 -ErrorAction SilentlyContinue
    if ($portOwner) { throw "端口 30141 已被其他程序占用。" }

    $nextEntry = Join-Path $packageRoot "node_modules\next\dist\bin\next"
    $webProcess = Start-Process -FilePath $nodeExe `
      -ArgumentList @($nextEntry, "dev", "-H", "127.0.0.1", "-p", "30141") `
      -WorkingDirectory $packageRoot -WindowStyle Hidden `
      -RedirectStandardOutput (Join-Path $logsRoot "web.stdout.log") `
      -RedirectStandardError (Join-Path $logsRoot "web.stderr.log") -PassThru
    Set-Content -LiteralPath $webPidFile -Value $webProcess.Id -Encoding ascii
    Wait-HttpReady -Uri $webUrl -Seconds 90 -Name "Minerva Web"
  }

  Write-Host "Minerva 已启动：$webUrl" -ForegroundColor Green
  Start-Process $workspaceUrl
  exit 0
} catch {
  $message = $_.Exception.Message
  $failureLog = Join-Path $logsRoot "startup-error.log"
  New-Item -ItemType Directory -Force -Path $logsRoot | Out-Null
  Add-Content -LiteralPath $failureLog -Value "[$(Get-Date -Format o)] $message"
  Write-Error $message
  exit 1
}
