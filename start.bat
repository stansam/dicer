@echo off
echo Starting VPS Dice Server...
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo ERROR: Node.js is not installed. Please install it from https://nodejs.org
    pause
    exit /b 1
)
if not exist node_modules (
    echo Installing dependencies...
    npm install
)
echo Server starting on http://localhost:3000
echo Owner panel: http://localhost:3000/owner
echo Press Ctrl+C to stop.
node server.js
pause
