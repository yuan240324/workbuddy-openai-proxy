@echo off
cd /d "%~dp0"
start "WorkBuddy proxy" /min cmd /c "node server.mjs"
echo WorkBuddy proxy started in a minimized window (127.0.0.1:8788).
echo To stop it, run stop.cmd.
ping -n 4 127.0.0.1 >nul
