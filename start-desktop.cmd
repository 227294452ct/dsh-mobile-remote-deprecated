@echo off
rem DeepSeek Harness Remote - double-click launcher.
rem
rem Delegates to start-remote.ps1, which stops any previous instance, starts the
rem companion detached, registers login auto-start, and verifies the address.
rem
rem Run this from your own desktop session: the companion is a GUI app with a tray
rem icon, so it has to belong to your interactive session rather than to a script
rem or an automation host.

setlocal
set "APPDIR=%~dp0desktop"
if not exist "%APPDIR%\start-remote.ps1" (
  echo [ERROR] start-remote.ps1 not found in %APPDIR%
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%APPDIR%\start-remote.ps1" %*
if errorlevel 1 (
  echo.
  echo Launch reported an error. See the messages above.
  pause
)
endlocal
