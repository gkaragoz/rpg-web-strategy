# RPG Web - Savas Studyosu: Windows kurulum sihirbazi.
#   powershell -ExecutionPolicy Bypass -c "iwr -useb https://github.com/gkaragoz/rpg-web-strategy/releases/latest/download/install.ps1 | iex"
# Secenekler (dosya olarak calistirirken): -Dir <klasor> -Version <vX.Y.Z> -Update -Uninstall -Yes
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
  $a = Ask "$q (e/h)" 'e'
  return @('e', 'E', 'evet', 'y', 'Y', 'yes') -contains $a
}

Write-Host ''
Write-Host '  RPG Web - Savas Studyosu kurulum sihirbazi' -ForegroundColor White
Write-Host ''

if ($Uninstall) {
  if (-not (Test-Path $Dir)) { Die "Kurulum bulunamadi: $Dir" }
  if (Confirm-Yes "$Dir silinsin mi?") {
    Remove-Item -Recurse -Force $Dir
    $lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'RPG Web.lnk'
    if (Test-Path $lnk) { Remove-Item -Force $lnk }
    Ok 'Kaldirildi.'
  } else { Info 'Iptal edildi.' }
  exit 0
}

# --- Node.js ---
$node = Get-Command node -ErrorAction SilentlyContinue
$needNode = $true
if ($node) {
  $major = [int](((& node -v) -replace '^v', '').Split('.')[0])
  if ($major -ge 18) { $needNode = $false; Ok "Node.js $(& node -v) bulundu" }
}
if ($needNode) {
  Warn 'Node.js 18+ gerekli (yerel sunucu icin).'
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if ($winget -and (Confirm-Yes 'winget ile Node.js LTS kurulsun mu?')) {
    & winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Die 'Node.js kuruldu ama bu pencerede bulunamadi. Yeni bir terminal acip sihirbazi tekrar calistirin.' }
  } else {
    Die 'Lutfen Node.js 18+ kurun (https://nodejs.org) ve sihirbazi tekrar calistirin.'
  }
}

if (-not $Update) { $Dir = Ask 'Kurulum klasoru' $Dir }
Info "Klasor: $Dir"

# --- Surum ---
if (-not $Version) {
  Info 'Son surum araniyor...'
  try {
    $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers @{ 'User-Agent' = 'rpg-web-installer' }
    $Version = $rel.tag_name
  } catch { Die 'Son surum bulunamadi (internet baglantisini kontrol edin).' }
}
Ok "Surum: $Version"
$verFile = Join-Path $Dir 'VERSION'
if ($Update -and (Test-Path $verFile) -and ((Get-Content $verFile -Raw).Trim() -eq $Version)) { Ok 'Zaten guncel.'; exit 0 }

# --- Indir ve ac ---
$asset = "rpg-web-strategy-$Version.zip"
$url = "https://github.com/$Repo/releases/download/$Version/$asset"
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("rpgweb-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  Info "Indiriliyor: $asset"
  Invoke-WebRequest -Uri $url -OutFile (Join-Path $tmp $asset) -UseBasicParsing
  $app = Join-Path $Dir 'app'
  if (Test-Path $app) { Remove-Item -Recurse -Force $app }
  New-Item -ItemType Directory -Path $app -Force | Out-Null
  Expand-Archive -Path (Join-Path $tmp $asset) -DestinationPath $app -Force
  if (-not (Test-Path (Join-Path $app 'index.html'))) { Die 'Paket beklenen icerikte degil.' }
  $srv = Join-Path $app 'server.mjs'
  if (Test-Path $srv) { Move-Item -Force $srv (Join-Path $Dir 'server.mjs') }
  $lanf = Join-Path $app 'lan.mjs'
  if (Test-Path $lanf) { Move-Item -Force $lanf (Join-Path $Dir 'lan.mjs') }
  Set-Content -Path $verFile -Value $Version -NoNewline
  Ok 'Dosyalar acildi'
} finally { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }

# --- Baslatici ve kisayol ---
$bat = Join-Path $Dir 'oyna.bat'
Set-Content -Path $bat -Encoding ASCII -Value "@echo off`r`ncd /d `"%~dp0`"`r`nnode server.mjs app --open`r`n"
$batLan = Join-Path $Dir 'oyna-lan.bat'
Set-Content -Path $batLan -Encoding ASCII -Value "@echo off`r`ncd /d `"%~dp0`"`r`nnode server.mjs app --open --lan`r`n"
Ok "Baslatici: $bat (LAN lobisi icin: $batLan)"
try {
  $desk = [Environment]::GetFolderPath('Desktop')
  $sh = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $desk 'RPG Web.lnk'))
  $sh.TargetPath = $bat
  $sh.WorkingDirectory = $Dir
  $sh.Description = 'RPG Web - Savas Studyosu'
  $sh.Save()
  Ok 'Masaustu kisayolu: RPG Web'
} catch { Warn 'Masaustu kisayolu olusturulamadi.' }

Write-Host ''
Write-Host '  Kurulum tamam!' -ForegroundColor White
Info "Baslatmak icin: $bat"
if (Confirm-Yes 'Oyun simdi baslatilsin mi?') { Start-Process -FilePath $bat -WorkingDirectory $Dir }
