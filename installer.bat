@echo off
setlocal EnableDelayedExpansion
title Beecord Installer
cd /d "%~dp0"

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo.
    echo [BLAD] Node.js nie zostal znaleziony w systemie!
    echo Zainstaluj Node.js ze strony https://nodejs.org i uruchom instalator ponownie.
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
        echo [BLAD] Wystapil blad podczas wykonywania operacji.
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
echo   [1] Zainstaluj / Zaktualizuj Beecord (Wszystkie pliki)
echo   [2] Odinstaluj Beecord
echo   [3] Pokaz logi (log.txt)
echo   [4] Wyjdz
echo.
echo ======================================================
set "CHOICE=1"
set /p "CHOICE=Wybierz opcje (1-4) [domyslnie 1]: "

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
    echo [INFO] Wybrano domyslna opcje (Instalacja)...
    node "%SCRIPT%" install
)

echo.
pause
exit /b 0
