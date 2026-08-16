/**
 * Whisper Drop — Encrypted Ephemeral File Transfer & Backpressure Subsystem (Pass 5)
 * 
 * 🎓 DEEP DIVE: RTCDataChannel Chunking & Backpressure Flow Control
 * ================================================================
 * 
 * 1. Why Chunking is Necessary:
 *    - WebRTC RTCDataChannel operates over SCTP (Stream Control Transmission Protocol).
 *    - While SCTP can theoretically fragment large messages, sending multi-megabyte payloads
 *      in a single `dataChannel.send()` call often overflows browser internal buffers, leads
 *      to dropped packets, or crashes the channel across different browsers.
 *    - 16KB (16,384 bytes) is the industry gold standard chunk size: universally safe across
 *      all browsers and networks, avoiding SCTP packet fragmentation while keeping per-chunk
 *      cryptographic overhead small.
 * 
 * 2. Why Chunk-Level Encryption (Streaming AES-GCM + Fresh IVs):
 *    - Encrypting an entire 20MB file as one monolithic block would require buffering multiple
 *      copies of the 20MB file in volatile JavaScript RAM (raw file + ciphertext + base64).
 *    - By chunking BEFORE encryption, we slice 16KB blocks on-the-fly, encrypt each chunk
 *      with a brand new 12-byte IV (`encryptMessage`), and digitally sign its ciphertext
 *      with ECDSA (`signMessage`).
 *    - This enables true streaming transmission with minimal memory footprint.
 * 
 * 3. Why Backpressure Handling is Critical:
 *    - Fast JavaScript execution can read and dispatch hundreds of chunks per millisecond,
 *      far exceeding the underlying network upload bandwidth.
 *    - When `dataChannel.send()` is called, data is pushed into the browser's SCTP send buffer.
 *      `dataChannel.bufferedAmount` tells us how many bytes are currently queued waiting for network transmission.
 *    - If `dataChannel.bufferedAmount` grows unchecked, the browser will eventually crash or close the connection.
 *    - Flow Control Solution:
 *      * Set `dataChannel.bufferedAmountLowThreshold = 32768` (32 KB).
 *      * Before sending each chunk, check if `dataChannel.bufferedAmount > 65536` (64 KB).
 *      * If exceeded, PAUSE the sending loop and await the `bufferedamountlow` event.
 *      * When the browser drains the queue below 32 KB, `bufferedamountlow` fires, and we resume sending.
 *      * This automatically throttles transmission to match the exact network throughput.
 * 
 * 4. Receiving & Anti-Persistence Invariant:
 *    - Inbound chunks are cryptographically verified via ECDSA and decrypted via AES-GCM on arrival.
 *    - Chunks are collected in a transient Map and indexed by `chunkIndex` to guarantee correct ordering.
 *    - On `file-end`, chunks are reassembled into an in-memory `Blob` and a transient `blobUrl` is created.
 *    - ZERO DISK PERSISTENCE: Files are never written to disk or IndexedDB. When the file's TTL expires,
 *      `URL.revokeObjectURL(blobUrl)` is called and all chunk arrays are freed for garbage collection.
 */

import { encryptMessage, decryptMessage, signMessage, verifyMessage } from './encryption';
import { DEFAULT_FILE_TTL_SECONDS, BURN_ON_READ_DELAY_SECONDS } from './ephemeral';

export const CHUNK_SIZE = 16384; // 16 KB per chunk
export const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB max limit
export const BUFFER_HIGH_WATER_MARK = 65536; // 64 KB
export const BUFFER_LOW_THRESHOLD = 32768; // 32 KB

/**
 * Format bytes into human-readable string (e.g. "450 KB", "3.2 MB")
 * 
 * @param {number} bytes
 * @returns {string}
 */
export function formatFileSize(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

/**
 * Convert an ArrayBuffer / Uint8Array to a Base64 string for safe JSON wire transmission.
 * 
 * @param {ArrayBuffer|Uint8Array} buffer
 * @returns {string}
 */
export function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
}

/**
 * Convert a Base64 string back to a Uint8Array byte buffer.
 * 
 * @param {string} base64
 * @returns {Uint8Array}
 */
