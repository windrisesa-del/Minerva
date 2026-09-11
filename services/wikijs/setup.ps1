$ErrorActionPreference = "Stop"

$serviceRoot = $PSScriptRoot
$projectRoot = Split-Path -Parent (Split-Path -Parent $serviceRoot)
$runtimeRoot = Join-Path $serviceRoot "runtime"
$archivePath = Join-Path $serviceRoot "wiki-js-windows.tar.gz"
$downloadUrl = "https://github.com/Requarks/wiki/releases/latest/download/wiki-js-windows.tar.gz"
$postgresRoot = Join-Path $projectRoot "backend\.runtime\pgsql"
$psql = Join-Path $postgresRoot "bin\psql.exe"
$createUser = Join-Path $postgresRoot "bin\createuser.exe"
$createDatabase = Join-Path $postgresRoot "bin\createdb.exe"

$postgresReady = $false
if (Test-Path -LiteralPath $psql) {
  & $psql -h 127.0.0.1 -p 5432 -U minerva -d postgres -tAc "SELECT 1" *> $null
  $postgresReady = $LASTEXITCODE -eq 0
}
if (-not $postgresReady) {
  & (Join-Path $projectRoot "backend\scripts\start_postgres.ps1")
}

if (-not (Test-Path -LiteralPath (Join-Path $runtimeRoot "server\index.js"))) {
  New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
  Write-Output "Downloading the official Wiki.js Windows runtime..."
  & curl.exe -L --fail --show-error --progress-bar -o $archivePath $downloadUrl
  if ($LASTEXITCODE -ne 0) { throw "Wiki.js download failed" }
  tar -xzf $archivePath -C $runtimeRoot
  if ($LASTEXITCODE -ne 0) { throw "Wiki.js extraction failed" }
  Remove-Item -LiteralPath $archivePath
}

$roleExists = & $psql -h 127.0.0.1 -p 5432 -U minerva -d postgres -tAc "SELECT 1 FROM pg_roles WHERE rolname='minerva_wiki'"
if (("$roleExists").Trim() -ne "1") {
  & $createUser -h 127.0.0.1 -p 5432 -U minerva --login minerva_wiki
  if ($LASTEXITCODE -ne 0) { throw "Failed to create the minerva_wiki role" }
}

$databaseExists = & $psql -h 127.0.0.1 -p 5432 -U minerva -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='minerva_wiki'"
if (("$databaseExists").Trim() -ne "1") {
  & $createDatabase -h 127.0.0.1 -p 5432 -U minerva -O minerva_wiki minerva_wiki
  if ($LASTEXITCODE -ne 0) { throw "Failed to create the minerva_wiki database" }
}

$configPath = Join-Path $serviceRoot "config.yml"
if (-not (Test-Path -LiteralPath $configPath)) {
  Copy-Item -LiteralPath (Join-Path $serviceRoot "config.example.yml") -Destination $configPath
}
Copy-Item -LiteralPath $configPath -Destination (Join-Path $runtimeRoot "config.yml") -Force

Write-Output "Wiki.js is ready to start at http://127.0.0.1:3002/."
