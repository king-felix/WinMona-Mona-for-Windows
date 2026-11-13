@echo off
rem Double-clickable local installer for Mona 0.1.0 from this checkout.
rem It runs the same per-user installer the user guide describes:
rem   node tools\install\cli.mjs install --smoke
rem Nothing is downloaded, nothing is published, and no elevation is used.
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found on PATH. Install Node 22 or newer, then run this again.
  pause
  exit /b 4
)

echo Building Mona 0.1.0 from this checkout and installing it per user...
echo.
node tools\install\cli.mjs install --smoke
set CODE=%ERRORLEVEL%
echo.
if "%CODE%"=="0" goto ok
if "%CODE%"=="3" goto deferred
echo The install did not complete. Exit code: %CODE%. The output above says why.
echo Nothing was published and no machine-wide setting was changed.
pause
exit /b %CODE%

:deferred
echo Mona is running with work in flight, so the install was deferred rather than interrupting it.
echo Close Mona when the work is finished and run this file again, or run:
echo   node tools\install\cli.mjs install --close-running
pause
exit /b 3

:ok
echo Installed. Program: %LOCALAPPDATA%\Programs\Mona\Mona.exe
echo Starting Mona so you can try it...
start "" "%LOCALAPPDATA%\Programs\Mona\Mona.exe"
echo.
echo Uninstall any time from Apps ^& features, or with: node tools\install\cli.mjs uninstall
ping -n 3 127.0.0.1 >nul
exit /b 0
