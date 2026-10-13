@echo off
rem RPG Web - Battle Studio: Windows install wizard (double-click).
rem Runs install.ps1 if it is next to this file; otherwise downloads it from the latest release.
setlocal
set "PS1=%~dp0install.ps1"
if not exist "%PS1%" (
  set "PS1=%TEMP%\rpgweb-install.ps1"
  echo Downloading the wizard...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/gkaragoz/rpg-web-strategy/releases/latest/download/install.ps1' -OutFile '%TEMP%\rpgweb-install.ps1'"
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %*
echo.
pause
