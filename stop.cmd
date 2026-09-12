@echo off
cd /d "%~dp0"
node stop.mjs
ping -n 6 127.0.0.1 >nul
