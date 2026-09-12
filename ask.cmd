@echo off
cd /d "%~dp0"
if "%~1"=="" (
  node ask.mjs --list
  echo.
  echo Usage: ask.cmd ^<model-id^> "your question"
  echo   e.g.  ask.cmd claude-sonnet-4.6 "hello"
  echo         ask.cmd gpt-5.4 "write quicksort"
) else (
  node ask.mjs %*
)
pause
