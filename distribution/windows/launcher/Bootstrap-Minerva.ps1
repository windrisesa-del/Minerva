param(
  [Parameter(Mandatory = $true)]
  [string]$PackageRoot,
  [switch]$SkipServiceSetup
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$PackageRoot = [IO.Path]::GetFullPath($PackageRoot)

$nodeVersion = "25.9.0"
$uvVersion = "0.11.20"
$runtimeRoot = Join-Path $PackageRoot "runtime"
$cacheRoot = Join-Path $runtimeRoot "downloads"
$nodeRoot = Join-Path $runtimeRoot "node"
$uvRoot = Join-Path $runtimeRoot "uv"

function Get-RemoteFile {
  param([string]$Uri, [string]$Destination)
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Destination) | Out-Null
  Write-Host "正在下载 $Uri" -ForegroundColor Cyan
  Invoke-WebRequest -UseBasicParsing -Uri $Uri -OutFile $Destination
}

function Remove-RuntimeChild {
  param([string]$Path)
  $runtimeFull = [IO.Path]::GetFullPath($runtimeRoot).TrimEnd('\')
  $targetFull = [IO.Path]::GetFullPath($Path)
  if (-not $targetFull.StartsWith("$runtimeFull\", [StringComparison]::OrdinalIgnoreCase)) {
    throw "拒绝清理 runtime 目录以外的路径：$targetFull"
  }
  if (Test-Path -LiteralPath $targetFull) {
    Remove-Item -LiteralPath $targetFull -Recurse -Force
  }
}

function Get-FileSha256 {
  param([string]$Path)
  $stream = [IO.File]::OpenRead($Path)
  try {
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
      return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace("-", "")
    } finally {
      $sha.Dispose()
    }
  } finally {
    $stream.Dispose()
  }
}

New-Item -ItemType Directory -Force -Path $cacheRoot | Out-Null
$offlineBundle = Test-Path -LiteralPath (Join-Path $runtimeRoot "offline-bundle.txt")
if ($offlineBundle) { $env:MINERVA_OFFLINE_BUNDLE = "1" }

$nodeExe = Join-Path $nodeRoot "node.exe"
if (-not (Test-Path -LiteralPath $nodeExe)) {
  $nodeArchive = Join-Path $cacheRoot "node-v$nodeVersion-win-x64.zip"
  $nodeExtract = Join-Path $runtimeRoot "node-extract"
  if (-not (Test-Path -LiteralPath $nodeArchive)) {
    Get-RemoteFile -Uri "https://nodejs.org/dist/v$nodeVersion/node-v$nodeVersion-win-x64.zip" -Destination $nodeArchive
  }
  Remove-RuntimeChild -Path $nodeExtract
  New-Item -ItemType Directory -Force -Path $nodeExtract | Out-Null
  Expand-Archive -LiteralPath $nodeArchive -DestinationPath $nodeExtract -Force
  $expandedNode = Join-Path $nodeExtract "node-v$nodeVersion-win-x64"
  if (-not (Test-Path -LiteralPath (Join-Path $expandedNode "node.exe"))) {
    throw "Node.js 压缩包结构不符合预期。"
  }
  Remove-RuntimeChild -Path $nodeRoot
  Move-Item -LiteralPath $expandedNode -Destination $nodeRoot
  Remove-RuntimeChild -Path $nodeExtract
}

$uvExe = Join-Path $uvRoot "uv.exe"
if (-not (Test-Path -LiteralPath $uvExe)) {
  $uvArchive = Join-Path $cacheRoot "uv-$uvVersion-win-x64.zip"
  if (-not (Test-Path -LiteralPath $uvArchive)) {
    Get-RemoteFile -Uri "https://github.com/astral-sh/uv/releases/download/$uvVersion/uv-x86_64-pc-windows-msvc.zip" -Destination $uvArchive
  }
  Remove-RuntimeChild -Path $uvRoot
  New-Item -ItemType Directory -Force -Path $uvRoot | Out-Null
  Expand-Archive -LiteralPath $uvArchive -DestinationPath $uvRoot -Force
  if (-not (Test-Path -LiteralPath $uvExe)) {
    throw "uv 压缩包结构不符合预期。"
  }
}

$env:PATH = "$nodeRoot;$uvRoot;$env:PATH"
$env:NPM_CONFIG_CACHE = Join-Path $runtimeRoot "npm-cache"
$npmCli = Join-Path $nodeRoot "node_modules\npm\bin\npm-cli.js"
if (-not (Test-Path -LiteralPath $npmCli)) {
  throw "便携 Node.js 中没有找到 npm。"
}

$lockPath = Join-Path $PackageRoot "package-lock.json"
$nodeModules = Join-Path $PackageRoot "node_modules"
$npmMarker = Join-Path $runtimeRoot "npm-lock.sha256"
$lockHash = Get-FileSha256 -Path $lockPath
$installedHash = if (Test-Path -LiteralPath $npmMarker) { (Get-Content -LiteralPath $npmMarker -Raw).Trim() } else { "" }

if ($offlineBundle -and -not (Test-Path -LiteralPath (Join-Path $nodeModules "next\package.json"))) {
  $modulesArchive = Join-Path $runtimeRoot "node_modules.tar"
  if (-not (Test-Path -LiteralPath $modulesArchive)) {
    throw "离线包缺少 Web 依赖档案，请重新获取完整交付包。"
  }
  Write-Host "正在展开 Minerva Web 依赖……" -ForegroundColor Cyan
  & tar.exe -xf $modulesArchive -C $PackageRoot
  if ($LASTEXITCODE -ne 0) { throw "Web 依赖展开失败，tar 退出代码 $LASTEXITCODE" }
}

if (-not (Test-Path -LiteralPath $nodeModules) -or $installedHash -ne $lockHash) {
  if ($offlineBundle) {
    throw "离线包中的 Web 依赖不完整，请重新解压完整的交付包。"
  }
  Write-Host "正在安装 Minerva Web 依赖……" -ForegroundColor Cyan
  Push-Location $PackageRoot
  try {
    & $nodeExe $npmCli ci --no-audit --no-fund --cache $env:NPM_CONFIG_CACHE
    if ($LASTEXITCODE -ne 0) { throw "npm ci 失败，退出代码 $LASTEXITCODE" }
    Set-Content -LiteralPath $npmMarker -Value $lockHash -Encoding ascii
  } finally {
    Pop-Location
  }
}

if (-not $SkipServiceSetup) {
  $backendRoot = Join-Path $PackageRoot "backend"
  $backendPython = Join-Path $backendRoot ".venv\Scripts\python.exe"
  $postgresExe = Join-Path $backendRoot ".runtime\pgsql\bin\postgres.exe"
  $backendSetupMarker = Join-Path $backendRoot ".data\setup-complete.txt"
  if (-not (Test-Path -LiteralPath $backendPython) -or -not (Test-Path -LiteralPath $postgresExe) -or -not (Test-Path -LiteralPath $backendSetupMarker)) {
    $postgresArchive = Join-Path $backendRoot ".runtime\postgresql-18.6-windows-x64.zip"
    if (-not (Test-Path -LiteralPath $postgresArchive)) {
      Get-RemoteFile -Uri "https://get.enterprisedb.com/postgresql/postgresql-18.6-3-windows-x64-binaries.zip" -Destination $postgresArchive
    }
    Write-Host "正在初始化空白 PostgreSQL 数据库和 Python 环境……" -ForegroundColor Cyan
    & (Join-Path $backendRoot "scripts\setup.ps1")
  }

  $wikiRuntime = Join-Path $PackageRoot "services\wikijs\runtime\server\index.js"
  $wikiArchive = Join-Path $PackageRoot "services\wikijs\wiki-js-windows.tar.gz"
  $wikiOfflineArchive = Join-Path $PackageRoot "services\wikijs\wiki-runtime.tar"
  if ($offlineBundle -and -not (Test-Path -LiteralPath $wikiRuntime)) {
    if (-not (Test-Path -LiteralPath $wikiOfflineArchive)) {
      throw "离线包缺少 Wiki.js 运行档案，请重新获取完整交付包。"
    }
    Write-Host "正在展开 Wiki.js 运行资源……" -ForegroundColor Cyan
    & tar.exe -xf $wikiOfflineArchive -C (Join-Path $PackageRoot "services\wikijs")
    if ($LASTEXITCODE -ne 0) { throw "Wiki.js 运行资源展开失败，tar 退出代码 $LASTEXITCODE" }
  }
  if (-not (Test-Path -LiteralPath $wikiRuntime) -and -not (Test-Path -LiteralPath $wikiArchive)) {
    Get-RemoteFile -Uri "https://github.com/Requarks/wiki/releases/download/2.5.314/wiki-js-windows.tar.gz" -Destination $wikiArchive
  }
}

Write-Host "Minerva 初始化完成。" -ForegroundColor Green
