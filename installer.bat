@echo off
setlocal EnableDelayedExpansion
title Beecord Installer
cd /d "%~dp0"

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Node.js was not found on your system!
    echo Please install Node.js from https://nodejs.org and run the installer again.
    echo.
    pause
    exit /b 1
)

set "SCRIPT=data\install.js"
if not exist "%SCRIPT%" if exist "install.js" set "SCRIPT=install.js"

if not "%~1"=="" (
    node "%SCRIPT%" %*
    if errorlevel 1 (
        echo.
        echo [ERROR] An error occurred during the operation.
    )
    pause
    exit /b %errorlevel%
)

:MENU
cls
echo ======================================================
echo                  BEECORD INSTALLER
echo ======================================================
echo.
echo   [1] Install / Update Beecord (All files)
echo   [2] Uninstall Beecord
echo   [3] Show logs (log.txt)
echo   [4] Exit
echo.
echo ======================================================
set "CHOICE=1"
set /p "CHOICE=Choose an option (1-4) [default 1]: "

if "%CHOICE%"=="1" (
    echo.
    node "%SCRIPT%" install
) else if "%CHOICE%"=="2" (
    echo.
    node "%SCRIPT%" uninstall
) else if "%CHOICE%"=="3" (
    echo.
    node "%SCRIPT%" log
) else if "%CHOICE%"=="4" (
    exit /b 0
) else (
    echo.
    echo [INFO] Selected default option (Install)...
    node "%SCRIPT%" install
)

echo.
pause
exit /b 0
