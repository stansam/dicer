=== VPS Dice Server ===

REQUIREMENTS: Node.js (https://nodejs.org) — v18 or newer recommended.

--- HOW TO RUN ---

Windows:   Double-click start.bat
Mac/Linux: Open terminal in this folder, run: ./start.sh

Or manually:
  1. npm install   (first time only)
  2. node server.js

--- URLS ---
  Game:        http://localhost:3000
  Owner panel: http://localhost:3000/owner

--- OWNER PASSWORD ---
  Default: pxcmx/fi
  To change it, set the OWNER_PASSWORD environment variable before starting:
    Windows:   set OWNER_PASSWORD=mypassword && node server.js
    Mac/Linux: OWNER_PASSWORD=mypassword node server.js
