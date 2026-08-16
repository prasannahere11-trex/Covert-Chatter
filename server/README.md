# Covert Chatter — Signaling Server

A zero-knowledge, ephemeral WebRTC signaling server for **Covert Chatter**.

Its sole responsibility is to allow two browser peers to exchange WebRTC session descriptions (SDP offers/answers) and ICE candidates so they can establish a direct, encrypted peer-to-peer data channel.

---

## Privacy & Security Guarantees
- **No Message Storage:** Zero chat messages or personal data ever pass through or get saved on this server.
- **Strictly Ephemeral:** Room state exists in memory only. Once either peer disconnects, the room is destroyed and both sockets are closed.
- **Minimal Logging:** Console logs only display connection, disconnection, and room lifecycle events (never message payloads).

---

## Getting Started

### 1. Install Dependencies
Navigate to the `server` directory and install dependencies:
```bash
cd server
npm install
```

### 2. Run the Server
Start the server using Node.js:
```bash
node server.js
```
*(Or run `npm start`)*

By default, the server listens on **WebSocket port 8080** (`ws://localhost:8080`).  
To use a custom port, set the `PORT` environment variable:
```bash
PORT=3000 node server.js
```

---

## WebSocket Signaling Protocol

| Event / Message Sent | Payload Example | Server Action |
| --- | --- | --- |
| **Create Room** | `{"type": "create"}` | Generates 6-char room code, responds with `{"type": "created", "room": "A1B2C3"}` |
| **Join Room** | `{"type": "join", "room": "A1B2C3"}` | Adds client to room, responds with `{"type": "joined", "room": "A1B2C3"}`, notifies host with `{"type": "ready"}` |
| **Relay Offer / Answer / ICE** | `{"type": "offer", "sdp": ...}`<br>`{"type": "answer", "sdp": ...}`<br>`{"type": "candidate", "candidate": ...}` | Relays payload directly to the other peer in the room |
| **Peer Disconnect** | Socket closes | Destroys the room, drops remaining peer with `{"type": "peer-disconnected"}` |
