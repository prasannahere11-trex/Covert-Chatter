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
        res.writeHead(200, { 'Content-Type': contentType });
        fs.createReadStream(filePath).pipe(res);
      } else {
        // SPA Fallback: serve index.html for unknown routes
        const indexPath = path.join(CLIENT_DIST, 'index.html');
        if (fs.existsSync(indexPath)) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
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

// Helper to generate a short, readable 6-character room code (e.g. "A1B2C3")
function generateRoomCode() {
  return crypto.randomBytes(3).toString('hex').toUpperCase();
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

wss.on('connection', (ws) => {
  console.log('[Connection] Client connected');

  ws.on('message', (rawData) => {
    let message;
    try {
      message = JSON.parse(rawData);
    } catch {
      return; // Discard invalid non-JSON messages
    }

    // 1. Create a new room with a random code
    if (message.type === 'create') {
      const roomCode = generateRoomCode();
      rooms.set(roomCode, new Set([ws]));
      clientRooms.set(ws, roomCode);
      ws.send(JSON.stringify({ type: 'created', room: roomCode }));
      console.log(`[Room] Created room: ${roomCode}`);
      return;
    }

    // 2. Join an existing room using code
    if (message.type === 'join') {
      const roomCode = message.room ? message.room.toUpperCase().trim() : null;
      const room = rooms.get(roomCode);

      if (!room) {
        ws.send(JSON.stringify({ type: 'error', message: 'Room not found' }));
        return;
      }

      if (room.size >= 2) {
        ws.send(JSON.stringify({ type: 'error', message: 'Room is full' }));
        return;
      }

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
