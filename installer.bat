@echo off
setlocal EnableDelayedExpansion
title Beecord Installer
cd /d "%~dp0"

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo.
    echo [BLAD] Node.js nie zostal znaleziony!
    echo Zainstaluj Node.js ze strony https://nodejs.org i uruchom instalator ponownie.
    echo.
    pause
    exit /b 1
)

if "%~1"=="uninstall" (
    node data\install.js uninstall
    pause
    exit /b 0
)

if "%~1"=="log" (
    node data\install.js log
    pause
    exit /b 0
)

if "%~1"=="install" (
    node data\install.js install
    pause
    exit /b 0
)

cls
echo ======================================================
echo                 BEECORD INSTALLER
echo ======================================================
echo.
echo   [1] Zainstaluj / Zaktualizuj Beecord
echo   [2] Odinstaluj Beecord
echo   [3] Pokaz logi (log.txt)
echo   [4] Wyjdz
echo.
echo ======================================================
set "CHOICE=1"
set /p "CHOICE=Wybierz opcje (1-4) [domyslnie 1]: "

if "%CHOICE%"=="1" (
    echo.
    node data\install.js install
) else if "%CHOICE%"=="2" (
    echo.
    node data\install.js uninstall
) else if "%CHOICE%"=="3" (
    echo.
    node data\install.js log
) else if "%CHOICE%"=="4" (
    exit /b 0
) else (
    echo.
    echo [INFO] Wybrano domyslna opcje (Instalacja)...
    node data\install.js install
)

echo.
pause
exit /b 0