export function base64ToUint8Array(base64) {
  const binaryString = window.atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

/**
 * Wait for RTCDataChannel buffered amount to drop below the threshold (Backpressure release).
 * 
 * @param {RTCDataChannel} dataChannel
 * @returns {Promise<void>}
 */
function waitForBufferedAmountLow(dataChannel) {
  return new Promise((resolve) => {
    // If buffer already drained below threshold, resume immediately
    if (dataChannel.bufferedAmount <= BUFFER_LOW_THRESHOLD) {
      return resolve();
    }

    const handleBufferedAmountLow = () => {
      dataChannel.removeEventListener('bufferedamountlow', handleBufferedAmountLow);
      resolve();
    };

    dataChannel.addEventListener('bufferedamountlow', handleBufferedAmountLow);
  });
}

/**
 * Encrypt, sign, and stream a file over RTCDataChannel with 16KB chunking and backpressure handling.
 * 
 * @param {object} params
 * @param {File} params.file - File object to send
 * @param {RTCDataChannel} params.dataChannel - Active WebRTC data channel
 * @param {CryptoKey} params.sessionKey - AES-256-GCM session key
 * @param {CryptoKey} params.mySigningPrivateKey - Sender's ECDSA private key
 * @param {object} [params.options] - Ephemeral options
 * @param {number} [params.options.ttlSeconds=180] - Lifespan in seconds
 * @param {boolean} [params.options.burnOnRead=false] - Burn 5s after recipient downloads/views
 * @param {function(object):void} [params.onProgress] - Callback reporting progress
 * @returns {Promise<object>} File message record
 */
export async function sendFileStream({
  file,
  dataChannel,
  sessionKey,
  mySigningPrivateKey,
  options = {},
  onProgress = () => {},
}) {
  if (!file) {
    throw new Error('No file provided for transmission.');
  }

  if (file.size > MAX_FILE_SIZE) {
    throw new Error(`File size (${formatFileSize(file.size)}) exceeds the 25MB maximum limit.`);
  }

  if (!dataChannel || dataChannel.readyState !== 'open') {
    throw new Error('DataChannel is not open. Cannot transmit file.');
  }

  if (!sessionKey || !mySigningPrivateKey) {
    throw new Error('Cryptographic keys are required for E2EE file transfer.');
  }

  // Ensure data channel low threshold is calibrated
  dataChannel.bufferedAmountLowThreshold = BUFFER_LOW_THRESHOLD;

  const now = Date.now();
  const fileId = `file-${now}-${Math.random().toString(36).slice(2, 7)}`;
  const totalChunks = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));
  const ttlSeconds = options.ttlSeconds || DEFAULT_FILE_TTL_SECONDS;
  const expiresAt = now + ttlSeconds * 1000;
  const burnOnRead = Boolean(options.burnOnRead);

  // 1. Prepare and send signed metadata message (file-start)
  const metadata = {
    fileId,
    fileName: file.name,
    fileSize: file.size,
    mimeType: file.type || 'application/octet-stream',
    totalChunks,
    sentAt: now,
    expiresAt,
    burnOnRead,
    burnDelay: BURN_ON_READ_DELAY_SECONDS,
  };

  const metadataJson = JSON.stringify(metadata);
  // Encrypt metadata so file name, size, and type remain confidential
  const { iv: metaIv, ciphertext: metaCiphertext } = await encryptMessage(sessionKey, metadataJson);
  const metaSignature = await signMessage(mySigningPrivateKey, metaCiphertext);

  dataChannel.send(
    JSON.stringify({
      type: 'file-start',
      fileId,
      iv: metaIv,
      ciphertext: metaCiphertext,
      signature: metaSignature,
      timestamp: now,
    })
  );

  // Report 0% initial progress
  onProgress({
    id: fileId,
    type: 'file',
    fileName: file.name,
    fileSize: file.size,
    mimeType: file.type || 'application/octet-stream',
    totalChunks,
    sentAt: now,
    expiresAt,
    burnOnRead,
    burnDelay: BURN_ON_READ_DELAY_SECONDS,
    sender: 'me',
    timestamp: now,
    isEncrypted: true,
    sentChunks: 0,
    progress: 0,
    status: 'sending',
  });

  // 2. Stream 16KB chunks sequentially with backpressure flow control
  for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
    const start = chunkIndex * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, file.size);
    const blobSlice = file.slice(start, end);

    // Read chunk bytes
    const arrayBuffer = await blobSlice.arrayBuffer();
    const base64Chunk = arrayBufferToBase64(arrayBuffer);

    // Encrypt chunk with fresh random 12-byte IV
    const { iv, ciphertext } = await encryptMessage(sessionKey, base64Chunk);

    // Digitally sign chunk ciphertext with ECDSA
    const signature = await signMessage(mySigningPrivateKey, ciphertext);

    // 🎓 BACKPRESSURE FLOW CONTROL:
    // If the outgoing SCTP buffer exceeds 64KB, pause sending and wait for
    // the browser to drain the queue below 32KB before dispatching more chunks.
    if (dataChannel.bufferedAmount > BUFFER_HIGH_WATER_MARK) {
      await waitForBufferedAmountLow(dataChannel);
    }

    // Dispatch chunk message
    dataChannel.send(
      JSON.stringify({
        type: 'file-chunk',
        fileId,
        chunkIndex,
        iv,
        ciphertext,
        signature,
      })
    );

    // Report live progress
    const sentChunks = chunkIndex + 1;
    const percent = Math.round((sentChunks / totalChunks) * 100);
    onProgress({
      id: fileId,
      type: 'file',
      fileName: file.name,
      fileSize: file.size,
      mimeType: file.type || 'application/octet-stream',
      totalChunks,
      sentAt: now,
      expiresAt,
      burnOnRead,
      burnDelay: BURN_ON_READ_DELAY_SECONDS,
      sender: 'me',
      timestamp: now,
      isEncrypted: true,
      sentChunks,
      progress: percent,
      status: sentChunks === totalChunks ? 'completed' : 'sending',
    });
  }

  // 3. Send file-end marker
  dataChannel.send(
    JSON.stringify({
      type: 'file-end',
      fileId,
    })
  );

  // Return sender's message representation
  return {
    id: fileId,
    type: 'file',
    fileName: file.name,
    fileSize: file.size,
    mimeType: file.type || 'application/octet-stream',
    totalChunks,
    sentAt: now,
    expiresAt,
    burnOnRead,
    burnDelay: BURN_ON_READ_DELAY_SECONDS,
    sender: 'me',
    timestamp: now,
    isEncrypted: true,
    progress: 100,
    status: 'completed',
    // For sender, create a temporary blob URL from local file so sender can also download/preview
    blobUrl: URL.createObjectURL(file),
  };
}

