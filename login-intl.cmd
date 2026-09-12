@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 选择要登录的国际版站点：
echo   1 = 国际版 CLI（codebuddy.ai）
echo   2 = 国际版 WorkBuddy（workbuddy.ai）
set /p choice=输入 1 或 2 后回车：
if "%choice%"=="1" node login.mjs --site intl-cli
if "%choice%"=="2" node login.mjs --site intl-work
if not "%choice%"=="1" if not "%choice%"=="2" echo 未识别输入，已退出。
pause
