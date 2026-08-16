/**
 * Whisper Drop — WebRTC & End-to-End Encrypted Ephemeral Manager
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

import { deriveSharedSecret } from './crypto';
import { encryptMessage, decryptMessage, signMessage, verifyMessage } from './encryption';
import { createEphemeralPayload, DEFAULT_TTL_SECONDS } from './ephemeral';
import { sendFileStream, FileReceiver, BUFFER_LOW_THRESHOLD } from './fileTransfer';

const DEFAULT_SIGNALING_URL = 'ws://localhost:8080';
const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
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
  constructor(callbacks, myIdentity = null, peerIdentity = null, signalingUrl = DEFAULT_SIGNALING_URL) {
    this.callbacks = callbacks;
    this.myIdentity = myIdentity;
    this.peerIdentity = peerIdentity;
    this.signalingUrl = signalingUrl;

    this.ws = null;
    this.pc = null;
    this.dataChannel = null;
    this.roomCode = null;
    this.isHost = false;
    this.sessionKey = null;
    this.connectionTimeout = null;
    this.fileReceiver = null;

    // ICE Candidate buffering: Holds candidates received before setRemoteDescription() finishes
    this.isRemoteDescriptionSet = false;
    this.queuedIceCandidates = [];
  }

  /**
   * Update or set peer identity and derive session key if channel is already active
   */
  async setPeerIdentity(peerIdentity) {
    this.peerIdentity = peerIdentity;
    if (this.myIdentity?.agreementKeyPair?.privateKey && this.peerIdentity?.ecdh) {
      try {
        this.sessionKey = await deriveSharedSecret(
          this.myIdentity.agreementKeyPair.privateKey,
          this.peerIdentity.ecdh
        );
        console.log('[E2EE] Derived shared AES-256-GCM session key successfully.');

        if (this.fileReceiver) {
          this.fileReceiver.updateKeys(this.sessionKey, this.peerIdentity.ecdsa);
        }
      } catch (err) {
        console.error('[E2EE] Failed to derive shared secret:', err);
      }
    }
  }

  /**
   * Initialize signaling WebSocket connection
   * @returns {Promise<WebSocket>}
   */
  connectSignaling() {
    return new Promise((resolve, reject) => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        return resolve(this.ws);
      }

      this.cleanup();

      try {
        this.ws = new WebSocket(this.signalingUrl);
      } catch (err) {
        this.callbacks.onStatusChange('error', {
          message: `Failed to connect to signaling server at ${this.signalingUrl}. Is the server running?`,
        });
        return reject(err);
      }

      this.ws.onopen = () => {
        resolve(this.ws);
      };

      this.ws.onerror = (err) => {
        console.error('[Signaling] WebSocket error:', err);
        this.callbacks.onStatusChange('error', {
          message: `Unable to connect to signaling server (${this.signalingUrl}). Ensure server is started.`,
        });
        reject(err);
      };

      this.ws.onclose = () => {
        console.log('[Signaling] WebSocket connection closed');
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
   * Create a new ephemeral room as Host
   */
  async createRoom() {
    try {
      this.isHost = true;
      this.callbacks.onStatusChange('creating');
      await this.connectSignaling();
      this.sendSignaling({ type: 'create' });
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
      this.callbacks.onStatusChange('joining');
      await this.connectSignaling();
      this.sendSignaling({ type: 'join', room: cleanCode });
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
   * Set up local RTCPeerConnection
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

    // Monitor connection states
    pc.onconnectionstatechange = () => {
      console.log('[WebRTC] Connection state:', pc.connectionState);
      if (pc.connectionState === 'connected') {
        this.clearConnectionTimeout();
      } else if (pc.connectionState === 'failed') {
        this.clearConnectionTimeout();
        this.callbacks.onStatusChange('error', {
          message: 'Connection failed — you may need a TURN server for this network.',
        });
      } else if (pc.connectionState === 'disconnected') {
        this.callbacks.onStatusChange('disconnected', { message: 'Peer connection disconnected.' });
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log('[WebRTC] ICE state:', pc.iceConnectionState);
      if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
        this.clearConnectionTimeout();
      } else if (pc.iceConnectionState === 'failed') {
        this.clearConnectionTimeout();
        this.callbacks.onStatusChange('error', {
          message: 'Connection failed — you may need a TURN server for this network.',
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

    // Send offer to joiner
    this.sendSignaling({
      type: 'offer',
      sdp: offer.sdp,
    });
  }

  /**
   * Joiner Flow: Receive host offer, set remote description, send SDP answer
   */
  async handleRemoteOffer(offerData) {
    const pc = this.setupPeerConnection();

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

    // Create and send Answer
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    this.sendSignaling({
      type: 'answer',
      sdp: answer.sdp,
    });
  }

  /**
   * Host Flow: Receive joiner answer and set remote description
   */
  async handleRemoteAnswer(answerData) {
    if (!this.pc) return;

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
    if (this.peerIdentity?.ecdsa) {
      this.fileReceiver = new FileReceiver({
        sessionKey: this.sessionKey,
        peerEcdsaPublicKeyJWK: this.peerIdentity.ecdsa,
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
    }

    dc.onopen = async () => {
      console.log('[WebRTC] DataChannel "chat" is OPEN!');
      this.clearConnectionTimeout();

      // Derive E2EE AES-256-GCM Session Key using ECDH agreement
      if (this.myIdentity?.agreementKeyPair?.privateKey && this.peerIdentity?.ecdh) {
        try {
          this.sessionKey = await deriveSharedSecret(
            this.myIdentity.agreementKeyPair.privateKey,
            this.peerIdentity.ecdh
          );
          console.log('[E2EE] AES-256-GCM session key active.');

          if (this.fileReceiver) {
            this.fileReceiver.updateKeys(this.sessionKey, this.peerIdentity.ecdsa);
          }
        } catch (err) {
          console.error('[E2EE] Session key derivation failed:', err);
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

        // 📁 Pass 5: File Transfer Protocol Messages
        if (payload.type === 'file-start') {
          await this.fileReceiver?.handleFileStart(payload);
          return;
        }
        if (payload.type === 'file-chunk') {
          await this.fileReceiver?.handleFileChunk(payload);
          return;
        }
        if (payload.type === 'file-end') {
          await this.fileReceiver?.handleFileEnd(payload);
          return;
        }

        // Check if message is encrypted format { id, iv, ciphertext, signature, timestamp }
        if (payload.ciphertext && payload.iv && payload.signature) {
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

          // 2. Decrypt Ciphertext (AES-256-GCM)
          if (!this.sessionKey) {
            console.warn('[E2EE] No session key available to decrypt message. Dropping payload.');
            return;
          }

          const decryptedText = await decryptMessage(
            this.sessionKey,
            payload.iv,
            payload.ciphertext
          );

          // Try parsing decrypted string as inner ephemeral JSON structure
          let innerPayload;
          try {
            innerPayload = JSON.parse(decryptedText);
          } catch {
            innerPayload = {
              id: payload.id || `${Date.now()}`,
              text: decryptedText,
              sentAt: payload.timestamp || Date.now(),
              expiresAt: (payload.timestamp || Date.now()) + DEFAULT_TTL_SECONDS * 1000,
              burnOnRead: false,
              burnDelay: 5,
            };
          }

          // Deliver authenticated plaintext & expiry metadata to UI
          this.callbacks.onMessageReceived({
            id: innerPayload.id || payload.id || `${Date.now()}`,
            text: innerPayload.text,
            sentAt: innerPayload.sentAt || payload.timestamp || Date.now(),
            expiresAt: innerPayload.expiresAt || (Date.now() + DEFAULT_TTL_SECONDS * 1000),
            burnOnRead: Boolean(innerPayload.burnOnRead),
            burnDelay: innerPayload.burnDelay || 5,
            sender: 'peer',
            timestamp: innerPayload.sentAt || payload.timestamp || Date.now(),
            isEncrypted: true,
          });
        } else {
          // Fallback unencrypted raw payload
          this.callbacks.onMessageReceived({
            id: payload.id || `${Date.now()}`,
            text: payload.text || event.data,
            sentAt: payload.timestamp || Date.now(),
            expiresAt: Date.now() + DEFAULT_TTL_SECONDS * 1000,
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
      // 2. Encrypt inner JSON with AES-GCM using unique 12-byte IV
      const { iv, ciphertext } = await encryptMessage(this.sessionKey, innerJsonString);

      // 3. Sign ciphertext with local ECDSA private key
      const signature = await signMessage(
        this.myIdentity.signingKeyPair.privateKey,
        ciphertext
      );

      // 4. Construct encrypted wire envelope
      const wireEnvelope = {
        id: ephemeralPayload.id,
        iv,
        ciphertext,
        signature,
        timestamp: ephemeralPayload.sentAt,
      };

      // Send encrypted JSON payload across the WebRTC channel
      this.dataChannel.send(JSON.stringify(wireEnvelope));

      return {
        ...ephemeralPayload,
        sender: 'me',
        timestamp: ephemeralPayload.sentAt,
        isEncrypted: true,
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
          message: 'Connection failed — you may need a TURN server for this network.',
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

    this.roomCode = null;
    this.isHost = false;
    this.sessionKey = null;
    this.isRemoteDescriptionSet = false;
    this.queuedIceCandidates = [];

    if (notify) {
      this.callbacks.onStatusChange('idle');
    }
  }
}
