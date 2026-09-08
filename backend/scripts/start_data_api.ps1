$ErrorActionPreference = "Stop"
$backendRoot = Split-Path -Parent $PSScriptRoot
$env:UV_CACHE_DIR = Join-Path $backendRoot ".uv-cache"
$env:UV_PYTHON_INSTALL_DIR = Join-Path $backendRoot ".runtime\python"
$env:DATABASE_URL = "postgresql+psycopg://minerva@127.0.0.1:5432/minerva"
$python = Join-Path $backendRoot ".venv\Scripts\python.exe"

if (-not (Test-Path -LiteralPath $python)) {
  throw "FastAPI environment is missing. Run backend\scripts\setup.ps1 first."
}

& (Join-Path $PSScriptRoot "start_postgres.ps1")
Push-Location $backendRoot
try {
  Write-Host ""
  Write-Host "Minerva data API: http://127.0.0.1:8000/docs" -ForegroundColor Cyan
  Write-Host "Keep this window open. Press Ctrl+C to stop the API." -ForegroundColor DarkGray
  & $python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
} finally {
  Pop-Location
}
