@echo off
title Local Music Player Server
cd /d "%~dp0"

echo ==================================================
echo   LOCAL MUSIC PLAYER IS STARTING...
echo ==================================================

where py >nul 2>&1
if %ERRORLEVEL%==0 (
    echo Opening browser and starting server via py...
    py server.py %*
    goto END
)

where python >nul 2>&1
if %ERRORLEVEL%==0 (
    echo Opening browser and starting server via python...
    python server.py %*
    goto END
)

echo [ERROR] Python not found on your system!
pause

:END
