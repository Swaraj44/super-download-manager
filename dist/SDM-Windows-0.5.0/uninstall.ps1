param([string]$InstallDir = (Join-Path $env:LOCALAPPDATA "SDM"))
$ErrorActionPreference = "Stop"
$InstallDir = [IO.Path]::GetFullPath($InstallDir).TrimEnd('\')
$Manifest = Join-Path $InstallDir "com.sdm.ffmpeg.json"

foreach ($r in "Software\Google\Chrome", "Software\Chromium", "Software\BraveSoftware\Brave-Browser", "Software\Microsoft\Edge") {
  $key = "HKCU:\$r\NativeMessagingHosts\com.sdm.ffmpeg"
  if (Test-Path -LiteralPath $key) {
    $value = (Get-Item -LiteralPath $key).GetValue("")
    if ($value -and [IO.Path]::GetFullPath($value) -eq $Manifest) {
      Remove-Item -LiteralPath $key -Recurse -Force
      Write-Host "Removed $key"
    }
  }
}

$Uninst = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\SuperDownloadManager"
if ((Test-Path -LiteralPath $Uninst) -and (Get-ItemProperty -LiteralPath $Uninst).InstallLocation -eq $InstallDir) {
  Remove-Item -LiteralPath $Uninst -Recurse -Force
}

Set-Location -LiteralPath $env:TEMP
if (Test-Path -LiteralPath (Join-Path $InstallDir "sdm.json")) {
  Remove-Item -LiteralPath $InstallDir -Recurse -Force
  Write-Host "Removed $InstallDir"
}
Write-Host "Remove the extension itself in edge://extensions (or chrome://extensions), then restart the browser."