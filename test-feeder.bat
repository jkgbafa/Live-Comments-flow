@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
title FLOW Live Comments - TEST (Sky News)
echo ================================================
echo    FLOW Live Comments - TEST  (reads Sky News)
echo ================================================
echo.
echo   This proves the reader works. While it runs, Sky News comments
echo   show up on your viewer link. Only run when you are NOT live.
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo  Node.js is not installed. Get it from https://nodejs.org ^(LTS^), then retry.
  pause
  exit /b 1
)
if not exist "node_modules" (
  echo  First-time setup: installing components ^(~1 min^)...
  call npm install
  echo.
)
if not exist "feeder-token.txt" (
  set /p TOK="  Enter the admin password (the one for the admin page): "
  >feeder-token.txt echo !TOK!
  echo.
)
set /p FEED_TOKEN=<feeder-token.txt
set "FEED_CHANNELS=https://www.youtube.com/@SkyNews"
node feeder.js
echo.
echo  Test stopped. You can close this window.
pause
