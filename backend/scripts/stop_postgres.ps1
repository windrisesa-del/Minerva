$ErrorActionPreference = "Stop"
$backendRoot = Split-Path -Parent $PSScriptRoot
$postgresRoot = Join-Path $backendRoot ".runtime\pgsql"
$dataRoot = Join-Path $backendRoot ".data\postgres"
$pgCtl = Join-Path $postgresRoot "bin\pg_ctl.exe"

if ((Test-Path -LiteralPath $pgCtl) -and (Test-Path -LiteralPath (Join-Path $dataRoot "PG_VERSION"))) {
  & $pgCtl -D $dataRoot stop -m fast
} else {
  Write-Output "No project PostgreSQL instance is initialized."
}
