param(
  [switch]$SkipPackage
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$projectRoot = Split-Path -Parent $PSScriptRoot
$packageJsonPath = Join-Path $projectRoot 'package.json'
$packageJson = Get-Content -LiteralPath $packageJsonPath -Raw | ConvertFrom-Json
$packageDirectory = Join-Path $projectRoot 'out\eDesktop-win32-x64'
$portableDirectory = Join-Path $projectRoot 'out\portable'
$archiveName = "eDesktop-$($packageJson.version)-win-x64-portable.zip"
$archivePath = Join-Path $portableDirectory $archiveName
$checksumPath = "$archivePath.sha256"

Push-Location $projectRoot
try {
  if (-not $SkipPackage) {
    & npm.cmd run package:win
    if ($LASTEXITCODE -ne 0) {
      throw "Electron packaging failed with exit code $LASTEXITCODE."
    }
  }

  if (-not (Test-Path -LiteralPath (Join-Path $packageDirectory 'eDesktop.exe'))) {
    throw "Packaged application not found at $packageDirectory."
  }

  New-Item -ItemType Directory -Path $portableDirectory -Force | Out-Null
  $resolvedPortableDirectory = [System.IO.Path]::GetFullPath($portableDirectory)
  $currentPortableFiles = [System.Collections.Generic.HashSet[string]]::new(
    [System.StringComparer]::OrdinalIgnoreCase
  )
  [void]$currentPortableFiles.Add([System.IO.Path]::GetFullPath($archivePath))
  [void]$currentPortableFiles.Add([System.IO.Path]::GetFullPath($checksumPath))
  foreach ($existingPortable in @(Get-ChildItem -LiteralPath $portableDirectory -File | Where-Object {
    ($_.Name -like 'eDesktop-*-win-x64-portable.zip') -or
      ($_.Name -like 'eDesktop-*-win-x64-portable.zip.sha256')
  })) {
    $resolvedExisting = [System.IO.Path]::GetFullPath($existingPortable.FullName)
    if (
      ([System.IO.Path]::GetDirectoryName($resolvedExisting) -ieq $resolvedPortableDirectory) -and
      (-not $currentPortableFiles.Contains($resolvedExisting))
    ) {
      Remove-Item -LiteralPath $resolvedExisting -Force
    }
  }
  foreach ($target in @($archivePath, $checksumPath)) {
    if (Test-Path -LiteralPath $target) {
      Remove-Item -LiteralPath $target -Force
    }
  }

  Compress-Archive -Path $packageDirectory -DestinationPath $archivePath -CompressionLevel Optimal

  $archive = Get-Item -LiteralPath $archivePath
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  $archiveStream = [System.IO.File]::OpenRead($archivePath)
  try {
    $hashBytes = $sha256.ComputeHash($archiveStream)
    $hash = ([System.BitConverter]::ToString($hashBytes) -replace '-', '').ToLowerInvariant()
  }
  finally {
    $archiveStream.Dispose()
    $sha256.Dispose()
  }
  "$hash  $archiveName" | Set-Content -LiteralPath $checksumPath -Encoding ascii

  Write-Host "[portable] archive: $archivePath"
  Write-Host ("[portable] size: {0:N2} MB" -f ($archive.Length / 1MB))
  Write-Host "[portable] sha256: $hash"
}
finally {
  Pop-Location
}
