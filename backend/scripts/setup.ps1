$ErrorActionPreference = "Stop"

$backendRoot = Split-Path -Parent $PSScriptRoot
$runtimeRoot = Join-Path $backendRoot ".runtime"
$archivePath = Join-Path $runtimeRoot "postgresql-18.6-windows-x64.zip"
$postgresRoot = Join-Path $runtimeRoot "pgsql"
$downloadUrl = "https://get.enterprisedb.com/postgresql/postgresql-18.6-3-windows-x64-binaries.zip"

New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null

if (-not (Test-Path -LiteralPath (Join-Path $postgresRoot "bin\postgres.exe"))) {
  if (-not (Test-Path -LiteralPath $archivePath)) {
    Write-Output "Downloading PostgreSQL 18.6 Windows binaries (about 329 MiB)..."
    & curl.exe -L --fail --show-error --progress-bar -o $archivePath $downloadUrl
    if ($LASTEXITCODE -ne 0) { throw "PostgreSQL download failed" }
  }
  Write-Output "Extracting PostgreSQL runtime..."
  Expand-Archive -LiteralPath $archivePath -DestinationPath $runtimeRoot -Force
}

$env:UV_CACHE_DIR = Join-Path $backendRoot ".uv-cache"
$env:UV_PYTHON_INSTALL_DIR = Join-Path $backendRoot ".runtime\python"
Push-Location $backendRoot
try {
  uv sync
  if ($LASTEXITCODE -ne 0) { throw "uv sync failed" }
} finally {
  Pop-Location
}

& (Join-Path $PSScriptRoot "start_postgres.ps1")
Push-Location $backendRoot
try {
  uv run python -m scripts.init_db
  uv run python -m scripts.migrate_json_students
} finally {
  Pop-Location
}

Write-Output "Setup complete. Run scripts\start_data_api.ps1 to open the API at http://127.0.0.1:8000/."
