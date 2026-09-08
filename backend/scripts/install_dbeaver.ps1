$ErrorActionPreference = "Stop"

$backendRoot = Split-Path -Parent $PSScriptRoot
$runtimeRoot = Join-Path $backendRoot ".runtime\dbeaver"
$archive = Join-Path $runtimeRoot "dbeaver-ce-26.2.0-windows-x86_64.zip"
$appRoot = Join-Path $runtimeRoot "app"
$downloadUrl = "https://dbeaver.io/files/26.2.0/dbeaver-ce-26.2.0-windows-x86_64.zip"
$expectedSha256 = "a2429b50e3e5ab0b5aeee4abea5bbbdae1968173996488fd592f43781058baca"

New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
Invoke-WebRequest -Uri $downloadUrl -OutFile $archive
$actualSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLowerInvariant()
if ($actualSha256 -ne $expectedSha256) {
  throw "DBeaver archive checksum mismatch. Expected $expectedSha256, got $actualSha256."
}
if (Test-Path -LiteralPath $appRoot) {
  throw "DBeaver app directory already exists: $appRoot"
}
Expand-Archive -LiteralPath $archive -DestinationPath $appRoot
Write-Output "DBeaver Community 26.2.0 installed at $appRoot"
