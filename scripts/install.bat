@echo off
rem RPG Web - Savas Studyosu: Windows kurulum sihirbazi (cift tikla).
rem install.ps1 yanindaysa onu calistirir; degilse son surumden indirir.
setlocal
set "PS1=%~dp0install.ps1"
if not exist "%PS1%" (
  set "PS1=%TEMP%\rpgweb-install.ps1"
  echo Sihirbaz indiriliyor...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/gkaragoz/rpg-web-strategy/releases/latest/download/install.ps1' -OutFile '%TEMP%\rpgweb-install.ps1'"
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %*
echo.
pause
