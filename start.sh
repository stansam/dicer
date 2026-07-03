#!/bin/bash
echo "Starting VPS Dice Server..."
if ! command -v node &> /dev/null; then
    echo "ERROR: Node.js is not installed. Please install it from https://nodejs.org"
    exit 1
fi
if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    npm install
fi
echo "Server running at http://localhost:3000"
echo "Owner panel:   http://localhost:3000/owner"
echo "Press Ctrl+C to stop."
node server.js
