@echo off
chcp 65001 >nul
cd /d "%~dp0"
start "WorkBuddy 反代" /min cmd /c "node server.mjs"
echo 已在最小化窗口启动 WorkBuddy 反代（如需关闭，请关闭那个窗口或用任务管理器结束 node.exe）
timeout /t 2 >nul
