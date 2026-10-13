# RPG Web - Battle Studio: Windows install wizard.
#   powershell -ExecutionPolicy Bypass -c "iwr -useb https://github.com/gkaragoz/rpg-web-strategy/releases/latest/download/install.ps1 | iex"
# Options (when run as a file): -Dir <folder> -Version <vX.Y.Z> -Update -Uninstall -Yes
param(
  [string]$Dir = (Join-Path $env:LOCALAPPDATA 'RPGWebStrategy'),
  [string]$Version = '',
  [switch]$Update,
  [switch]$Uninstall,
  [switch]$Yes
)
$ErrorActionPreference = 'Stop'
$Repo = 'gkaragoz/rpg-web-strategy'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Info($m) { Write-Host "  > $m" -ForegroundColor Cyan }
function Ok($m) { Write-Host "  + $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  ! $m" -ForegroundColor Yellow }
function Die($m) { Write-Host "  x $m" -ForegroundColor Red; exit 1 }
function Ask($q, $def) {
  if ($Yes) { return $def }
  $a = Read-Host "  $q [$def]"
  if ([string]::IsNullOrWhiteSpace($a)) { return $def } else { return $a }
}
function Confirm-Yes($q) {
  $a = Ask "$q (y/n)" 'y'
  return @('y', 'Y', 'yes', 'e', 'E', 'evet') -contains $a
}

Write-Host ''
Write-Host '  RPG Web - Battle Studio install wizard' -ForegroundColor White
Write-Host ''

if ($Uninstall) {
  if (-not (Test-Path $Dir)) { Die "Installation not found: $Dir" }
  if (Confirm-Yes "Delete $Dir?") {
    Remove-Item -Recurse -Force $Dir
    $lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'RPG Web.lnk'
    if (Test-Path $lnk) { Remove-Item -Force $lnk }
    Ok 'Removed.'
  } else { Info 'Cancelled.' }
  exit 0
}

# --- Node.js ---
$node = Get-Command node -ErrorAction SilentlyContinue
$needNode = $true
if ($node) {
  $major = [int](((& node -v) -replace '^v', '').Split('.')[0])
  if ($major -ge 18) { $needNode = $false; Ok "Node.js $(& node -v) found" }
}
if ($needNode) {
  Warn 'Node.js 18+ is required (for the local server).'
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if ($winget -and (Confirm-Yes 'Install Node.js LTS with winget?')) {
    & winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Die 'Node.js was installed but could not be found in this window. Open a new terminal and run the wizard again.' }
  } else {
    Die 'Please install Node.js 18+ (https://nodejs.org) and run the wizard again.'
  }
}

if (-not $Update) { $Dir = Ask 'Install folder' $Dir }
Info "Folder: $Dir"

# --- Version ---
if (-not $Version) {
  Info 'Looking up the latest version...'
  try {
    $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers @{ 'User-Agent' = 'rpg-web-installer' }
    $Version = $rel.tag_name
  } catch { Die 'Latest version not found (check your internet connection).' }
}
Ok "Version: $Version"
$verFile = Join-Path $Dir 'VERSION'
if ($Update -and (Test-Path $verFile) -and ((Get-Content $verFile -Raw).Trim() -eq $Version)) { Ok 'Already up to date.'; exit 0 }

# --- Download and extract ---
$asset = "rpg-web-strategy-$Version.zip"
$url = "https://github.com/$Repo/releases/download/$Version/$asset"
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("rpgweb-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  Info "Downloading: $asset"
  Invoke-WebRequest -Uri $url -OutFile (Join-Path $tmp $asset) -UseBasicParsing
  $app = Join-Path $Dir 'app'
  if (Test-Path $app) { Remove-Item -Recurse -Force $app }
  New-Item -ItemType Directory -Path $app -Force | Out-Null
  Expand-Archive -Path (Join-Path $tmp $asset) -DestinationPath $app -Force
  if (-not (Test-Path (Join-Path $app 'index.html'))) { Die 'Package does not have the expected contents.' }
  $srv = Join-Path $app 'server.mjs'
  if (Test-Path $srv) { Move-Item -Force $srv (Join-Path $Dir 'server.mjs') }
  $lanf = Join-Path $app 'lan.mjs'
  if (Test-Path $lanf) { Move-Item -Force $lanf (Join-Path $Dir 'lan.mjs') }
  Set-Content -Path $verFile -Value $Version -NoNewline
  Ok 'Files extracted'
} finally { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }

# --- Launcher and shortcut ---
$bat = Join-Path $Dir 'play.bat'
Set-Content -Path $bat -Encoding ASCII -Value "@echo off`r`ncd /d `"%~dp0`"`r`nnode server.mjs app --open`r`n"
$batLan = Join-Path $Dir 'play-lan.bat'
Set-Content -Path $batLan -Encoding ASCII -Value "@echo off`r`ncd /d `"%~dp0`"`r`nnode server.mjs app --open --lan`r`n"
Remove-Item -Force (Join-Path $Dir 'oyna.bat'),(Join-Path $Dir 'oyna-lan.bat') -ErrorAction SilentlyContinue  # launchers from older versions
Ok "Launcher: $bat (for the LAN lobby: $batLan)"
try {
  $desk = [Environment]::GetFolderPath('Desktop')
  $sh = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $desk 'RPG Web.lnk'))
  $sh.TargetPath = $bat
  $sh.WorkingDirectory = $Dir
  $sh.Description = 'RPG Web - Battle Studio'
  $sh.Save()
  Ok 'Desktop shortcut: RPG Web'
} catch { Warn 'Could not create the desktop shortcut.' }

Write-Host ''
Write-Host '  Installation complete!' -ForegroundColor White
Info "To start: $bat"
if (Confirm-Yes 'Start the game now?') { Start-Process -FilePath $bat -WorkingDirectory $Dir }
