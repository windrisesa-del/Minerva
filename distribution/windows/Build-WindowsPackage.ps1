param(
  [string]$Version = "0.1.0",
  [string]$OutputDirectory = "",
  [switch]$OnlineBootstrap
)

$ErrorActionPreference = "Stop"
$distributionRoot = $PSScriptRoot
$projectRoot = Split-Path -Parent (Split-Path -Parent $distributionRoot)
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $projectRoot "artifacts" }
$outputRoot = [IO.Path]::GetFullPath($OutputDirectory)
$packageName = "Minerva-Windows-v$Version"
$stagingRoot = Join-Path $outputRoot $packageName
$zipPath = Join-Path $outputRoot "$packageName.zip"

function Assert-GeneratedPath {
  param([string]$Path)
  $root = $outputRoot.TrimEnd('\')
  $full = [IO.Path]::GetFullPath($Path)
  if (-not $full.StartsWith("$root\", [StringComparison]::OrdinalIgnoreCase)) {
    throw "拒绝操作输出目录之外的路径：$full"
  }
}

function Copy-TreeSanitized {
  param([string]$RelativePath, [string[]]$ExcludedDirectories = @(), [string[]]$ExcludedFiles = @())
  $source = Join-Path $projectRoot $RelativePath
  if (-not (Test-Path -LiteralPath $source)) { return }
  $destination = Join-Path $stagingRoot $RelativePath
  New-Item -ItemType Directory -Force -Path $destination | Out-Null
  $arguments = @($source, $destination, "/E", "/R:1", "/W:1", "/NFL", "/NDL", "/NJH", "/NJS", "/NP")
  if ($ExcludedDirectories.Count) { $arguments += "/XD"; $arguments += $ExcludedDirectories }
  if ($ExcludedFiles.Count) { $arguments += "/XF"; $arguments += $ExcludedFiles }
  & robocopy.exe @arguments | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "复制 $RelativePath 失败，Robocopy 退出代码 $LASTEXITCODE" }
}

New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
Assert-GeneratedPath -Path $stagingRoot
Assert-GeneratedPath -Path $zipPath
if (Test-Path -LiteralPath $stagingRoot) { Remove-Item -LiteralPath $stagingRoot -Recurse -Force }
if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
New-Item -ItemType Directory -Force -Path $stagingRoot | Out-Null

$sourceDirectories = @("app", "bin", "components", "hooks", "lib", "public", "scripts", "vendor")
foreach ($directory in $sourceDirectories) {
  Copy-TreeSanitized -RelativePath $directory -ExcludedDirectories @("node_modules", ".next", ".git", "coverage", "__pycache__", ".pytest_cache") -ExcludedFiles @("*.log", ".env", ".env.*", "*.tsbuildinfo")
}
Copy-TreeSanitized -RelativePath "backend" -ExcludedDirectories @(".data", ".runtime", ".venv", ".uv-cache", "__pycache__", ".pytest_cache") -ExcludedFiles @("*.log", ".env", ".env.*", "*.pyc")
Copy-TreeSanitized -RelativePath "services" -ExcludedDirectories @("runtime", "__pycache__") -ExcludedFiles @("config.yml", "api-token.txt", "*.log", "*.tar.gz")
Copy-TreeSanitized -RelativePath "docs"

$topLevelFiles = @(
  "package.json", "package-lock.json", "next.config.ts", "tsconfig.json", "tailwind.config.ts",
  "postcss.config.mjs", "eslint.config.mjs", "instrumentation.ts", "proxy.ts", ".npmrc", "LICENSE",
  "README.md", "README.zh-CN.md", "README.pi-web.md", "数据库结构.txt", "Minerva_架构构思_v0.1.md"
)
foreach ($file in $topLevelFiles) {
  $source = Join-Path $projectRoot $file
  if (Test-Path -LiteralPath $source) { Copy-Item -LiteralPath $source -Destination (Join-Path $stagingRoot $file) -Force }
}

$backendEnvExample = Join-Path $projectRoot "backend\.env.example"
if (Test-Path -LiteralPath $backendEnvExample) {
  Copy-Item -LiteralPath $backendEnvExample -Destination (Join-Path $stagingRoot "backend\.env.example") -Force
}

$settingsSource = Join-Path $projectRoot ".pi\settings.json"
if (Test-Path -LiteralPath $settingsSource) {
  New-Item -ItemType Directory -Force -Path (Join-Path $stagingRoot ".pi") | Out-Null
  Copy-Item -LiteralPath $settingsSource -Destination (Join-Path $stagingRoot ".pi\settings.json") -Force
}

Copy-Item -LiteralPath (Join-Path $distributionRoot "启动 Minerva.bat") -Destination $stagingRoot
Copy-Item -LiteralPath (Join-Path $distributionRoot "停止 Minerva.bat") -Destination $stagingRoot
Copy-Item -LiteralPath (Join-Path $distributionRoot "首次使用说明.txt") -Destination $stagingRoot
Copy-Item -LiteralPath (Join-Path $distributionRoot "launcher") -Destination $stagingRoot -Recurse

$runtimeRoot = Join-Path $stagingRoot "runtime"
New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
if (-not $OnlineBootstrap) {
  $installedNode = "C:\Program Files\nodejs"
  $installedUv = Join-Path $env:USERPROFILE ".local\bin\uv.exe"
  if (Test-Path -LiteralPath (Join-Path $installedNode "node.exe")) {
    Copy-Item -LiteralPath $installedNode -Destination (Join-Path $runtimeRoot "node") -Recurse
  } else {
    Write-Warning "未找到本机 Node.js；首次启动时将自动下载。"
  }
  if (Test-Path -LiteralPath $installedUv) {
    New-Item -ItemType Directory -Force -Path (Join-Path $runtimeRoot "uv") | Out-Null
    Copy-Item -LiteralPath $installedUv -Destination (Join-Path $runtimeRoot "uv\uv.exe")
  } else {
    Write-Warning "未找到本机 uv；首次启动时将自动下载。"
  }
}

if (-not $OnlineBootstrap) {
  $installedModules = Join-Path $projectRoot "node_modules"
  if (-not (Test-Path -LiteralPath (Join-Path $installedModules "next\package.json"))) {
    throw "无法制作离线包：项目 node_modules 不完整。"
  }
  Write-Host "正在封装离线 Web 依赖……" -ForegroundColor Cyan
  $modulesArchive = Join-Path $runtimeRoot "node_modules.tar"
  & tar.exe -cf $modulesArchive -C $projectRoot node_modules
  if ($LASTEXITCODE -ne 0) { throw "Web 依赖封装失败，tar 退出代码 $LASTEXITCODE" }

  Write-Host "正在复制离线 Python/PostgreSQL 运行资源……" -ForegroundColor Cyan
  Copy-TreeSanitized -RelativePath "backend\.runtime\python" -ExcludedDirectories @(".temp")
  Copy-TreeSanitized -RelativePath "backend\.uv-cache"
  $postgresArchive = Join-Path $projectRoot "backend\.runtime\postgresql-18.6-windows-x64.zip"
  if (-not (Test-Path -LiteralPath $postgresArchive)) { throw "无法制作离线包：缺少 PostgreSQL 运行时压缩包。" }
  New-Item -ItemType Directory -Force -Path (Join-Path $stagingRoot "backend\.runtime") | Out-Null
  Copy-Item -LiteralPath $postgresArchive -Destination (Join-Path $stagingRoot "backend\.runtime\postgresql-18.6-windows-x64.zip")

  Write-Host "正在封装离线 Wiki.js 运行资源……" -ForegroundColor Cyan
  $wikiServer = Join-Path $projectRoot "services\wikijs\runtime\server\index.js"
  if (-not (Test-Path -LiteralPath $wikiServer)) { throw "无法制作离线包：缺少 Wiki.js 运行时。" }
  $wikiArchive = Join-Path $stagingRoot "services\wikijs\wiki-runtime.tar"
  & tar.exe -cf $wikiArchive -C (Join-Path $projectRoot "services\wikijs") --exclude="runtime/data" --exclude="runtime/config.yml" --exclude="runtime/wikijs.pid" --exclude="runtime/*.log" runtime
  if ($LASTEXITCODE -ne 0) { throw "Wiki.js 运行资源封装失败，tar 退出代码 $LASTEXITCODE" }

  Set-Content -LiteralPath (Join-Path $runtimeRoot "offline-bundle.txt") -Value "Minerva offline runtime bundle v$Version" -Encoding utf8
  $lockHash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $stagingRoot "package-lock.json")).Hash
  Set-Content -LiteralPath (Join-Path $runtimeRoot "npm-lock.sha256") -Value $lockHash -Encoding ascii
}

$commit = (& git -C $projectRoot rev-parse --short HEAD 2>$null)
@(
  "Minerva Windows delivery package",
  "Version: $Version",
  "Built: $(Get-Date -Format o)",
  "Source commit: $commit",
  "Source snapshot: current filesystem, including working-tree changes",
  "Contains user data or credentials: no"
) | Set-Content -LiteralPath (Join-Path $stagingRoot "BUILD_INFO.txt") -Encoding utf8

Write-Host "正在压缩交付包……" -ForegroundColor Cyan
# Use the Windows/.NET ZIP writer. BSD tar prefixes entries with "./" and its
# nearly 2 GiB store-mode archive is rejected by Explorer as an invalid folder.
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory(
  $stagingRoot,
  $zipPath,
  [IO.Compression.CompressionLevel]::Optimal,
  $false
)
Write-Host "Windows 交付包已生成：$zipPath" -ForegroundColor Green
