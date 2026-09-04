/**
 * Covert Chatter — Ephemeral Message Lifecycle & Anti-Persistence Subsystem
 * 
 * 🛡️ SECURITY INVARIANTS:
 * -----------------------
 * 1. VOLATILE MEMORY ONLY:
 *    - Messages exist exclusively in transient JavaScript RAM (React component state).
 *    - Messages are NEVER committed to localStorage, sessionStorage, IndexedDB, cookies,
 *      ServiceWorker caches, or WebSQL.
 *    - Refreshing the page, closing the tab, or unmounting the component immediately purges
 *      all message text and derived session keys into garbage collection.
 * 
 * 2. AUTHENTICATED & TAMPER-PROOF EXPIRY:
 *    - The expiry timestamp (`expiresAt`) and burn parameters are packaged inside the inner
 *      message JSON structure BEFORE AES-256-GCM encryption and ECDSA signing.
 *    - An adversary or compromised relay cannot tamper with or extend the message's lifespan
 *      without invalidating the cryptographic authentication tag and digital signature.
 * 
 * 3. BURN-ON-READ TIMERS:
 *    - If `burnOnRead` is enabled, a countdown timer initiates once the recipient renders
 *      the message on screen, destroying it after 5 seconds.
 */

export const DEFAULT_TTL_SECONDS = 60;
export const DEFAULT_FILE_TTL_SECONDS = 300; // 5 minutes default for files
export const BURN_ON_READ_DELAY_SECONDS = 10; // 10 seconds burn countdown for media & burn-on-read
export const BACKGROUND_BLUR_PURGE_TIMEOUT_MS = 180000; // 3 minutes grace period for mobile app switches (gallery/camera)

export const TTL_OPTIONS = [
  { label: '10 sec (Fast)', seconds: 10 },
  { label: '30 sec', seconds: 30 },
  { label: '60 sec (1m)', seconds: 60 },
  { label: '3 min', seconds: 180 },
  { label: '5 min', seconds: 300 },
  { label: '10 min', seconds: 600 },
  { label: '1 hour', seconds: 3600 },
  { label: '24 hours', seconds: 86400 },
];

export const FILE_TTL_OPTIONS = [
  { label: '60s', seconds: 60 },
  { label: '3 min', seconds: 180 },
  { label: '5 min', seconds: 300 },
  { label: '10 min', seconds: 600 },
];

/**
 * Format remaining seconds into clean, human-readable countdown string (e.g. "45s", "2m 15s", "1h 30m").
 * 
 * @param {number} seconds
 * @returns {string}
 */
export function formatRemainingTime(seconds) {
  if (typeof seconds !== 'number' || seconds < 0) return '0s';
  if (seconds >= 86400) {
    const days = Math.floor(seconds / 86400);
    const hrs = Math.floor((seconds % 86400) / 3600);
    return hrs > 0 ? `${days}d ${hrs}h` : `${days}d`;
  }
  if (seconds >= 3600) {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    return mins > 0 ? `${hrs}h ${mins}m` : `${hrs}h`;
  }
  if (seconds >= 60) {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
  }
  return `${seconds}s`;
}

/**
 * Safely revoke a Blob URL if present in an ephemeral message record.
 * 
 * @param {object} message
 */
export function revokeFileBlobUrl(message) {
  if (message?.blobUrl) {
    try {
      URL.revokeObjectURL(message.blobUrl);
    } catch (err) {
      console.warn('[Ephemeral] Error revoking blob URL:', err);
    }
  }
}

/**
 * Construct an authenticated ephemeral message payload.
 * 
 * @param {string} text - Message plaintext
 * @param {object} options
 * @param {number} [options.ttlSeconds=60] - Lifespan in seconds
 * @param {boolean} [options.burnOnRead=false] - If true, burns 5s after recipient renders it
 * @returns {object} Inner message object to be encrypted
 */
export function createEphemeralPayload(text, { ttlSeconds = DEFAULT_TTL_SECONDS, burnOnRead = false } = {}) {
  const now = Date.now();
  const validTTL = Math.max(5, ttlSeconds || DEFAULT_TTL_SECONDS);

  return {
    id: `${now}-${Math.random().toString(36).slice(2, 7)}`,
    text: text.trim(),
    sentAt: now,
    ttlSeconds: validTTL,
    expiresAt: now + validTTL * 1000,
    burnOnRead: Boolean(burnOnRead),
    burnDelay: BURN_ON_READ_DELAY_SECONDS,
  };
}

/**
 * Compute the remaining lifespan of a message in seconds.
 * 
 * @param {object} message - Ephemeral message record
 * @param {number} [currentTime=Date.now()]
 * @returns {number} Seconds remaining (0 if expired)
 */
export function getRemainingSeconds(message, currentTime = Date.now()) {
  if (!message) return 0;

  // If a burn-on-read timer is active, use the burn deadline
  let targetDeadline = message.expiresAt;
  if (message.burnDeadline) {
    targetDeadline = Math.min(targetDeadline, message.burnDeadline);
  }

  const remainingMs = targetDeadline - currentTime;
  return Math.max(0, Math.ceil(remainingMs / 1000));
}

/**
 * Check if a message has reached its expiration deadline.
 * 
 * @param {object} message
 * @param {number} [currentTime=Date.now()]
 * @returns {boolean} True if message should be deleted from memory
 */
export function isMessageExpired(message, currentTime = Date.now()) {
  if (!message) return true;

  if (message.burnDeadline && currentTime >= message.burnDeadline) {
    return true;
  }

  if (message.expiresAt && currentTime >= message.expiresAt) {
    return true;
  }

  return false;
}
