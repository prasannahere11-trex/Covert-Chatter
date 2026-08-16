/**
 * Whisper Drop — Message Encryption & Digital Signature Subsystem (AES-GCM + ECDSA)
 * 
 * 🎓 Cryptographic Security Principles:
 * ---------------------------------------
 * 1. AES-GCM (Galois/Counter Mode):
 *    - Provides both Confidentiality (encryption) and Authenticity (integrity tag).
 *    - Standard IV length for AES-GCM is 12 bytes (96 bits), which provides optimal
 *      performance and avoids additional GHASH computations.
 * 
 * ⚠️ CRITICAL AES-GCM RULE — IV UNIQUENESS:
 *    - You MUST NEVER reuse an Initialization Vector (IV) with the same encryption key!
 *    - Reusing an IV in AES-GCM (a "nonce-reuse attack") destroys authenticity and allows
 *      an attacker to recover the authentication key (GHASH hash key `H`) and decrypt/forge
 *      messages.
 *    - In Whisper Drop, we generate a brand-new, cryptographically secure random 12-byte IV
 *      (`crypto.getRandomValues(new Uint8Array(12))`) for every single message.
 * 
 * 2. Authenticated Digital Signatures (ECDSA P-256 + SHA-256):
 *    - Every message's ciphertext is digitally signed by the sender's non-extractable ECDSA
 *      private key before transmission.
 *    - The receiver verifies the signature against the sender's authenticated ECDSA public key
 *      BEFORE attempting decryption, ensuring the message was genuinely produced by the peer.
 */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// Cache imported peer ECDSA CryptoKeys to avoid redundant Web Crypto import calls
const peerEcdsaKeyCache = new Map();

/**
 * Encrypt a plaintext string using an AES-GCM 256-bit session key.
 * 
 * @param {CryptoKey} sessionKey - AES-GCM CryptoKey derived via ECDH
 * @param {string} plaintext - Plain text message
 * @returns {Promise<{ iv: number[], ciphertext: number[] }>}
 */
export async function encryptMessage(sessionKey, plaintext) {
  if (!sessionKey) {
    throw new Error('Session key is required for message encryption.');
  }

  // 1. Generate a fresh, unique 12-byte (96-bit) Initialization Vector (IV)
  const iv = window.crypto.getRandomValues(new Uint8Array(12));

  // 2. Encode UTF-8 plaintext to byte array
  const plaintextBytes = textEncoder.encode(plaintext);

  // 3. Encrypt with AES-GCM (automatically generates 128-bit authentication tag appended to ciphertext)
  const ciphertextBuffer = await window.crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: iv,
      tagLength: 128, // Full 128-bit authentication tag
    },
    sessionKey,
    plaintextBytes
  );

  return {
    iv: Array.from(iv),
    ciphertext: Array.from(new Uint8Array(ciphertextBuffer)),
  };
}

/**
 * Decrypt an AES-GCM ciphertext using the session key and message IV.
 * 
 * @param {CryptoKey} sessionKey - AES-GCM CryptoKey derived via ECDH
 * @param {number[]|Uint8Array} ivArray - 12-byte initialization vector
 * @param {number[]|Uint8Array} ciphertextArray - Ciphertext bytes including authentication tag
 * @returns {Promise<string>} Decrypted plaintext
 */
export async function decryptMessage(sessionKey, ivArray, ciphertextArray) {
  if (!sessionKey) {
    throw new Error('Session key is required for message decryption.');
  }

  const iv = new Uint8Array(ivArray);
  const ciphertext = new Uint8Array(ciphertextArray);

  try {
    const decryptedBuffer = await window.crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: iv,
        tagLength: 128,
      },
      sessionKey,
      ciphertext
    );

    return textDecoder.decode(decryptedBuffer);
  } catch (err) {
    console.error('[E2EE] Decryption authentication failed (ciphertext corrupted or tampered):', err);
    throw new Error('Message authentication failed: Ciphertext or IV was tampered with.');
  }
}

/**
 * Digitally sign message ciphertext bytes using the sender's non-extractable ECDSA private key.
 * 
 * @param {CryptoKey} myEcdsaPrivateKey - Local ECDSA private key (non-extractable)
 * @param {number[]|Uint8Array} ciphertextArray - Ciphertext bytes to sign
 * @returns {Promise<number[]>} Digital signature byte array
 */
export async function signMessage(myEcdsaPrivateKey, ciphertextArray) {
  if (!myEcdsaPrivateKey) {
    throw new Error('Local ECDSA private key is required for signing.');
  }

  const ciphertextBytes = new Uint8Array(ciphertextArray);

  const signatureBuffer = await window.crypto.subtle.sign(
    {
      name: 'ECDSA',
      hash: { name: 'SHA-256' },
    },
    myEcdsaPrivateKey,
    ciphertextBytes
  );

  return Array.from(new Uint8Array(signatureBuffer));
}

/**
 * Verify a digital signature over ciphertext bytes using the peer's public ECDSA JWK.
 * 
 * @param {JsonWebKey} peerEcdsaPublicKeyJWK - Peer's public ECDSA key in JWK format
 * @param {number[]|Uint8Array} ciphertextArray - Ciphertext bytes
 * @param {number[]|Uint8Array} signatureArray - Digital signature bytes
 * @returns {Promise<boolean>} True if signature is valid and authentic
 */
export async function verifyMessage(peerEcdsaPublicKeyJWK, ciphertextArray, signatureArray) {
  if (!peerEcdsaPublicKeyJWK) {
    console.warn('[E2EE] Missing peer ECDSA public key for verification.');
    return false;
  }

  try {
    // Check cache for already-imported CryptoKey or import
    const cacheKey = peerEcdsaPublicKeyJWK.x + ':' + peerEcdsaPublicKeyJWK.y;
    let peerPublicKey = peerEcdsaKeyCache.get(cacheKey);

    if (!peerPublicKey) {
      peerPublicKey = await window.crypto.subtle.importKey(
        'jwk',
        peerEcdsaPublicKeyJWK,
        {
          name: 'ECDSA',
          namedCurve: 'P-256',
        },
        true,
        ['verify']
      );
      peerEcdsaKeyCache.set(cacheKey, peerPublicKey);
    }

    const ciphertextBytes = new Uint8Array(ciphertextArray);
    const signatureBytes = new Uint8Array(signatureArray);

    const isValid = await window.crypto.subtle.verify(
      {
        name: 'ECDSA',
        hash: { name: 'SHA-256' },
      },
      peerPublicKey,
      signatureBytes,
      ciphertextBytes
    );

    return isValid;
  } catch (err) {
    console.warn('[E2EE] Signature verification error:', err);
    return false;
  }
}
