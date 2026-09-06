/**
 * Covert Chatter — WebRTC & End-to-End Encrypted Ephemeral Manager
 * 
 * Cryptographic & Ephemeral Workflow:
 * 1. WebRTC DataChannel established over STUN.
 * 2. Shared AES-256-GCM symmetric session key derived via ECDH Diffie-Hellman:
 *    `deriveSharedSecret(myEcdhPrivateKey, peerEcdhPublicKeyJWK)`
 * 3. Outgoing messages:
 *    - Bound to tamper-proof signed expiry timestamp & burn flags (`createEphemeralPayload`)
 *    - Encrypted via AES-GCM with fresh 12-byte IV (`encryptMessage`)
 *    - Ciphertext signed with local ECDSA private key (`signMessage`)
 *    - Sent over RTCDataChannel as `{ id, iv, ciphertext, signature, timestamp }`
 * 4. Incoming messages:
 *    - Verified against sender's ECDSA public key (`verifyMessage`)
 *    - Decrypted with derived AES-GCM session key (`decryptMessage`)
 *    - Authenticated inner payload unpacked with verified expiry timestamp
 *    - Corrupted or unauthenticated messages dropped silently
 */

import { 
  deriveSharedSecret, 
  generateEphemeralAgreementKeypair, 
  exportEphemeralPublicKey, 
  signEphemeralAgreementKey, 
  verifyEphemeralAgreementKey 
} from './crypto';
import { encryptMessage, decryptMessage, signMessage, verifyMessage } from './encryption';
import { createEphemeralPayload, DEFAULT_TTL_SECONDS, BURN_ON_READ_DELAY_SECONDS } from './ephemeral';
import { sendFileStream, FileReceiver, BUFFER_LOW_THRESHOLD } from './fileTransfer';

/**
 * Construct signaling WebSocket URL dynamically from current window location.
 * Resolves to ws://localhost:5173/ws locally or wss://<ngrok-host>/ws when accessed remotely.
 */
