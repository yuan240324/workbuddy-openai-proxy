@echo off
cd /d "%~dp0"
echo Which international site do you want to sign in?
echo   1 = International CLI (codebuddy.ai)
echo   2 = International WorkBuddy (workbuddy.ai)
set /p choice=Enter 1 or 2 then press Enter: 
if "%choice%"=="1" node login.mjs --site intl-cli
if "%choice%"=="2" node login.mjs --site intl-work
if not "%choice%"=="1" if not "%choice%"=="2" echo Unrecognized input, exit.
pause