/**
 * FileReceiver: Manages receiving, authenticating, decrypting, and reassembling file streams.
 */
export class FileReceiver {
  /**
   * @param {object} params
   * @param {CryptoKey} params.sessionKey - Shared AES-GCM session key
   * @param {JsonWebKey} params.peerEcdsaPublicKeyJWK - Peer's public ECDSA key
   * @param {function(object):void} params.onFileProgress - Progress update callback
   * @param {function(object):void} params.onFileComplete - Completed file ready callback
   * @param {function(string, string):void} params.onError - Error callback
   */
  constructor({ sessionKey, peerEcdsaPublicKeyJWK, onFileProgress, onFileComplete, onError }) {
    this.sessionKey = sessionKey;
    this.peerEcdsaPublicKeyJWK = peerEcdsaPublicKeyJWK;
    this.onFileProgress = onFileProgress || (() => {});
    this.onFileComplete = onFileComplete || (() => {});
    this.onError = onError || (() => {});

    // Active incoming file transfers keyed by fileId
    this.transfers = new Map();
  }

  /**
   * Update cryptographic keys if changed
   */
  updateKeys(sessionKey, peerEcdsaPublicKeyJWK) {
    this.sessionKey = sessionKey;
    this.peerEcdsaPublicKeyJWK = peerEcdsaPublicKeyJWK;
  }

  /**
   * Handle incoming 'file-start' metadata message
   */
  async handleFileStart(data) {
    const { fileId, iv, ciphertext, signature } = data;

    if (!this.sessionKey || !this.peerEcdsaPublicKeyJWK) {
      console.warn('[FileReceiver] Cannot accept file: cryptographic keys not established.');
      return;
    }

    // 1. Verify metadata signature
    const isValidSignature = await verifyMessage(this.peerEcdsaPublicKeyJWK, ciphertext, signature);
    if (!isValidSignature) {
      console.warn('[FileReceiver] Metadata signature verification failed! Dropping unauthorized file.');
      return;
    }

    // 2. Decrypt metadata
    let metadata;
    try {
      const decryptedJson = await decryptMessage(this.sessionKey, iv, ciphertext);
      metadata = JSON.parse(decryptedJson);
    } catch (err) {
      console.error('[FileReceiver] Failed to decrypt file metadata:', err);
      return;
    }

    // 3. Initialize transfer record in volatile RAM
    const transfer = {
      fileId,
      fileName: metadata.fileName,
      fileSize: metadata.fileSize,
      mimeType: metadata.mimeType || 'application/octet-stream',
      totalChunks: metadata.totalChunks,
      sentAt: metadata.sentAt || Date.now(),
      expiresAt: metadata.expiresAt || (Date.now() + DEFAULT_FILE_TTL_SECONDS * 1000),
      burnOnRead: Boolean(metadata.burnOnRead),
      burnDelay: metadata.burnDelay || BURN_ON_READ_DELAY_SECONDS,
      receivedChunks: new Map(), // chunkIndex -> Uint8Array
      progress: 0,
      status: 'receiving',
    };

    this.transfers.set(fileId, transfer);

    // Notify UI of new incoming file
    this.onFileProgress({
      id: fileId,
      type: 'file',
      fileName: transfer.fileName,
      fileSize: transfer.fileSize,
      mimeType: transfer.mimeType,
      totalChunks: transfer.totalChunks,
      sentAt: transfer.sentAt,
      expiresAt: transfer.expiresAt,
      burnOnRead: transfer.burnOnRead,
      burnDelay: transfer.burnDelay,
      sender: 'peer',
      timestamp: transfer.sentAt,
      isEncrypted: true,
      progress: 0,
      status: 'receiving',
    });
  }

