param(
  [Parameter(Mandatory=$true)][string]$RequestsPath,
  [Parameter(Mandatory=$true)][string]$CacheDirectory,
  [ValidateRange(1,6)][int]$Concurrency = 4
)
$ErrorActionPreference = 'Stop'
$requests = @(Get-Content -LiteralPath $RequestsPath -Raw -Encoding utf8 | ConvertFrom-Json)
[System.IO.Directory]::CreateDirectory($CacheDirectory) | Out-Null
$webSession = [Microsoft.PowerShell.Commands.WebRequestSession]::new()
$completed = 0
$failed = 0
$requests | ForEach-Object -Parallel {
  $item = $_
  if ($item.name -notmatch '^[A-Za-z0-9_.-]+$') { throw 'Invalid cache filename' }
  $uri = [uri]$item.url
  $permitted = @('gi.yatta.moe','sg-public-api-static.hoyoverse.com','fastcdn.hoyoverse.com','webstatic.hoyoverse.com','act-webstatic.hoyoverse.com','upload-static.hoyoverse.com','bbs-api-os.hoyolab.com','upload-os-bbs.hoyolab.com')
  if ($uri.Scheme -ne 'https' -or $uri.Host -notin $permitted) { throw ('Unsupported public source: ' + $uri.Host) }
  $file = Join-Path $using:CacheDirectory $item.name
  $metaFile = $file + '.meta.json'
  $partial = $file + '.partial'
  $result = $null
  if ((Test-Path -LiteralPath $file) -and (Test-Path -LiteralPath $metaFile)) {
    try {
      $saved = Get-Content -LiteralPath $metaFile -Raw -Encoding utf8 | ConvertFrom-Json
      $actualHash = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
      if ($saved.ok -and $saved.url -eq $item.url -and $saved.sha256 -eq $actualHash) {
        $result = @{name=$item.name;ok=$true;cached=$true}
      }
    } catch { }
  }
  if (-not $result) {
    for ($attempt=1; $attempt -le 3; $attempt++) {
      try {
        Start-Sleep -Milliseconds 150
        $response = Invoke-WebRequest -Uri $uri -WebSession $using:webSession -TimeoutSec 45 -MaximumRedirection 5 -OutFile $partial -PassThru
        if (-not $item.binary) {
          $body = [System.IO.File]::ReadAllText($partial,[System.Text.Encoding]::UTF8)
          $json = $body | ConvertFrom-Json -Depth 100
          if ($item.provider -eq 'amber' -and ($json.response -ne 200 -or $null -eq $json.data)) { throw 'Project Amber returned an invalid data envelope' }
          if ($item.provider -eq 'hoyoverse' -and ($json.retcode -ne 0 -or $null -eq $json.data)) { throw 'HoYoverse returned an invalid data envelope' }
          [System.IO.File]::WriteAllText($partial,$body,[System.Text.UTF8Encoding]::new($false))
        }
        Move-Item -LiteralPath $partial -Destination $file -Force
        $result = @{name=$item.name;url=$item.url;ok=$true;cached=$false;fetched_at=[DateTime]::UtcNow.ToString('o');status=[int]$response.StatusCode;bytes=(Get-Item -LiteralPath $file).Length;sha256=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()}
        break
      } catch {
        $status = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
        $result = @{name=$item.name;url=$item.url;ok=$false;status=$status;error=$_.Exception.Message;attempts=$attempt;fetched_at=[DateTime]::UtcNow.ToString('o')}
        if ($status -in @(403,404) -or $attempt -eq 3) { break }
        Start-Sleep -Seconds ([Math]::Pow(2,$attempt))
      }
    }
    [System.IO.File]::WriteAllText($metaFile,($result | ConvertTo-Json -Depth 10 -Compress),[System.Text.UTF8Encoding]::new($false))
  }
  $result
} -ThrottleLimit $Concurrency | ForEach-Object {
  $completed++
  if (-not $_.ok) { $failed++; Write-Output ('FETCH_ERROR ' + ($_ | ConvertTo-Json -Compress)) }
  if ($completed % 50 -eq 0 -or $completed -eq $requests.Count) { Write-Output ('FETCH_PROGRESS ' + $completed + '/' + $requests.Count + ' failed=' + $failed) }
}
if ($failed -gt 0) { exit 1 }
