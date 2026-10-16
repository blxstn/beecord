@echo off
title blxstncord uninstaller
cd /d "%~dp0"
taskkill /f /im Discord.exe >nul 2>nul
timeout /t 3 >nul
node install.js uninstall
pause
