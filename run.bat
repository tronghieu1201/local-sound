@echo off
title LocalSound Cloud Static Server
cd /d "%~dp0"

echo ==================================================
echo   LOCALSOUND CLOUD STATIC SERVER IS STARTING...
echo ==================================================

where py >nul 2>&1
if %ERRORLEVEL%==0 (
    echo Starting static server at http://localhost:8000 ...
    py -m http.server 8000
    goto END
)

where python >nul 2>&1
if %ERRORLEVEL%==0 (
    echo Starting static server at http://localhost:8000 ...
    python -m http.server 8000
    goto END
)

echo [ERROR] Python not found on your system!
pause

:END
