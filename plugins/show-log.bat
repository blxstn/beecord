@echo off
title blxstncord log
if exist "%APPDATA%\blxstncord\log.txt" (
  type "%APPDATA%\blxstncord\log.txt"
) else (
  echo No log found. blxstncord was not loaded by Discord. Run install.bat again.
)
echo.
pause
