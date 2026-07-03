const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(bodyParser.json());

// Serve all static frontend assets out of the './public' folder using cross-platform path resolution
app.use(express.static(path.join(__dirname, 'public')));

// Owner password - default to pxcmx/fi but can be overridden by environment variable
const OWNER_PASSWORD = process.env.OWNER_PASSWORD || 'pxcmx/fi';

// Persist access codes to disk so they survive restarts
const CODES_FILE = path.join(__dirname, 'codes.json');
let accessCodes = {};
try {
    if (fs.existsSync(CODES_FILE)) {
        accessCodes = JSON.parse(fs.readFileSync(CODES_FILE, 'utf8'));
        // Clean up expired codes on load
        const now = Date.now();
        for (const code of Object.keys(accessCodes)) {
            if (accessCodes[code].expiresAt && now > accessCodes[code].expiresAt) {
                delete accessCodes[code];
            }
        }
    }
} catch(e) { accessCodes = {}; }

// Banned/blacklist of generated codes so they are never reused
const BANNED_FILE = path.join(__dirname, 'banned_codes.json');
let bannedCodes = new Set();
try {
    if (fs.existsSync(BANNED_FILE)) {
        const arr = JSON.parse(fs.readFileSync(BANNED_FILE, 'utf8'));
        bannedCodes = new Set(arr);
    }
} catch(e) { bannedCodes = new Set(); }

function saveBannedCodes() {
    try { fs.writeFileSync(BANNED_FILE, JSON.stringify(Array.from(bannedCodes))); } catch(e) {}
}

function saveCodes() {
    try { fs.writeFileSync(CODES_FILE, JSON.stringify(accessCodes)); } catch(e) {}
}

// Helper to generate a 16-char code with embedded duration prefix
// Format: DDDHHHMMM + 7 random chars = 16 chars total (e.g. 01D00H00MAB12XYZ)
function generateCode(durationSeconds) {
    const days = Math.floor(durationSeconds / 86400);
    const hours = Math.floor((durationSeconds % 86400) / 3600);
    const mins = Math.floor((durationSeconds % 3600) / 60);
    const pad2 = n => String(n).padStart(2, '0');
    const prefix = `${pad2(days)}D${pad2(hours)}H${pad2(mins)}M`; // 9 chars, uppercase to match login's toUpperCase()
    const randomPart = crypto.randomBytes(4).toString('hex').toUpperCase().substring(0, 7); // 7 chars
    return prefix + randomPart; // 16 chars total
}

// Logging middleware for essential incoming requests
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
});

// ----------------------------------------------------
// OWNER API ENDPOINTS
// ----------------------------------------------------

app.post('/api/owner/login', (req, res) => {
    const { password } = req.body;
    if (password === OWNER_PASSWORD) {
        console.log(`[${new Date().toISOString()}] Owner logged in successfully`);
        res.json({ success: true });
    } else {
        console.warn(`[${new Date().toISOString()}] Failed owner login attempt`);
        res.status(401).json({ success: false, message: "Invalid owner password" });
    }
});

app.post('/api/owner/generate', (req, res) => {
    const { duration } = req.body;

    if (!duration || typeof duration !== 'number') {
        return res.status(400).json({ success: false, message: "Invalid duration" });
    }

    let newCode;
    let attempts = 0;
    do {
        newCode = generateCode(duration);
        attempts++;
    } while (accessCodes[newCode] && attempts < 20);

    if (accessCodes[newCode]) {
        return res.status(500).json({ success: false, message: "Could not generate unique code, try again" });
    }

    accessCodes[newCode] = {
        duration: duration,
        expiresAt: null // Not started yet
    };
    bannedCodes.add(newCode);
    saveBannedCodes();
    saveCodes();

    console.log(`[${new Date().toISOString()}] Generated new access code: ${newCode} (Duration: ${duration}s)`);
    res.json({ success: true, code: newCode });
});

app.post('/api/owner/revoke', (req, res) => {
    const { code } = req.body;
    if (code && accessCodes[code]) {
        delete accessCodes[code];
        saveCodes();
        console.log(`[${new Date().toISOString()}] Revoked access code: ${code}`);
        res.json({ success: true });
    } else {
        res.status(404).json({ success: false, message: "Code not found" });
    }
});

app.get('/api/owner/status', (req, res) => {
    const now = Date.now();
    const statusList = [];

    for (const [code, data] of Object.entries(accessCodes)) {
        if (data.expiresAt && now > data.expiresAt) {
            // Expired code, clean it up
            delete accessCodes[code];
            continue;
        }

        let timeRemaining = data.duration;
        let active = false;

        if (data.expiresAt) {
            active = true;
            timeRemaining = Math.max(0, Math.ceil((data.expiresAt - now) / 1000));
        }

        statusList.push({
            code: code,
            active: active,
            timeRemaining: timeRemaining
        });
    }

    res.json({ success: true, codes: statusList });
});

// ----------------------------------------------------
// STREAMER WIDGET - static, no external fetching
// ----------------------------------------------------

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/owner', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'owner.html'));
});

// /api/streamers returns empty 200 so client uses its own static HTML
app.get('/api/streamers', (req, res) => {
    res.status(204).send();
});

// ----------------------------------------------------
// ROLL PROXY ENDPOINT
// Fetches a real roll from online-dice.com and returns
// the color result + verify ID so the session ID stays
// consistent per session (not regenerated per roll).
// ----------------------------------------------------

// Session store: maps sessionId -> verifyId
const sessionVerifyIds = {};

