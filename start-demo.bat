@echo off
setlocal DisableDelayedExpansion
call "%~dp0start.bat" demo
exit /b %errorlevel%
