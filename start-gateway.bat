@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo Node.js was not found. Please install Node.js 18 or newer first.
    pause
    exit /b 1
)

echo ST-ClaudeCacheGateway-Continued is starting at http://127.0.0.1:8788
echo Upstream defaults to https://api.pioneer.ai
echo.
echo SillyTavern setup:
echo   Base URL: http://127.0.0.1:8788/v1
echo   API Key:  your upstream API key
echo.
echo Keep this window open while using SillyTavern.
echo.
call npm start
pause
