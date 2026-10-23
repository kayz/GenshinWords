param([Parameter(Mandatory=$true)][string]$CacheDirectory, [switch]$Offline)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$sourceScripts = if ($Offline) { @('build-materials.mjs') } else { @('acquire-official-art.mjs','acquire-version-art.mjs','acquire-materials.mjs','build-materials.mjs') }
foreach ($scriptName in $sourceScripts) {
  & node (Join-Path $PSScriptRoot $scriptName) --cache $CacheDirectory
  if ($LASTEXITCODE -ne 0) { throw ($scriptName + ' failed; downloaded files are retained for resuming.') }
}
foreach ($scriptName in @('match-materials.mjs','check-materials.mjs')) {
  & node (Join-Path $PSScriptRoot $scriptName)
  if ($LASTEXITCODE -ne 0) { throw ($scriptName + ' failed.') }
}
