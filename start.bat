@echo off
setlocal DisableDelayedExpansion
cd /d "%~dp0"
if errorlevel 1 goto failed
title DOOGY Backend
set "DOOGY_DEMO_LAUNCH="
if /i "%~1"=="demo" set "DOOGY_DEMO_LAUNCH=1"
if /i "%~2"=="demo" set "DOOGY_DEMO_LAUNCH=1"
set "DOOGY_ENV_FILE=.env"
if not "%~1"=="" set "DOOGY_ENV_FILE=%~1"
if not "%~2"=="" if /i not "%~2"=="demo" if /i not "%~2"=="backup" if /i not "%~2"=="restore" if /i not "%~2"=="provision" if /i not "%~2"=="export-account" if /i not "%~2"=="privacy" if /i not "%~2"=="backup-managed" if /i not "%~2"=="backup-plan" (
  echo [ERROR] Usage: start.bat demo ^| start.bat [env-file] [demo ^| backup [file] ^| restore file new_database ^| provision serial_no ^| export-account [file] ^| privacy action [file] ^| backup-managed ^| backup-plan]
  goto failed
)

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Install Node.js 24 and reopen this launcher.
  goto failed
)
node -e "process.exit(process.versions.node.split('.')[0] === '24' ? 0 : 1)"
if errorlevel 1 (
  echo [ERROR] This project requires Node.js 24.
  goto failed
)
where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm.cmd was not found. Check the Node.js installation.
  goto failed
)

if defined DOOGY_DEMO_LAUNCH goto dependencies
if not exist "%DOOGY_ENV_FILE%" if not "%DOOGY_ENV_FILE%"==".env" (
  echo [ERROR] Requested environment file was not found.
  goto failed
)
if not exist "%DOOGY_ENV_FILE%" (
  copy ".env.example" ".env" >nul
  if errorlevel 1 goto failed
  echo [DOOGY] Created .env from .env.example.
)

:dependencies
echo [DOOGY] Syncing project dependencies...
call npm.cmd install --include=dev --prefer-offline --no-audit --no-fund
if errorlevel 1 goto failed

echo [DOOGY] Building the latest source...
call npm.cmd run build
if errorlevel 1 goto failed

if defined DOOGY_DEMO_LAUNCH goto mvp_demo
if /i "%~2"=="backup" goto backup
if /i "%~2"=="restore" goto restore
if /i "%~2"=="provision" goto provision
if /i "%~2"=="export-account" goto export_account
if /i "%~2"=="privacy" goto privacy
if /i "%~2"=="backup-managed" goto backup_managed
if /i "%~2"=="backup-plan" goto backup_plan
rem Prepare data before starting the local Web workbench, API and Worker.
node --env-file="%DOOGY_ENV_FILE%" dist/scripts/prepare-db.js
if errorlevel 1 goto failed
node --env-file="%DOOGY_ENV_FILE%" dist/scripts/start.js
if errorlevel 1 goto failed
exit /b 0

:mvp_demo
echo [DOOGY] Starting an isolated offline MVP demo. Existing environment and databases are not used.
node dist/scripts/mvp-demo.js
if errorlevel 1 goto failed
exit /b 0

:backup
node --env-file="%DOOGY_ENV_FILE%" dist/scripts/backup-postgres.js "%~3"
if errorlevel 1 goto failed
exit /b 0

:backup_managed
node --env-file="%DOOGY_ENV_FILE%" dist/scripts/managed-backup.js run
if errorlevel 1 goto failed
exit /b 0

:backup_plan
node --env-file="%DOOGY_ENV_FILE%" dist/scripts/managed-backup.js preview
if errorlevel 1 goto failed
exit /b 0

:provision
node --env-file="%DOOGY_ENV_FILE%" dist/scripts/provision.js "%~3"
if errorlevel 1 goto failed
exit /b 0

:export_account
node --env-file="%DOOGY_ENV_FILE%" dist/scripts/export-account.js "%~3"
if errorlevel 1 goto failed
exit /b 0

:privacy
rem Actions: retention-preview, retention-run, inventory-preview, inventory-run, idempotency-preview, idempotency-clean, export-log, replay-log.
node --env-file="%DOOGY_ENV_FILE%" dist/scripts/privacy-maintenance.js "%~3" "%~4"
if errorlevel 1 goto failed
exit /b 0

:restore
node --env-file="%DOOGY_ENV_FILE%" dist/scripts/restore-postgres.js "%~3" "%~4"
if errorlevel 1 goto failed
exit /b 0

:failed
echo.
echo [ERROR] DOOGY did not finish normally. Read the error above.
pause
exit /b 1
