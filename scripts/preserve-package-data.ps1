function Invoke-WithPackageDataPreserved {
  param([Parameter(Mandatory = $true)][string]$ProjectRoot, [Parameter(Mandatory = $true)][scriptblock]$Operation)
  $dataProjectRoot = [IO.Path]::GetFullPath($ProjectRoot)
  $dataPackageRoot = [IO.Path]::GetFullPath((Join-Path $dataProjectRoot 'out\eDesktop-win32-x64'))
  $dataLivePath = [IO.Path]::GetFullPath((Join-Path $dataPackageRoot 'data'))
  $dataSavedPath = [IO.Path]::GetFullPath((Join-Path $dataProjectRoot '.artifacts\portable-data-preserved\data'))
  foreach ($dataCheckedPath in @($dataLivePath, $dataSavedPath)) {
    if (-not $dataCheckedPath.StartsWith(($dataProjectRoot.TrimEnd('\') + '\'), [StringComparison]::OrdinalIgnoreCase)) { throw 'Portable data path escaped the project root.' }
  }
  $dataExecutablePath = Join-Path $dataPackageRoot 'eDesktop.exe'
  if (@(Get-CimInstance Win32_Process -Filter "Name = 'eDesktop.exe'" | Where-Object { $_.ExecutablePath -ieq $dataExecutablePath }).Count) {
    throw 'eDesktop is running. Exit normally from the tray before packaging.'
  }
  # Recover a preserved directory if a previous packaging process was interrupted.
  if (Test-Path -LiteralPath $dataSavedPath) {
    if (Test-Path -LiteralPath $dataLivePath) { throw "Both portable data directories exist; neither was overwritten: $dataLivePath ; $dataSavedPath" }
    New-Item -ItemType Directory -Path $dataPackageRoot -Force | Out-Null
    Move-Item -LiteralPath $dataSavedPath -Destination $dataLivePath
  }
  $dataWasPreserved = Test-Path -LiteralPath $dataLivePath
  if ($dataWasPreserved) {
    New-Item -ItemType Directory -Path (Split-Path -Parent $dataSavedPath) -Force | Out-Null
    Move-Item -LiteralPath $dataLivePath -Destination $dataSavedPath
  }
  try { & $Operation }
  finally {
    if ($dataWasPreserved) {
      New-Item -ItemType Directory -Path $dataPackageRoot -Force | Out-Null
      if (Test-Path -LiteralPath $dataLivePath) { throw "New data appeared during packaging; preserved data is safe at: $dataSavedPath" }
      Move-Item -LiteralPath $dataSavedPath -Destination $dataLivePath
    }
  }
}
