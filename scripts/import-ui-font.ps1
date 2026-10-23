$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$fontDirectory = Join-Path $projectRoot 'src/renderer/src/assets/fonts'
$sourceRoot = 'https://raw.githubusercontent.com/notofonts/noto-cjk/Serif2.003/Serif'
$temporaryFont = [IO.Path]::GetTempFileName()
try {
    New-Item -ItemType Directory -Path $fontDirectory -Force | Out-Null
    Invoke-WebRequest -Uri "$sourceRoot/SubsetOTF/SC/NotoSerifSC-Medium.otf" -OutFile $temporaryFont -TimeoutSec 60
    $bytes = [IO.File]::ReadAllBytes($temporaryFont)
    if ($bytes.Length -lt 1000000 -or [Text.Encoding]::ASCII.GetString($bytes, 0, 4) -ne 'OTTO') {
        throw '字体文件格式不正确'
    }
    $hash = (Get-FileHash -LiteralPath $temporaryFont -Algorithm SHA256).Hash
    if ($hash -ne 'E4E9BEB5AAEB951E101AA8F122E2A6801EA9E48AC9F9B6BDFEEF2436B55BC8EE') { throw '字体校验值与记录的版本不一致' }
    $license = (Invoke-WebRequest -Uri "$sourceRoot/LICENSE" -TimeoutSec 30).Content
    if ($license -is [byte[]]) { $license = [Text.Encoding]::UTF8.GetString($license) }
    if (-not $license.Contains('SIL OPEN FONT LICENSE')) { throw '字体授权文件不正确' }
    [IO.File]::WriteAllBytes((Join-Path $fontDirectory 'NotoSerifSC-Medium.otf'), $bytes)
    Set-Content -LiteralPath (Join-Path $fontDirectory 'OFL.txt') -Value $license -Encoding utf8NoBOM
    Get-FileHash -LiteralPath (Join-Path $fontDirectory 'NotoSerifSC-Medium.otf') -Algorithm SHA256 | Format-List
}
finally {
    Remove-Item -LiteralPath $temporaryFont -Force
}
