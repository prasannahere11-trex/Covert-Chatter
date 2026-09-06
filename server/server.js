/**
 * Covert Chatter - Ephemeral WebRTC Signaling & Fullstack Server
 * 
 * Purpose:
 * 1. Serves the built React client frontend (if available in ../client/dist)
 * 2. Provides a /health endpoint for Render health checks and uptime monitoring
 * 3. Relays WebRTC connection setup data (SDP offers/answers, ICE candidates)
 *    between two peers. Holds zero message history, logs no message content, and
 *    completely purges the room and drops connections when either peer disconnects.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 8080;
const CLIENT_DIST = path.join(__dirname, '../client/dist');

// MIME types dictionary for static file serving
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
};

// HTTP Request Handler
const httpServer = http.createServer((req, res) => {
  // 1. Health check route for Render
  if (req.url === '/health' || req.url === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'covert-chatter', timestamp: Date.now() }));
    return;
  }

  // 2. Serve static frontend files if client/dist exists
  if (fs.existsSync(CLIENT_DIST)) {
    let cleanUrl = req.url.split('?')[0];
    let filePath = path.join(CLIENT_DIST, cleanUrl === '/' ? 'index.html' : cleanUrl);

    // Prevent directory traversal attacks
    if (!filePath.startsWith(CLIENT_DIST)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }

    // Check if direct file exists
    fs.stat(filePath, (err, stats) => {
      if (!err && stats.isFile()) {
        const ext = path.extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';
        const headers = { 'Content-Type': contentType };

        if (ext === '.html') {
          headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
          headers['Pragma'] = 'no-cache';
          headers['Expires'] = '0';
        } else {
          headers['Cache-Control'] = 'public, max-age=31536000, immutable';
        }

        res.writeHead(200, headers);
        fs.createReadStream(filePath).pipe(res);
      } else {
        // SPA Fallback: serve index.html for unknown routes
        const indexPath = path.join(CLIENT_DIST, 'index.html');
        if (fs.existsSync(indexPath)) {
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0',
          });
          fs.createReadStream(indexPath).pipe(res);
        } else {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not Found');
        }
      }
    });
    return;
  }

  // 3. Fallback when dist is not built yet (e.g. standalone server mode)
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    service: 'Covert Chatter WebRTC Signaling Server',
    status: 'online',
    websocket: 'ready'
  }));
});

// Create WebSocket server attached to HTTP server
const wss = new WebSocketServer({ server: httpServer });

// Ephemeral in-memory state (never persisted to disk or database)
// rooms: Map<roomCode, Set<WebSocket>>
// clientRooms: Map<WebSocket, roomCode>
const rooms = new Map();
const clientRooms = new Map();

// Helper to extract client IP from incoming WebSocket handshake HTTP request
function getClientIp(req) {
  if (!req) return '127.0.0.1';
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || '127.0.0.1';
}

// In-memory IP Rate Limiting & Failed Join Lockout state (Task 4)
// ipLimits: Map<ip, { creates: number[], joins: number[], failedJoins: number[], lockedUntil: number }>
const ipLimits = new Map();

function getIpRecord(ip) {
  let record = ipLimits.get(ip);
  if (!record) {
    record = { creates: [], joins: [], failedJoins: [], lockedUntil: 0 };
    ipLimits.set(ip, record);
  }
  return record;
}

function checkRateLimit(ip, type) {
  const now = Date.now();
  const record = getIpRecord(ip);

  // Check if IP is currently in cooldown lockout
  if (record.lockedUntil > now) {
    const remainingSec = Math.ceil((record.lockedUntil - now) / 1000);
    return { allowed: false, message: `Too many failed attempts. Temporarily locked for ${remainingSec}s.` };
  }

  if (type === 'create') {
    // Sliding window: Max 10 creates per 60 seconds
    record.creates = record.creates.filter(t => now - t < 60000);
    if (record.creates.length >= 10) {
      return { allowed: false, message: 'Room creation rate limit exceeded (max 10/min). Please wait.' };
    }
    record.creates.push(now);
    return { allowed: true };
  }

  if (type === 'join') {
    // Sliding window: Max 20 joins per 60 seconds
    record.joins = record.joins.filter(t => now - t < 60000);
    if (record.joins.length >= 20) {
      return { allowed: false, message: 'Room join rate limit exceeded (max 20/min). Please wait.' };
    }
    record.joins.push(now);
    return { allowed: true };
  }

  return { allowed: true };
}

function recordFailedJoin(ip) {
  const now = Date.now();
  const record = getIpRecord(ip);
  // Sliding window: count failures within the last 3 minutes
  record.failedJoins = record.failedJoins.filter(t => now - t < 180000);
  record.failedJoins.push(now);

  // Lockout defense: 5 failed joins within 3 minutes triggers a 5-minute lockout
  if (record.failedJoins.length >= 5) {
    record.lockedUntil = now + 300000;
    console.warn(`[Security Lockout] IP ${ip} locked out for 5 minutes due to 5 failed join attempts.`);
  }
}

function recordSuccessfulJoin(ip) {
  const record = ipLimits.get(ip);
  if (record) {
    record.failedJoins = [];
  }
}

// Periodic 10-minute sweep to prune stale IP rate limit records and prevent unbounded memory growth
setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of ipLimits.entries()) {
    record.creates = record.creates.filter(t => now - t < 60000);
    record.joins = record.joins.filter(t => now - t < 60000);
    record.failedJoins = record.failedJoins.filter(t => now - t < 180000);
    if (
      record.creates.length === 0 &&
      record.joins.length === 0 &&
      record.failedJoins.length === 0 &&
      record.lockedUntil < now
    ) {
      ipLimits.delete(ip);
    }
  }
}, 10 * 60 * 1000);

// Helper to generate a cryptographic 8-character hex room code (4.29 billion combinations)
function generateRoomCode() {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

// Clean up and immediately forget room & disconnect remaining peer
function leaveAndDestroyRoom(ws) {
  const roomCode = clientRooms.get(ws);
  if (!roomCode) return;

  const room = rooms.get(roomCode);
  if (room) {
    // Notify and disconnect the other peer
    for (const client of room) {
      clientRooms.delete(client);
      if (client !== ws && client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: 'peer-disconnected' }));
        client.close();
      }
    }
    rooms.delete(roomCode);
    console.log(`[Room] Room ${roomCode} closed and purged`);
  }
  clientRooms.delete(ws);
}

wss.on('connection', (ws, req) => {
  const clientIp = getClientIp(req);
  console.log(`[Connection] Client connected from ${clientIp}`);

  ws.on('message', (rawData) => {
    let message;
    try {
      message = JSON.parse(rawData);
    } catch {
      return; // Discard invalid non-JSON messages
    }

    // 1. Create a new room with a random 8-character cryptographic code
    if (message.type === 'create') {
      const rateCheck = checkRateLimit(clientIp, 'create');
      if (!rateCheck.allowed) {
        ws.send(JSON.stringify({ type: 'error', message: rateCheck.message }));
        return;
      }

      const roomCode = generateRoomCode();
      rooms.set(roomCode, new Set([ws]));
      clientRooms.set(ws, roomCode);
      ws.send(JSON.stringify({ type: 'created', room: roomCode }));
      console.log(`[Room] Created room: ${roomCode}`);
      return;
    }

    // 2. Join an existing room using code
    if (message.type === 'join') {
      const rateCheck = checkRateLimit(clientIp, 'join');
      if (!rateCheck.allowed) {
        ws.send(JSON.stringify({ type: 'error', message: rateCheck.message }));
        return;
      }

      const roomCode = message.room ? message.room.toUpperCase().trim() : null;
      const room = rooms.get(roomCode);

      if (!room) {
        recordFailedJoin(clientIp);
        ws.send(JSON.stringify({ type: 'error', message: 'Room not found' }));
        return;
      }

      if (room.size >= 2) {
        recordFailedJoin(clientIp);
        ws.send(JSON.stringify({ type: 'error', message: 'Room is full' }));
        return;
      }

      recordSuccessfulJoin(clientIp);

      // Add joiner to room
      room.add(ws);
      clientRooms.set(ws, roomCode);

      // Confirm join to the joiner
      ws.send(JSON.stringify({ type: 'joined', room: roomCode }));

      // Notify the initial host that a peer joined and WebRTC negotiation can begin
      for (const client of room) {
        if (client !== ws && client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ type: 'ready' }));
        }
      }
      console.log(`[Room] Peer joined room: ${roomCode}`);
      return;
    }

    // 3. WebRTC Signaling Relay (SDP offer/answer, ICE candidates)
    // Forwards directly to the other peer in the room without inspecting or logging payload
    const roomCode = clientRooms.get(ws);
    if (!roomCode) return;

    const room = rooms.get(roomCode);
    if (!room) return;

    for (const client of room) {
      if (client !== ws && client.readyState === WebSocket.OPEN) {
        client.send(rawData.toString());
      }
    }
  });

  ws.on('close', () => {
    console.log('[Connection] Client socket disconnected');
    // Grace period for mobile app switches (gallery, camera, backgrounding)
    const roomCode = clientRooms.get(ws);
    if (!roomCode) return;

    setTimeout(() => {
      const room = rooms.get(roomCode);
      if (room && room.has(ws)) {
        leaveAndDestroyRoom(ws);
      }
    }, 15000);
  });

  ws.on('error', () => {
    leaveAndDestroyRoom(ws);
  });
});

httpServer.listen(PORT, () => {
  console.log(`[Covert Chatter] Server running on port ${PORT}`);
  console.log(`[Covert Chatter] Health check available at http://localhost:${PORT}/health`);
});
