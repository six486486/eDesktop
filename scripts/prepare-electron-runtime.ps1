$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$electronPackagePath = Join-Path $projectRoot 'node_modules\electron\package.json'
$electronDistPath = Join-Path $projectRoot 'node_modules\electron\dist'
$cachePath = Join-Path $projectRoot '.electron-dist-cache'

if (-not (Test-Path -LiteralPath $electronPackagePath)) {
  throw 'Electron is not installed. Run npm install first.'
}
if (-not (Test-Path -LiteralPath (Join-Path $electronDistPath 'electron.exe'))) {
  throw 'Electron Windows runtime is incomplete. Run npm install again.'
}

$electronPackage = Get-Content -LiteralPath $electronPackagePath -Raw | ConvertFrom-Json
$archiveName = "electron-v$($electronPackage.version)-win32-x64.zip"
$archivePath = Join-Path $cachePath $archiveName
$electronExe = Get-Item -LiteralPath (Join-Path $electronDistPath 'electron.exe')

New-Item -ItemType Directory -Path $cachePath -Force | Out-Null
if (Test-Path -LiteralPath $archivePath) {
  $archive = Get-Item -LiteralPath $archivePath
  if ($archive.Length -gt 0 -and $archive.LastWriteTimeUtc -ge $electronExe.LastWriteTimeUtc) {
    Write-Host "[electron-runtime] reuse $archiveName"
    exit 0
  }
}

$temporaryArchivePath = "$archivePath.tmp.zip"
if (Test-Path -LiteralPath $temporaryArchivePath) {
  Remove-Item -LiteralPath $temporaryArchivePath -Force
}

Compress-Archive `
  -Path (Join-Path $electronDistPath '*') `
  -DestinationPath $temporaryArchivePath `
  -CompressionLevel Optimal

Move-Item -LiteralPath $temporaryArchivePath -Destination $archivePath -Force
Write-Host "[electron-runtime] created $archiveName"