export function getDefaultSignalingUrl() {
  const envUrl = import.meta.env.VITE_SIGNALING_URL;
  if (envUrl && typeof envUrl === 'string' && envUrl.trim()) {
    return envUrl.trim();
  }
  if (typeof window !== 'undefined' && window.location) {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}/ws`;
  }
  return 'ws://localhost:8080';
}

export const DEFAULT_SIGNALING_URL = getDefaultSignalingUrl();

/**
 * Build ICE servers configuration including STUN and optional TURN server credentials
 */
export function getIceServers() {
  const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];

  const turnUrl = import.meta.env.VITE_TURN_URL;
  const turnUsername = import.meta.env.VITE_TURN_USERNAME;
  const turnCredential = import.meta.env.VITE_TURN_CREDENTIAL;

  if (turnUrl) {
    const formattedUrl = turnUrl.startsWith('turn:') || turnUrl.startsWith('turns:')
      ? turnUrl
      : `turn:${turnUrl}`;

    const turnServer = {
      urls: formattedUrl,
    };

    if (turnUsername) turnServer.username = turnUsername;
    if (turnCredential) turnServer.credential = turnCredential;

    iceServers.push(turnServer);
  }

  return iceServers;
}

export const RTC_CONFIG = {
  get iceServers() {
    return getIceServers();
  },
};
const CONNECTION_TIMEOUT_MS = 15000;

export class PeerSession {
  /**
   * @param {object} callbacks
   * @param {function(string, object=):void} callbacks.onStatusChange - ('idle'|'waiting'|'connecting'|'connected'|'disconnected'|'error', details)
   * @param {function(object):void} callbacks.onMessageReceived - (messageData)
   * @param {function(object):void} [callbacks.onFileProgress] - (fileProgressData)
   * @param {function(string):void} callbacks.onRoomCreated - (roomCode)
   * @param {function(string):void} callbacks.onRoomJoined - (roomCode)
   * @param {object} myIdentity - Local cryptographic identity containing signingKeyPair and agreementKeyPair
   * @param {object} peerIdentity - Remote peer identity containing ecdsa and ecdh JWKs + fingerprint
   * @param {string} [signalingUrl]
   */
  constructor(callbacks, myIdentity = null, peerIdentity = null, signalingUrl = null) {
    this.callbacks = callbacks;
    this.myIdentity = myIdentity;
    this.peerIdentity = peerIdentity;
    this.signalingUrl = signalingUrl || getDefaultSignalingUrl();

    this.ws = null;
    this.pc = null;
    this.dataChannel = null;
    this.roomCode = null;
    this.isHost = false;
    this.sessionKey = null;
    this.connectionTimeout = null;
    this.fileReceiver = null;

    // Ephemeral in-memory key agreement state for forward secrecy (Task 1)
    this.ephemeralKeyPair = null;
    this.myEphemeralJWK = null;
    this.myEphemeralSignature = null;
    this.peerEphemeralJWK = null;

    // Monotonically increasing sequence counters for replay protection (Task 2)
    // Strictly scoped to the lifetime of the ephemeral session key
    this.sendSequence = 0;
    this.receiveSequence = 0;

    // Signaling Reconnection & ICE Tracking State (Task 5)
    this.signalingRetryCount = 0;
    this.currentRoomAction = null;
    this.iceGatheringTimeout = null;

    // ICE Candidate buffering: Holds candidates received before setRemoteDescription() finishes
    this.isRemoteDescriptionSet = false;
    this.queuedIceCandidates = [];
  }

  /**
   * Initialize a fresh in-memory ephemeral ECDH keypair and sign its public JWK
   * with the local long-term ECDSA private identity key.
   */
  async initEphemeralKeys() {
    try {
      this.ephemeralKeyPair = await generateEphemeralAgreementKeypair();
      this.myEphemeralJWK = await exportEphemeralPublicKey(this.ephemeralKeyPair.publicKey);
      this.sendSequence = 0;
      this.receiveSequence = 0;
      if (this.myIdentity?.signingKeyPair?.privateKey) {
        this.myEphemeralSignature = await signEphemeralAgreementKey(
          this.myIdentity.signingKeyPair.privateKey,
          this.myEphemeralJWK
        );
      }
    } catch (err) {
      console.error('[WebRTC] Failed to initialize ephemeral ECDH keys:', err);
    }
  }

  /**
   * Ensure FileReceiver instance is created and updated with current session keys
   */
  ensureFileReceiver() {
    if (!this.fileReceiver) {
      this.fileReceiver = new FileReceiver({
        sessionKey: this.sessionKey,
        peerEcdsaPublicKeyJWK: this.peerIdentity?.ecdsa,
        onFileProgress: (fileData) => {
          if (this.callbacks.onFileProgress) {
            this.callbacks.onFileProgress(fileData);
          } else {
            this.callbacks.onMessageReceived(fileData);
          }
        },
        onFileComplete: (fileData) => {
          this.callbacks.onMessageReceived(fileData);
        },
        onError: (fileId, errMsg) => {
          console.error('[WebRTC] File receive error:', fileId, errMsg);
        },
      });
    } else {
      this.fileReceiver.updateKeys(this.sessionKey, this.peerIdentity?.ecdsa);
    }
    return this.fileReceiver;
  }

  /**
   * Update or set peer identity
   */
  async setPeerIdentity(peerIdentity) {
    this.peerIdentity = peerIdentity;
    this.ensureFileReceiver();
  }

  /**
   * Initialize signaling WebSocket connection with automatic backoff retries (Task 5)
   * @returns {Promise<WebSocket>}
   */
  connectSignaling() {
    return new Promise((resolve, reject) => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        return resolve(this.ws);
      }

      if (this.ws) {
        try {
          this.ws.close();
        } catch {}
        this.ws = null;
      }

      try {
        this.ws = new WebSocket(this.signalingUrl);
      } catch (err) {
        this.handleSignalingDisconnectOrError(err);
        return reject(err);
      }

      this.ws.onopen = () => {
        this.signalingRetryCount = 0; // Reset retry counter on successful open
        resolve(this.ws);
      };

      this.ws.onerror = (err) => {
        console.warn('[Signaling] WebSocket error event:', err);
        // Let onclose handle retry logic
      };

      this.ws.onclose = () => {
        console.log('[Signaling] WebSocket connection closed');
        this.handleSignalingDisconnectOrError();
      };

      this.ws.onmessage = async (event) => {
        try {
          const data = JSON.parse(event.data);
          await this.handleSignalingMessage(data);
        } catch (err) {
          console.error('[Signaling] Error processing message:', err);
        }
      };
    });
  }

  /**
   * Handle unexpected signaling drops with 3 automatic backoff retries (1.5s, 3s, 6s) (Task 5)
   */
  handleSignalingDisconnectOrError(err) {
    // If DataChannel is already established and communicating, transient signaling drops are non-fatal
    if (this.dataChannel && this.dataChannel.readyState === 'open') {
      return;
    }

    // Only retry during active room setup (creating, waiting, joining, connecting)
    if (!this.currentRoomAction) {
      return;
    }

    const backoffs = [1500, 3000, 6000];
    if (this.signalingRetryCount < 3) {
      const delay = backoffs[this.signalingRetryCount];
      this.signalingRetryCount++;
      console.log(`[Signaling] Connection lost. Retrying in ${delay}ms (attempt ${this.signalingRetryCount}/3)...`);
      this.callbacks.onStatusChange('connecting', {
        message: `Signaling server disconnected. Reconnecting in ${delay / 1000}s (attempt ${this.signalingRetryCount}/3)...`,
      });

      setTimeout(async () => {
        if (this.currentRoomAction && (!this.dataChannel || this.dataChannel.readyState !== 'open')) {
          try {
            await this.connectSignaling();
            this.sendSignaling(this.currentRoomAction);
          } catch (retryErr) {
            console.warn('[Signaling] Reconnect attempt failed:', retryErr);
          }
        }
      }, delay);
    } else {
      this.clearConnectionTimeout();
      this.callbacks.onStatusChange('error', {
        message: 'Unable to connect to signaling server after 3 retries. Please check your network connection.',
      });
      this.cleanup(false);
    }
  }

  /**
   * Create a new ephemeral room as Host
   */
  async createRoom() {
    try {
      this.isHost = true;
      this.currentRoomAction = { type: 'create' };
      this.signalingRetryCount = 0;
      this.callbacks.onStatusChange('creating');
      await this.connectSignaling();
      this.sendSignaling(this.currentRoomAction);
    } catch (err) {
      console.error('[WebRTC] Create room error:', err);
    }
  }

  /**
   * Join an existing room as Joiner
   * @param {string} roomCode
   */
  async joinRoom(roomCode) {
    try {
      this.isHost = false;
      const cleanCode = roomCode.trim().toUpperCase();
      this.roomCode = cleanCode;
      this.currentRoomAction = { type: 'join', room: cleanCode };
      this.signalingRetryCount = 0;
      this.callbacks.onStatusChange('joining');
      await this.connectSignaling();
      this.sendSignaling(this.currentRoomAction);
    } catch (err) {
      console.error('[WebRTC] Join room error:', err);
    }
  }

  /**
   * Handle incoming WebSocket signaling events
   */
  async handleSignalingMessage(data) {
    switch (data.type) {
      case 'created':
        this.roomCode = data.room;
        this.callbacks.onRoomCreated(data.room);
        this.callbacks.onStatusChange('waiting', { room: data.room });
        break;

      case 'joined':
        this.roomCode = data.room;
        this.callbacks.onRoomJoined(data.room);
        this.callbacks.onStatusChange('connecting', { message: 'Joined room, awaiting host offer...' });
        this.startConnectionTimeout();
        break;

      case 'ready':
        // Host receives ready when joiner enters the room
        this.callbacks.onStatusChange('connecting', { message: 'Peer joined, initiating WebRTC handshake...' });
        this.startConnectionTimeout();
        await this.initiateHostOffer();
        break;

      case 'offer':
        // Joiner receives offer from host
        await this.handleRemoteOffer(data);
        break;

      case 'answer':
        // Host receives answer from joiner
        await this.handleRemoteAnswer(data);
        break;

      case 'candidate':
        // Either peer receives ICE candidate from the other
        await this.handleRemoteCandidate(data.candidate);
        break;

      case 'peer-disconnected':
        // If the WebRTC direct P2P data channel is already open and transmitting,
        // ignore transient signaling socket drops (e.g. mobile gallery/camera app switches)
        if (this.dataChannel && this.dataChannel.readyState === 'open') {
          console.log('[Signaling] Signaling peer dropped, but direct WebRTC channel remains connected.');
          break;
        }
        this.clearConnectionTimeout();
        this.callbacks.onStatusChange('disconnected', { message: 'Peer disconnected or closed the session.' });
        this.cleanup(false);
        break;

      case 'error':
        this.clearConnectionTimeout();
        this.callbacks.onStatusChange('error', { message: data.message || 'Room signaling error' });
        this.cleanup(false);
        break;

      default:
        console.warn('[Signaling] Unknown message type:', data.type);
    }
  }

  /**
   * Set up local RTCPeerConnection with ICE gathering timeout and connection failure detection (Task 5)
   */
  setupPeerConnection() {
    if (this.pc) {
      return this.pc;
    }

    this.isRemoteDescriptionSet = false;
    this.queuedIceCandidates = [];

    const pc = new RTCPeerConnection(RTC_CONFIG);
    this.pc = pc;

    // Relay local ICE candidates to peer via WebSocket
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.sendSignaling({
          type: 'candidate',
          candidate: event.candidate,
        });
      }
    };

    // Track ICE gathering completion and timeout if connection doesn't form within 10s (Task 5)
    pc.onicegatheringstatechange = () => {
      console.log('[WebRTC] ICE gathering state:', pc.iceGatheringState);
      if (pc.iceGatheringState === 'complete') {
        if (pc.connectionState !== 'connected' && (!this.dataChannel || this.dataChannel.readyState !== 'open')) {
          if (this.iceGatheringTimeout) clearTimeout(this.iceGatheringTimeout);
          this.iceGatheringTimeout = setTimeout(() => {
            if (this.pc && this.pc.connectionState !== 'connected' && (!this.dataChannel || this.dataChannel.readyState !== 'open')) {
              console.warn('[WebRTC] ICE gathering complete but P2P connection failed to establish within 10s.');
              this.clearConnectionTimeout();
              this.callbacks.onStatusChange('error', {
                message: 'P2P connection failed across NAT/firewall. A TURN relay server may be required on restricted networks.',
              });
              this.cleanup(false);
            }
          }, 10000);
        }
      }
    };

    // Monitor connection states with grace period for transient mobile app/gallery switches
    let disconnectGraceTimer = null;

    pc.onconnectionstatechange = () => {
      console.log('[WebRTC] Connection state:', pc.connectionState);
      if (pc.connectionState === 'connected') {
        this.clearConnectionTimeout();
        if (this.iceGatheringTimeout) {
          clearTimeout(this.iceGatheringTimeout);
          this.iceGatheringTimeout = null;
        }
        if (disconnectGraceTimer) {
          clearTimeout(disconnectGraceTimer);
          disconnectGraceTimer = null;
        }
      } else if (pc.connectionState === 'failed') {
        this.clearConnectionTimeout();
        if (this.iceGatheringTimeout) {
          clearTimeout(this.iceGatheringTimeout);
          this.iceGatheringTimeout = null;
        }
        if (disconnectGraceTimer) {
          clearTimeout(disconnectGraceTimer);
          disconnectGraceTimer = null;
        }
        this.callbacks.onStatusChange('error', {
          message: 'P2P connection failed across NAT/firewall. A TURN relay server may be required on restricted networks.',
        });
      } else if (pc.connectionState === 'disconnected') {
        // Transient state in WebRTC (e.g. mobile user switched to file manager or camera).
        // Wait 30 seconds for mobile ICE keepalive to resume before treating as fatal disconnect.
        console.log('[WebRTC] Connection transiently disconnected (mobile file picker active), awaiting reconnection...');
        if (!disconnectGraceTimer) {
          disconnectGraceTimer = setTimeout(() => {
            if (this.pc && (this.pc.connectionState === 'disconnected' || this.pc.connectionState === 'failed')) {
              console.warn('[WebRTC] Reconnection window elapsed. Disconnecting.');
              this.callbacks.onStatusChange('disconnected', { message: 'Peer disconnected or closed the session.' });
              this.cleanup(false);
            }
          }, 30000); // 30-second mobile file picker grace period
        }
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log('[WebRTC] ICE state:', pc.iceConnectionState);
      if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
        this.clearConnectionTimeout();
        if (this.iceGatheringTimeout) {
          clearTimeout(this.iceGatheringTimeout);
          this.iceGatheringTimeout = null;
        }
      } else if (pc.iceConnectionState === 'failed') {
        this.clearConnectionTimeout();
        if (this.iceGatheringTimeout) {
          clearTimeout(this.iceGatheringTimeout);
          this.iceGatheringTimeout = null;
        }
        this.callbacks.onStatusChange('error', {
          message: 'P2P connection failed across NAT/firewall. A TURN relay server may be required on restricted networks.',
        });
      }
    };

    return pc;
  }

  /**
   * Host Flow: Create DataChannel and initiate SDP offer
   */
  async initiateHostOffer() {
    const pc = this.setupPeerConnection();

    // Create RTCDataChannel "chat"
    const dc = pc.createDataChannel('chat', {
      ordered: true,
    });
    await this.setupDataChannel(dc);

    // Create offer
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    // Send offer to joiner with public identity attachment
    this.sendSignaling({
      type: 'offer',
      sdp: offer.sdp,
      identity: this.myIdentity?.publicJWKs ? {
        protocol: 'covert-chatter',
        version: 1,
        ecdsa: this.myIdentity.publicJWKs.ecdsa,
        ecdh: this.myIdentity.publicJWKs.ecdh,
        fingerprint: this.myIdentity.fingerprint,
      } : null,
    });
  }

  /**
   * Joiner Flow: Receive host offer, set remote description, send SDP answer
   */
  async handleRemoteOffer(offerData) {
    const pc = this.setupPeerConnection();

    // Link host identity if sent with offer
    if (offerData.identity) {
      await this.setPeerIdentity(offerData.identity);
      this.callbacks.onPeerIdentityLinked?.(offerData.identity);
    }

    // Listen for incoming DataChannel
    pc.ondatachannel = async (event) => {
      console.log('[WebRTC] Inbound DataChannel received:', event.channel.label);
      await this.setupDataChannel(event.channel);
    };

    // Set remote description (Offer)
    const remoteDesc = new RTCSessionDescription({
      type: 'offer',
      sdp: offerData.sdp,
    });
    await pc.setRemoteDescription(remoteDesc);
    this.isRemoteDescriptionSet = true;
    await this.flushQueuedIceCandidates();

    // Create and send Answer with public identity attachment
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    this.sendSignaling({
      type: 'answer',
      sdp: answer.sdp,
      identity: this.myIdentity?.publicJWKs ? {
        protocol: 'covert-chatter',
        version: 1,
        ecdsa: this.myIdentity.publicJWKs.ecdsa,
        ecdh: this.myIdentity.publicJWKs.ecdh,
        fingerprint: this.myIdentity.fingerprint,
      } : null,
    });
  }

  /**
   * Host Flow: Receive joiner answer and set remote description
   */
  async handleRemoteAnswer(answerData) {
    if (!this.pc) return;

    // Link joiner identity if sent with answer
    if (answerData.identity) {
      await this.setPeerIdentity(answerData.identity);
      this.callbacks.onPeerIdentityLinked?.(answerData.identity);
    }

    const remoteDesc = new RTCSessionDescription({
      type: 'answer',
      sdp: answerData.sdp,
    });
    await this.pc.setRemoteDescription(remoteDesc);
    this.isRemoteDescriptionSet = true;
    await this.flushQueuedIceCandidates();
  }

  /**
   * Handle incoming ICE candidates with queuing buffer support
   */
  async handleRemoteCandidate(candidateInit) {
    if (!candidateInit) return;

    // Buffer candidate if remote description has not been set yet
    if (!this.isRemoteDescriptionSet || !this.pc || !this.pc.remoteDescription) {
      this.queuedIceCandidates.push(candidateInit);
      return;
    }

    try {
      await this.pc.addIceCandidate(new RTCIceCandidate(candidateInit));
    } catch (err) {
      console.warn('[WebRTC] Error adding ICE candidate:', err);
    }
  }

  /**
   * Flush all buffered ICE candidates after setRemoteDescription completes
   */
  async flushQueuedIceCandidates() {
    if (!this.pc || this.queuedIceCandidates.length === 0) return;

    while (this.queuedIceCandidates.length > 0) {
      const candidateInit = this.queuedIceCandidates.shift();
      try {
        await this.pc.addIceCandidate(new RTCIceCandidate(candidateInit));
      } catch (err) {
        console.warn('[WebRTC] Error applying buffered ICE candidate:', err);
      }
    }
  }

  /**
   * Bind event listeners to the RTCDataChannel and derive E2EE session key
   */
  async setupDataChannel(dc) {
    this.dataChannel = dc;

    // Configure low threshold for backpressure flow control
    dc.bufferedAmountLowThreshold = BUFFER_LOW_THRESHOLD;

    // Initialize FileReceiver for encrypted streaming files
    this.ensureFileReceiver();

    dc.onopen = async () => {
      console.log('[WebRTC] DataChannel "chat" is OPEN!');
      this.clearConnectionTimeout();

      // Initialize fresh ephemeral ECDH keypair if not already created
      if (!this.ephemeralKeyPair) {
        await this.initEphemeralKeys();
      }

      // Send signed ephemeral public key + long-term identity across direct channel
      if (this.myIdentity?.publicJWKs && this.myEphemeralJWK && this.myEphemeralSignature) {
        try {
          dc.send(JSON.stringify({
            type: 'peer-identity-handshake',
            identity: {
              protocol: 'covert-chatter',
              version: 1,
              ecdsa: this.myIdentity.publicJWKs.ecdsa,
              fingerprint: this.myIdentity.fingerprint,
            },
            ephemeralEcdh: this.myEphemeralJWK,
            ephemeralSignature: this.myEphemeralSignature,
          }));
        } catch (err) {
          console.error('[WebRTC] Failed to send identity handshake:', err);
        }
      }

      this.callbacks.onStatusChange('connected', {
        room: this.roomCode,
        isHost: this.isHost,
        peerFingerprint: this.peerIdentity?.fingerprint,
        isEncrypted: !!this.sessionKey,
      });
    };

    dc.onclose = () => {
      console.log('[WebRTC] DataChannel "chat" CLOSED');
      this.callbacks.onStatusChange('disconnected', { message: 'Data channel closed by peer.' });
    };

    dc.onerror = (err) => {
      console.error('[WebRTC] DataChannel error:', err);
    };

    // Process incoming encrypted ephemeral messages and file streams
    dc.onmessage = async (event) => {
      try {
        const payload = JSON.parse(event.data);

        // 🤝 Automated Direct Identity & Signed Ephemeral Key Handshake (Forward Secrecy)
        if (payload.type === 'peer-identity-handshake' && payload.identity) {
          await this.setPeerIdentity(payload.identity);
          this.callbacks.onPeerIdentityLinked?.(payload.identity);

          if (payload.ephemeralEcdh && payload.ephemeralSignature && payload.identity.ecdsa) {
            const isSignatureValid = await verifyEphemeralAgreementKey(
              payload.identity.ecdsa,
              payload.ephemeralEcdh,
              payload.ephemeralSignature
            );

            if (!isSignatureValid) {
              console.warn('[E2EE] Ephemeral ECDH key signature verification failed! Dropping untrusted key.');
              this.callbacks.onStatusChange('error', {
                message: 'Security Alert: Peer ephemeral key signature verification failed. Connection terminated.',
              });
              this.cleanup(false);
              return;
            }

            if (!this.ephemeralKeyPair) {
              await this.initEphemeralKeys();
            }

            if (this.ephemeralKeyPair?.privateKey) {
              this.peerEphemeralJWK = payload.ephemeralEcdh;
              this.sessionKey = await deriveSharedSecret(
                this.ephemeralKeyPair.privateKey,
                payload.ephemeralEcdh
              );
              // Reset sequence counters scoped to the fresh session key
              this.sendSequence = 0;
              this.receiveSequence = 0;
              console.log('[E2EE] Derived fresh ephemeral AES-256-GCM session key successfully.');
              this.ensureFileReceiver();

              this.callbacks.onStatusChange('connected', {
                room: this.roomCode,
                isHost: this.isHost,
                peerFingerprint: this.peerIdentity?.fingerprint,
                isEncrypted: true,
              });
            }
          }
          return;
        }

        // 📁 Pass 5: File Transfer Protocol Messages
        if (payload.type === 'file-start') {
          const receiver = this.ensureFileReceiver();
          await receiver.handleFileStart(payload);
          return;
        }
        if (payload.type === 'file-chunk') {
          const receiver = this.ensureFileReceiver();
          await receiver.handleFileChunk(payload);
          return;
        }
        if (payload.type === 'file-end') {
          const receiver = this.ensureFileReceiver();
          await receiver.handleFileEnd(payload);
          return;
        }

        // ⏱️ Synchronized Disappearing Timer Control
        if (payload.type === 'ttl-change' && typeof payload.ttlSeconds === 'number') {
          this.callbacks.onTtlChanged?.(payload.ttlSeconds);
          return;
        }

        // 🔥 Synchronized Burn-on-Read Trigger
        if (payload.type === 'burn-trigger' && payload.id) {
          this.callbacks.onBurnTriggered?.(payload.id, payload.burnDelay || BURN_ON_READ_DELAY_SECONDS);
          return;
        }

        // Check if message is encrypted format { id, iv, ciphertext, signature, seq, timestamp }
        if (payload.ciphertext && payload.iv && payload.signature) {
          const incomingSeq = payload.seq;
          // Replay Protection: Reject any message where sequenceNumber <= receiveSequence
          if (typeof incomingSeq !== 'number' || incomingSeq <= this.receiveSequence) {
            console.warn(`[E2EE] Replay attack detected or invalid sequence (${incomingSeq} <= ${this.receiveSequence}). Dropping message.`);
            return; // Drop immediately
          }

          // 1. Digital Signature Verification (ECDSA P-256)
          if (this.peerIdentity?.ecdsa) {
            const isSignatureValid = await verifyMessage(
              this.peerIdentity.ecdsa,
              payload.ciphertext,
              payload.signature
            );

            if (!isSignatureValid) {
              console.warn('[E2EE] Signature verification failed! Discarding unauthorized message.');
              return; // Silently drop without leaking info to attacker
            }
          }

          // 2. Decrypt Ciphertext (AES-256-GCM) with sequence number in AAD
          if (!this.sessionKey) {
            console.warn('[E2EE] No session key available to decrypt message. Dropping payload.');
            return;
          }

          let decryptedText;
          try {
            decryptedText = await decryptMessage(
              this.sessionKey,
              payload.iv,
              payload.ciphertext,
              incomingSeq
            );
          } catch (err) {
            console.warn('[E2EE] Decryption / AAD sequence verification failed. Dropping payload:', err);
            return;
          }

          // Update receiveSequence only after verified AAD decryption
          this.receiveSequence = incomingSeq;

          // Try parsing decrypted string as inner ephemeral JSON structure
          let innerPayload;
          try {
            innerPayload = JSON.parse(decryptedText);
          } catch {
            innerPayload = {
              id: payload.id || `${Date.now()}`,
              text: decryptedText,
              sentAt: payload.timestamp || Date.now(),
              ttlSeconds: DEFAULT_TTL_SECONDS,
              burnOnRead: false,
              burnDelay: BURN_ON_READ_DELAY_SECONDS,
            };
          }

          // Calculate local expiration based on receiver's clock + TTL duration
          // This eliminates device clock skew (e.g. mobile vs laptop clock drift)
          const ttlSeconds = innerPayload.ttlSeconds || 
            (innerPayload.expiresAt && innerPayload.sentAt 
              ? Math.max(5, Math.round((innerPayload.expiresAt - innerPayload.sentAt) / 1000))
              : DEFAULT_TTL_SECONDS);

          const localExpiresAt = Date.now() + ttlSeconds * 1000;

          // Deliver authenticated plaintext & expiry metadata to UI
          this.callbacks.onMessageReceived({
            id: innerPayload.id || payload.id || `${Date.now()}`,
            text: innerPayload.text,
            sentAt: innerPayload.sentAt || payload.timestamp || Date.now(),
            ttlSeconds,
            expiresAt: localExpiresAt,
            burnOnRead: Boolean(innerPayload.burnOnRead),
            burnDelay: innerPayload.burnDelay || BURN_ON_READ_DELAY_SECONDS,
            sender: 'peer',
            timestamp: innerPayload.sentAt || payload.timestamp || Date.now(),
            isEncrypted: true,
            seq: incomingSeq,
          });
        } else {
          // Fallback unencrypted raw payload
          const rawTtl = payload.ttlSeconds || DEFAULT_TTL_SECONDS;
          this.callbacks.onMessageReceived({
            id: payload.id || `${Date.now()}`,
            text: payload.text || event.data,
            sentAt: payload.timestamp || Date.now(),
            ttlSeconds: rawTtl,
            expiresAt: Date.now() + rawTtl * 1000,
            burnOnRead: false,
            sender: 'peer',
            timestamp: payload.timestamp || Date.now(),
            isEncrypted: false,
          });
        }
      } catch (err) {
        console.warn('[E2EE] Message handling failed (corrupted or unauthenticated):', err);
      }
    };
  }

  /**
   * Encrypt, sign, and send an ephemeral chat message over the direct RTCDataChannel
   * 
   * @param {string} text - Plaintext message
   * @param {object} [options]
   * @param {number} [options.ttlSeconds=60] - Expiry TTL in seconds
   * @param {boolean} [options.burnOnRead=false] - If true, triggers 5s burn on display
   * @returns {Promise<object>} The sent message record
   */
  async sendMessage(text, options = {}) {
    if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
      throw new Error('DataChannel is not open. Cannot send message.');
    }

    // 1. Build tamper-proof signed inner payload
    const ephemeralPayload = createEphemeralPayload(text, options);
    const innerJsonString = JSON.stringify(ephemeralPayload);

    // If E2EE session key and private signing key are present, encrypt & sign
    if (this.sessionKey && this.myIdentity?.signingKeyPair?.privateKey) {
      // 2. Increment sequence number for replay protection
      this.sendSequence += 1;
      const currentSeq = this.sendSequence;

      // 3. Encrypt inner JSON with AES-GCM using unique 12-byte IV and sequence in AAD
      const { iv, ciphertext } = await encryptMessage(this.sessionKey, innerJsonString, currentSeq);

      // 4. Sign ciphertext with local ECDSA private key
      const signature = await signMessage(
        this.myIdentity.signingKeyPair.privateKey,
        ciphertext
      );

      // 5. Construct encrypted wire envelope
      const wireEnvelope = {
        id: ephemeralPayload.id,
        iv,
        ciphertext,
        signature,
        seq: currentSeq,
        timestamp: ephemeralPayload.sentAt,
      };

      // Send encrypted JSON payload across the WebRTC channel
      this.dataChannel.send(JSON.stringify(wireEnvelope));

      return {
        ...ephemeralPayload,
        sender: 'me',
        timestamp: ephemeralPayload.sentAt,
        isEncrypted: true,
        seq: currentSeq,
      };
    } else {
      // Fallback plain payload (if no peer identity attached)
      const plainEnvelope = {
        ...ephemeralPayload,
        sender: 'me',
        timestamp: ephemeralPayload.sentAt,
        isEncrypted: false,
      };

      this.dataChannel.send(JSON.stringify(plainEnvelope));
      return plainEnvelope;
    }
  }

  /**
   * Encrypt, sign, chunk, and stream an ephemeral file over the direct RTCDataChannel
   * 
   * @param {File} file - Browser File object
   * @param {object} [options] - Ephemeral options (ttlSeconds, burnOnRead)
   * @param {function(object):void} [onProgress] - Progress callback
   * @returns {Promise<object>}
   */
  async sendFile(file, options = {}, onProgress = () => {}) {
    if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
      throw new Error('DataChannel is not open. Cannot send file.');
    }
    if (!this.sessionKey || !this.myIdentity?.signingKeyPair?.privateKey) {
      throw new Error('E2EE Session Key & signing identity required to send files.');
    }

    return await sendFileStream({
      file,
      dataChannel: this.dataChannel,
      sessionKey: this.sessionKey,
      mySigningPrivateKey: this.myIdentity.signingKeyPair.privateKey,
      options,
      onProgress,
    });
  }

  /**
   * Send control event over direct RTCDataChannel
   */
  sendControl(obj) {
    if (this.dataChannel && this.dataChannel.readyState === 'open') {
      try {
        this.dataChannel.send(JSON.stringify(obj));
      } catch (err) {
        console.warn('[WebRTC] Failed to send control message:', err);
      }
    }
  }

  /**
   * Notify peer of updated disappearing messages TTL
   */
  sendTtlChange(ttlSeconds) {
    this.sendControl({ type: 'ttl-change', ttlSeconds });
  }

  /**
   * Notify peer that a burn-on-read item has been viewed and triggered
   */
  sendBurnTrigger(id, burnDelay = BURN_ON_READ_DELAY_SECONDS) {
    this.sendControl({ type: 'burn-trigger', id, burnDelay });
  }

  /**
   * Send raw JSON message over WebSocket signaling connection
   */
  sendSignaling(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  /**
   * Start 15-second connection timeout guard
   */
  startConnectionTimeout() {
    this.clearConnectionTimeout();
    this.connectionTimeout = setTimeout(() => {
      if (
        !this.dataChannel ||
        this.dataChannel.readyState !== 'open' ||
        !this.pc ||
        this.pc.connectionState !== 'connected'
      ) {
        console.warn('[WebRTC] Connection timeout reached (15s)');
        this.callbacks.onStatusChange('error', {
          message: 'Connection failed — please check your network or try again.',
        });
        this.cleanup(false);
      }
    }, CONNECTION_TIMEOUT_MS);
  }

  clearConnectionTimeout() {
    if (this.connectionTimeout) {
      clearTimeout(this.connectionTimeout);
      this.connectionTimeout = null;
    }
  }

  /**
   * Clean up and destroy all peer connection, data channel, session keys, and socket handles
   */
  cleanup(notify = true) {
    this.clearConnectionTimeout();

    if (this.dataChannel) {
      try {
        this.dataChannel.close();
      } catch {}
      this.dataChannel = null;
    }

    if (this.pc) {
      try {
        this.pc.close();
      } catch {}
      this.pc = null;
    }

    if (this.ws) {
      try {
        if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
          this.ws.close();
        }
      } catch {}
      this.ws = null;
    }

    if (this.fileReceiver) {
      try {
        this.fileReceiver.cleanup();
      } catch {}
      this.fileReceiver = null;
    }

    if (this.iceGatheringTimeout) {
      clearTimeout(this.iceGatheringTimeout);
      this.iceGatheringTimeout = null;
    }

    this.roomCode = null;
    this.isHost = false;
    this.currentRoomAction = null;
    this.signalingRetryCount = 0;
    // Release in-memory ephemeral keypair, signature, and derived session key references.
    // Note: Setting references to null allows garbage collection; JS runtime does not support forced memory scrubbing.
    this.ephemeralKeyPair = null;
    this.myEphemeralJWK = null;
    this.myEphemeralSignature = null;
    this.peerEphemeralJWK = null;
    this.sessionKey = null;
    this.isRemoteDescriptionSet = false;
    this.queuedIceCandidates = [];

    if (notify) {
      this.callbacks.onStatusChange('idle');
    }
  }

  /**
   * Check RTCPeerConnection.getStats() for the active candidate pair type (host/srflx/prflx/relay).
   * 
   * SECURITY NOTE:
   * Even in "Relayed" mode via TURN, the TURN server only sees encrypted ciphertext,
   * never plaintext — the E2EE from Pass 3 still fully applies.
   * 
   * @returns {Promise<'direct'|'relay'|'unknown'>}
   */
  async getConnectionType() {
    if (!this.pc) return 'unknown';
    try {
      const stats = await this.pc.getStats();
      let activePair = null;
      let selectedPairId = null;

      // 1. Check transport stats for selected candidate pair ID
      stats.forEach((report) => {
        if (report.type === 'transport' && report.selectedCandidatePairId) {
          selectedPairId = report.selectedCandidatePairId;
        }
      });

      if (selectedPairId && stats.has(selectedPairId)) {
        activePair = stats.get(selectedPairId);
      }

      // 2. Fallback: Search candidate pairs for nominated/selected/succeeded pairs
      if (!activePair) {
        stats.forEach((report) => {
          if (
            report.type === 'candidate-pair' &&
            (report.selected || report.nominated || report.state === 'succeeded')
          ) {
            activePair = report;
          }
        });
      }

      if (activePair) {
        const localCandidate = stats.get(activePair.localCandidateId);
        const remoteCandidate = stats.get(activePair.remoteCandidateId);

        const localType = localCandidate?.candidateType || localCandidate?.type;
        const remoteType = remoteCandidate?.candidateType || remoteCandidate?.type;

        if (localType === 'relay' || remoteType === 'relay') {
          return 'relay';
        }
        if (localType || remoteType) {
          return 'direct';
        }
      }
    } catch (err) {
      console.warn('[WebRTC] Failed to inspect connection stats:', err);
    }
    return 'unknown';
  }
}
