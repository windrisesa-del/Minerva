$ErrorActionPreference = "Stop"

$runtimeRoot = Join-Path $PSScriptRoot "runtime"
& (Join-Path $PSScriptRoot "setup.ps1")

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw "Node.js 20 or later is required to run Wiki.js" }

Push-Location $runtimeRoot
try {
  Write-Host ""
  Write-Host "Minerva Wiki.js: http://127.0.0.1:3002/" -ForegroundColor Cyan
  Write-Host "Keep this window open. Press Ctrl+C to stop Wiki.js." -ForegroundColor DarkGray
  & $node server
} finally {
  Pop-Location
}
