@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
set "taskExitCode=%ERRORLEVEL%"
if not "%taskExitCode%"=="0" pause
exit /b %taskExitCode%
