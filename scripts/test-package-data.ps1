$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'preserve-package-data.ps1')
$testPackageRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ('..\.artifacts\package-data-test\' + [Guid]::NewGuid().ToString())))
$testPackageData = Join-Path $testPackageRoot 'out\eDesktop-win32-x64\data'
$testPackageSaved = Join-Path $testPackageRoot '.artifacts\portable-data-preserved\data'
New-Item -ItemType Directory -Path $testPackageData -Force | Out-Null
[IO.File]::WriteAllText((Join-Path $testPackageData 'private.txt'), 'personal data must survive but never ship')
$testPackageHash = (Get-FileHash -LiteralPath (Join-Path $testPackageData 'private.txt')).Hash
$testPackageFailed = $false
try { Invoke-WithPackageDataPreserved -ProjectRoot $testPackageRoot -Operation {
  if (Test-Path -LiteralPath $testPackageData) { throw 'Data was not excluded' }
  throw 'simulated packaging failure'
} } catch { if ($_.Exception.Message -ne 'simulated packaging failure') { throw }; $testPackageFailed = $true }
if (-not $testPackageFailed -or (Get-FileHash -LiteralPath (Join-Path $testPackageData 'private.txt')).Hash -ne $testPackageHash) { throw 'Failure did not restore personal data' }
Invoke-WithPackageDataPreserved -ProjectRoot $testPackageRoot -Operation {
  if (Test-Path -LiteralPath $testPackageData) { throw 'Data could enter the archive' }
  [IO.File]::WriteAllText((Join-Path $testPackageRoot 'out\eDesktop-win32-x64\eDesktop.exe'), 'release fixture')
}
# A process killed while building leaves the preserved directory outside out/.
if (-not $testPackageData.StartsWith($testPackageRoot + '\') -or -not $testPackageSaved.StartsWith($testPackageRoot + '\')) { throw 'Unexpected test paths' }
Move-Item -LiteralPath $testPackageData -Destination $testPackageSaved
Invoke-WithPackageDataPreserved -ProjectRoot $testPackageRoot -Operation { if (Test-Path -LiteralPath $testPackageData) { throw 'Recovered data could enter archive' } }
if ((Get-FileHash -LiteralPath (Join-Path $testPackageData 'private.txt')).Hash -ne $testPackageHash) { throw 'Interrupted build recovery changed personal data' }
Write-Output 'PASS packaging excludes and restores private data, including failures and interrupted builds.'
