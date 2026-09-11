$ErrorActionPreference = "Stop"

$pidPath = Join-Path $PSScriptRoot "runtime\wikijs.pid"
if (-not (Test-Path -LiteralPath $pidPath)) {
  Write-Output "Wiki.js PID file was not found."
  exit 0
}

$wikiProcessId = [int](Get-Content -LiteralPath $pidPath -Raw).Trim()
$process = Get-Process -Id $wikiProcessId -ErrorAction SilentlyContinue
if ($process) {
  Stop-Process -Id $wikiProcessId
  $process.WaitForExit(10000)
}
Remove-Item -LiteralPath $pidPath -ErrorAction SilentlyContinue
Write-Output "Wiki.js stopped."
