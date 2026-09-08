param([switch]$Make)
$ErrorActionPreference = 'Stop'
$packageProjectRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'preserve-package-data.ps1')
Push-Location $packageProjectRoot
try {
  Invoke-WithPackageDataPreserved -ProjectRoot $packageProjectRoot -Operation {
    foreach ($packageStep in @('generate:icon', 'prepare:electron-runtime', 'build')) {
      & npm.cmd run $packageStep
      if ($LASTEXITCODE -ne 0) { throw "Build step failed: $packageStep ($LASTEXITCODE)" }
    }
    & npx.cmd electron-forge package --platform=win32 --arch=x64
    if ($LASTEXITCODE -ne 0) { throw "Electron packaging failed ($LASTEXITCODE)." }
    if ($Make) {
      & npx.cmd electron-forge make --skip-package --platform=win32 --arch=x64
      if ($LASTEXITCODE -ne 0) { throw "Electron installer creation failed ($LASTEXITCODE)." }
    }
  }
} finally { Pop-Location }
