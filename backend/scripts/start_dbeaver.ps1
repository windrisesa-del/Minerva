$ErrorActionPreference = "Stop"

$backendRoot = Split-Path -Parent $PSScriptRoot
$projectRoot = Split-Path -Parent $backendRoot
$dbeaverExe = Join-Path $backendRoot ".runtime\dbeaver\app\dbeaver\dbeaver.exe"
$workspace = Join-Path $backendRoot ".data\dbeaver-workspace"
$dataSources = Join-Path $workspace "General\.dbeaver\data-sources.json"

if (-not (Test-Path -LiteralPath $dbeaverExe)) {
  throw "DBeaver runtime is missing. Expected: $dbeaverExe"
}

& (Join-Path $PSScriptRoot "start_postgres.ps1")

New-Item -ItemType Directory -Force -Path $workspace | Out-Null
$connection = "driver=postgres-jdbc|host=127.0.0.1|port=5432|database=minerva|user=minerva_manager|name=Minerva PostgreSQL|connect=true|save=true|autoCommit=false|showSystemObjects=false|showUtilityObjects=false"

Write-Host "Opening Minerva PostgreSQL in DBeaver Community..." -ForegroundColor Cyan
Write-Host "Database: minerva  User: minerva_manager  Host: 127.0.0.1:5432" -ForegroundColor DarkGray
$arguments = @("-data", "`"$workspace`"")
if (-not (Test-Path -LiteralPath $dataSources)) {
  $arguments += @("-con", "`"$connection`"")
}
Start-Process -FilePath $dbeaverExe -WorkingDirectory $projectRoot -ArgumentList $arguments
