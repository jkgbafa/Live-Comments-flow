@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
title FLOW Live Comments - Reader
echo ============================================
echo    FLOW Live Comments - Reader
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo  Node.js is not installed on this computer.
  echo.
  echo    1^) Go to https://nodejs.org
  echo    2^) Download the LTS version, install it ^(Next, Next, Finish^).
  echo    3^) Then double-click this file again.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo  First-time setup: installing components. Runs once, may take a minute...
  call npm install
  echo.
)

if not exist "feeder-token.txt" (
  set /p TOK="  Enter the admin password (the one you use for the admin page): "
  >feeder-token.txt echo !TOK!
  echo.
)

set /p FEED_TOKEN=<feeder-token.txt
node feeder.js

echo.
echo  The reader has stopped. You can close this window.
pause
