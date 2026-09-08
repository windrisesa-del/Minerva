$ErrorActionPreference = "Stop"

$backendRoot = Split-Path -Parent $PSScriptRoot
$postgresRoot = Join-Path $backendRoot ".runtime\pgsql"
$dataRoot = Join-Path $backendRoot ".data\postgres"
$logRoot = Join-Path $backendRoot ".data\logs"
$binRoot = Join-Path $postgresRoot "bin"

if (-not (Test-Path -LiteralPath (Join-Path $binRoot "postgres.exe"))) {
  throw "PostgreSQL runtime not found. Run scripts\setup.ps1 first."
}

New-Item -ItemType Directory -Force -Path $logRoot | Out-Null

if (-not (Test-Path -LiteralPath (Join-Path $dataRoot "PG_VERSION"))) {
  & (Join-Path $binRoot "initdb.exe") -D $dataRoot -U minerva --encoding=UTF8 --locale=C --auth-local=trust --auth-host=trust
  if ($LASTEXITCODE -ne 0) { throw "initdb failed with exit code $LASTEXITCODE" }
}

& (Join-Path $binRoot "pg_ctl.exe") -D $dataRoot status *> $null
if ($LASTEXITCODE -ne 0) {
  & (Join-Path $binRoot "pg_ctl.exe") -D $dataRoot -l (Join-Path $logRoot "postgres.log") -o "-h 127.0.0.1 -p 5432" start
  if ($LASTEXITCODE -ne 0) { throw "PostgreSQL failed to start" }
}

$psql = Join-Path $binRoot "psql.exe"
$probeSucceeded = $false
$databaseExists = ""
for ($attempt = 1; $attempt -le 10; $attempt++) {
  $probeOutput = @(& $psql -h 127.0.0.1 -p 5432 -U minerva -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='minerva'" 2>&1)
  if ($LASTEXITCODE -eq 0) {
    $probeSucceeded = $true
    $databaseExists = [string]($probeOutput | ForEach-Object { $_.ToString().Trim() } | Where-Object { $_ } | Select-Object -First 1)
    break
  }
  Start-Sleep -Milliseconds 300
}
if (-not $probeSucceeded) {
  throw "PostgreSQL started but did not accept a psql health check"
}
if ($databaseExists -ne "1") {
  & (Join-Path $binRoot "createdb.exe") -h 127.0.0.1 -p 5432 -U minerva minerva
  if ($LASTEXITCODE -ne 0) { throw "Failed to create the minerva database" }
}

Write-Output "PostgreSQL is ready at 127.0.0.1:5432 (database: minerva)."
