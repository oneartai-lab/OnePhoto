@echo off
title OneArt Photo Studio
cd /d "%~dp0"

if not exist "%~dp0python\pythonw.exe" (
    echo [ERROR] Portable Python environment not found!
    echo Please make sure the "python" folder exists in the same directory as this script.
    echo.
    pause
    exit /b 1
)

start "" "%~dp0python\pythonw.exe" "%~dp0start_app.py"