app.post('/api/roll', async (req, res) => {
    try {
        const { sessionId, num } = req.body;

        // Generate or retrieve a stable verifyId for this session
        let sessionVerifyId = null;
        if (sessionId) {
            if (!sessionVerifyIds[sessionId]) {
                // Generate a random 10-char alphanumeric ID for this session
                sessionVerifyIds[sessionId] = crypto.randomBytes(7).toString('base64url').slice(0, 10);
            }
            sessionVerifyId = sessionVerifyIds[sessionId];
        } else {
            sessionVerifyId = crypto.randomBytes(7).toString('base64url').slice(0, 10);
        }

        console.log(`[${new Date().toISOString()}] Roll: session=${sessionId}, verifyId=${sessionVerifyId}`);

        res.json({
            success: true,
            verifyId: sessionVerifyId
        });

    } catch (err) {
        console.error(`[${new Date().toISOString()}] Roll proxy error:`, err);
        res.status(500).json({ success: false, message: 'Roll proxy failed: ' + err.message });
    }
});

// ----------------------------------------------------
// PANEL API ENDPOINTS
// ----------------------------------------------------

// Panel login: validates code, returns remaining time. Works on any PC.
app.post('/api/panel/login', (req, res) => {
    let { code } = req.body;
    if (!code) return res.status(400).json({ success: false, message: "No code provided" });
    code = code.trim().toUpperCase();

    const data = accessCodes[code];
    if (!data) {
        console.warn(`[${new Date().toISOString()}] Invalid code attempt: ${code}`);
        return res.status(401).json({ success: false, message: "Invalid or expired code" });
    }

    const now = Date.now();

    // If timer is running, check expiry
    if (data.activeUntil) {
        if (now >= data.activeUntil) {
            delete accessCodes[code];
            saveCodes();
            console.log(`[${new Date().toISOString()}] Code expired and deleted: ${code}`);
            return res.status(401).json({ success: false, message: "Code has expired" });
        }
        // Timer running - pause it (store remaining time, clear activeUntil)
        // We don't auto-pause here; client drains the time while active
        const timeRemaining = Math.max(0, Math.ceil((data.activeUntil - now) / 1000));
        return res.json({ success: true, timeRemaining });
    }

    // Not yet activated - return full duration
    return res.json({ success: true, timeRemaining: data.duration });
});

// Activate: starts (or resumes) the countdown. Time is shared across all PCs.
// When a session ends (client closes panel), the remaining time is saved back via /api/panel/pause.
app.post('/api/panel/activate', (req, res) => {
    let { code } = req.body;
    if (!code) return res.status(400).json({ success: false, message: "No code provided" });
    code = code.trim().toUpperCase();

    const data = accessCodes[code];
    if (!data) return res.status(401).json({ success: false, message: "Invalid or expired code" });

    const now = Date.now();

    // If already running, return current remaining
    if (data.activeUntil) {
        if (now >= data.activeUntil) {
            delete accessCodes[code];
            saveCodes();
            return res.status(401).json({ success: false, message: "Code expired" });
        }
        const timeRemaining = Math.max(0, Math.ceil((data.activeUntil - now) / 1000));
        return res.json({ success: true, timeRemaining });
    }

    // Start countdown from saved duration
    const remaining = data.duration;
    if (remaining <= 0) {
        delete accessCodes[code];
        saveCodes();
        return res.status(401).json({ success: false, message: "Code has no time remaining" });
    }
    data.activeUntil = now + (remaining * 1000);
    saveCodes();
    console.log(`[${new Date().toISOString()}] Code activated: ${code}, expires ${new Date(data.activeUntil).toISOString()}`);
    res.json({ success: true, timeRemaining: remaining });
});

// Pause: client calls this when session ends (panel closed/disabled), saves remaining time
app.post('/api/panel/pause', (req, res) => {
    let { code, timeRemaining } = req.body;
    if (!code) return res.status(400).json({ success: false });
    code = code.trim().toUpperCase();

    const data = accessCodes[code];
    if (!data) return res.status(404).json({ success: false });

    // const remaining = Math.max(0, Math.floor(timeRemaining || 0));
    if (!data.activeUntil) {
        return res.json({ success: true, message: 'Already paused' });
    }

    let remaining = Math.max(0, Math.floor(timeRemaining || 0));
    const serverRemaining = Math.max(0, Math.ceil((data.activeUntil - Date.now()) / 1000));

    if (remaining > serverRemaining + 5) {
        remaining = serverRemaining;
    }
    data.duration = remaining;
    delete data.activeUntil;
    saveCodes();
    console.log(`[${new Date().toISOString()}] Code paused: ${code}, ${remaining}s remaining`);

    if (remaining <= 0) {
        delete accessCodes[code];
        saveCodes();
        console.log(`[${new Date().toISOString()}] Code exhausted and deleted: ${code}`);
    }
    res.json({ success: true });
});

app.post('/api/panel/logout', (req, res) => {
    res.json({ success: true });
});

// Fallback to index.html for any other route (Single Page Application routing)
app.use((req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Global Error Handling Middleware to prevent unhandled express exceptions from crashing the server
app.use((err, req, res, next) => {
    console.error(`[${new Date().toISOString()}] Unhandled server error:`, err);
    res.status(500).json({ success: false, message: "Internal server error occurred." });
});

// Process-level event handlers to prevent PM2/Node process crashes on uncaught events
process.on('unhandledRejection', (reason, promise) => {
    console.error(`[${new Date().toISOString()}] Unhandled Promise Rejection at:`, promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
    console.error(`[${new Date().toISOString()}] Uncaught Exception thrown:`, err);
});

// Listen explicitly on port 3000
app.listen(PORT, () => {
    console.log(`[${new Date().toISOString()}] VPS Dice Server successfully running in production mode on port ${PORT}`);
});
