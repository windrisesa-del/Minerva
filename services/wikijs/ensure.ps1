$ErrorActionPreference = "Stop"

$serviceRoot = $PSScriptRoot
$runtimeRoot = Join-Path $serviceRoot "runtime"
$healthUrl = "http://127.0.0.1:3002/healthz"

try {
  $response = Invoke-WebRequest -UseBasicParsing -Uri $healthUrl -TimeoutSec 2
  if ($response.StatusCode -lt 500) {
    Write-Output "Wiki.js is already running at http://127.0.0.1:3002/."
    exit 0
  }
} catch {
  # Start the local service below.
}

& (Join-Path $serviceRoot "setup.ps1")
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw "Node.js 20 or later is required to run Wiki.js" }

$stdoutLog = Join-Path $runtimeRoot "wikijs.stdout.log"
$stderrLog = Join-Path $runtimeRoot "wikijs.stderr.log"
$process = Start-Process -FilePath $node -ArgumentList @("server") -WorkingDirectory $runtimeRoot -WindowStyle Hidden -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog -PassThru
Set-Content -LiteralPath (Join-Path $runtimeRoot "wikijs.pid") -Value $process.Id -Encoding ascii

for ($attempt = 1; $attempt -le 40; $attempt++) {
  Start-Sleep -Milliseconds 500
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $healthUrl -TimeoutSec 2
    if ($response.StatusCode -lt 500) {
      Write-Output "Wiki.js started at http://127.0.0.1:3002/."
      exit 0
    }
  } catch {
    if ($process.HasExited) { break }
  }
}

throw "Wiki.js did not become ready. Check services\wikijs\runtime\wikijs.stderr.log."