  /**
   * Handle incoming 'file-chunk' message
   */
  async handleFileChunk(data) {
    const { fileId, chunkIndex, iv, ciphertext, signature } = data;
    const transfer = this.transfers.get(fileId);

    if (!transfer) {
      // Chunk arrived for unknown or already completed file
      return;
    }

    // 1. Verify chunk ECDSA signature
    const isValidSignature = await verifyMessage(this.peerEcdsaPublicKeyJWK, ciphertext, signature);
    if (!isValidSignature) {
      console.warn(`[FileReceiver] Chunk ${chunkIndex} signature invalid. Dropping chunk.`);
      return;
    }

    // 2. Decrypt chunk AES-GCM
    let base64Chunk;
    try {
      base64Chunk = await decryptMessage(this.sessionKey, iv, ciphertext);
    } catch (err) {
      console.error(`[FileReceiver] Chunk ${chunkIndex} decryption failed:`, err);
      return;
    }

    // 3. Convert to Uint8Array and store in chunk map
    const chunkBytes = base64ToUint8Array(base64Chunk);
    transfer.receivedChunks.set(chunkIndex, chunkBytes);

    // 4. Update progress
    const receivedCount = transfer.receivedChunks.size;
    const percent = Math.round((receivedCount / transfer.totalChunks) * 100);
    transfer.progress = percent;

    this.onFileProgress({
      id: fileId,
      type: 'file',
      fileName: transfer.fileName,
      fileSize: transfer.fileSize,
      mimeType: transfer.mimeType,
      totalChunks: transfer.totalChunks,
      sentAt: transfer.sentAt,
      expiresAt: transfer.expiresAt,
      burnOnRead: transfer.burnOnRead,
      burnDelay: transfer.burnDelay,
      sender: 'peer',
      timestamp: transfer.sentAt,
      isEncrypted: true,
      progress: percent,
      status: 'receiving',
    });
  }

  /**
   * Handle incoming 'file-end' completion message
   */
  async handleFileEnd(data) {
    const { fileId } = data;
    const transfer = this.transfers.get(fileId);

    if (!transfer) {
      return;
    }

    // Validate chunk completeness
    if (transfer.receivedChunks.size !== transfer.totalChunks) {
      console.error(
        `[FileReceiver] Chunk mismatch: expected ${transfer.totalChunks} chunks, got ${transfer.receivedChunks.size}`
      );
      this.onError(fileId, 'File transfer incomplete: missing chunks.');
      this.transfers.delete(fileId);
      return;
    }

    // Reassemble chunks sequentially in order (0 to totalChunks - 1)
    const orderedParts = [];
    for (let i = 0; i < transfer.totalChunks; i++) {
      const part = transfer.receivedChunks.get(i);
      if (!part) {
        console.error(`[FileReceiver] Missing chunk index ${i}`);
        this.onError(fileId, 'Corrupted file stream: missing sequential chunk.');
        this.transfers.delete(fileId);
        return;
      }
      orderedParts.push(part);
    }

    // Create transient in-memory Blob and URL
    const blob = new Blob(orderedParts, { type: transfer.mimeType });
    const blobUrl = URL.createObjectURL(blob);

    // Clean up raw chunk byte arrays from memory to release RAM
    transfer.receivedChunks.clear();
    this.transfers.delete(fileId);

    // Deliver completed ephemeral file message to UI
    this.onFileComplete({
      id: fileId,
      type: 'file',
      fileName: transfer.fileName,
      fileSize: transfer.fileSize,
      mimeType: transfer.mimeType,
      totalChunks: transfer.totalChunks,
      sentAt: transfer.sentAt,
      expiresAt: transfer.expiresAt,
      burnOnRead: transfer.burnOnRead,
      burnDelay: transfer.burnDelay,
      sender: 'peer',
      timestamp: transfer.sentAt,
      isEncrypted: true,
      progress: 100,
      status: 'completed',
      blobUrl,
    });
  }

  /**
   * Wipe all in-flight buffers from memory
   */
  cleanup() {
    for (const transfer of this.transfers.values()) {
      if (transfer.receivedChunks) {
        transfer.receivedChunks.clear();
      }
    }
    this.transfers.clear();
  }
}
