param(
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA "SDM"),
  [string[]]$StoreId = @(),
  [string]$Ffmpeg = "",
  [string]$Ytdlp = "",
  [string]$OutputDir = "",
  [switch]$Quiet
)
$ErrorActionPreference = "Stop"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Info = Get-Content -Raw -LiteralPath (Join-Path $Here "sdm.json") | ConvertFrom-Json
$InstallDir = [IO.Path]::GetFullPath($InstallDir).TrimEnd('\')

$StoreId = @($StoreId | ForEach-Object { $_ -split "," } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
foreach ($s in $StoreId) {
  if ($s -notmatch '^[a-p]{32}$') { throw "Invalid extension ID: $s (32 letters a-p)" }
}

Write-Host "Installing Super Download Manager $($Info.version) into $InstallDir"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
if ([IO.Path]::GetFullPath($Here).TrimEnd('\') -ne $InstallDir) {
  foreach ($d in "extension", "native") {
    $target = Join-Path $InstallDir $d
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
    Copy-Item -LiteralPath (Join-Path $Here $d) -Destination $target -Recurse
  }
  foreach ($f in "sdm.json", "install.ps1", "uninstall.ps1", "Install.cmd", "Uninstall.cmd", "INSTALL.md") {
    Copy-Item -LiteralPath (Join-Path $Here $f) -Destination (Join-Path $InstallDir $f) -Force
  }
}

$StoreFile = Join-Path $InstallDir "store-ids.txt"
if (-not $StoreId -and (Test-Path -LiteralPath $StoreFile)) {
  $StoreId = @(Get-Content -LiteralPath $StoreFile | Where-Object { $_ -match '^[a-p]{32}$' })
}
if ($StoreId) { Set-Content -LiteralPath $StoreFile -Value $StoreId -Encoding ASCII }

function Test-Node([string]$Path) {
  if (-not $Path -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
  & $Path -e "process.exit(+process.versions.node.split('.')[0] >= 20 ? 0 : 1)" | Out-Null
  return $LASTEXITCODE -eq 0
}

$Candidates = @()
$Candidates += @(Get-Command node.exe -All -CommandType Application -ErrorAction SilentlyContinue | ForEach-Object { $_.Source })
$Candidates += "$env:ProgramFiles\nodejs\node.exe", "$env:LOCALAPPDATA\Programs\nodejs\node.exe"
if ($env:NVM_SYMLINK) { $Candidates += Join-Path $env:NVM_SYMLINK "node.exe" }
$Node = $null
foreach ($c in $Candidates) { if (Test-Node $c) { $Node = $c; break } }

if ($Node) {
  $Ids = (@($Info.id) + $StoreId) -join ","
  $NodeArgs = @((Join-Path $InstallDir "native\install.mjs"), "--extension-id", $Ids, "--browser", "all", "--data-dir", $InstallDir)
  if ($Ffmpeg) { $NodeArgs += @("--ffmpeg", $Ffmpeg) }
  if ($Ytdlp) { $NodeArgs += @("--ytdlp", $Ytdlp) }
  if ($OutputDir) { $NodeArgs += @("--output-dir", $OutputDir) }
  & $Node @NodeArgs
  if ($LASTEXITCODE -ne 0) { throw "Registering the native helper failed (exit code $LASTEXITCODE)." }
} else {
  Write-Warning "Node.js 20 or newer was not found. The extension works, but the FFmpeg / yt-dlp helper is not registered. Install Node.js (winget install OpenJS.NodeJS.LTS) and run Install.cmd again."
}

$Uninst = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\SuperDownloadManager"
New-Item -Path $Uninst -Force | Out-Null
$Props = [ordered]@{
  DisplayName = "Super Download Manager"
  DisplayVersion = [string]$Info.version
  Publisher = "Swaraj"
  InstallLocation = $InstallDir
  UninstallString = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$InstallDir\uninstall.ps1`" -InstallDir `"$InstallDir`""
}
foreach ($k in $Props.Keys) { New-ItemProperty -Path $Uninst -Name $k -Value $Props[$k] -PropertyType String -Force | Out-Null }
foreach ($k in "NoModify", "NoRepair") { New-ItemProperty -Path $Uninst -Name $k -Value 1 -PropertyType DWord -Force | Out-Null }

$Ext = Join-Path $InstallDir "extension"
Write-Host ""
Write-Host "Extension folder: $Ext"
Write-Host "Extension ID:     $($Info.id)"
Write-Host ""
Write-Host "To finish in Edge or Chrome:"
Write-Host "  1. Open edge://extensions (or chrome://extensions)."
Write-Host "  2. Turn on Developer mode."
Write-Host "  3. Click 'Load unpacked' and select the extension folder above."
Write-Host "  4. Fully close and reopen the browser so it finds the native helper."
Write-Host "If you installed SDM from Edge Add-ons or the Chrome Web Store, skip steps 1-3 and"
Write-Host "run 'Install.cmd -StoreId <store extension ID>' once so the helper accepts it."
if (-not $Quiet) {
  Set-Clipboard -Value $Ext
  Write-Host "(The extension folder path was copied to the clipboard.)"
  Start-Process explorer.exe -ArgumentList "`"$Ext`""
}