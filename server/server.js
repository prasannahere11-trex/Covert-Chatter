/**
 * Whisper Drop - Ephemeral WebRTC Signaling Server
 * 
 * Purpose:
 * Relays WebRTC connection setup data (SDP offers/answers, ICE candidates)
 * between two peers. Holds zero message history, logs no message content, and
 * completely purges the room and drops connections when either peer disconnects.
 */

const { WebSocketServer, WebSocket } = require('ws');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;
const wss = new WebSocketServer({ port: PORT });

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
    console.log('[Connection] Client disconnected');
    leaveAndDestroyRoom(ws);
  });

  ws.on('error', () => {
    leaveAndDestroyRoom(ws);
  });
});

console.log(`[Whisper Drop] Signaling server running on ws://localhost:${PORT}`);
