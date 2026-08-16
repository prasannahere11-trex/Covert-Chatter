/**
 * Covert Chatter — Cryptographic Identity Subsystem
 * 
 * Cryptographic Architecture & Standards:
 * 1. Signing Keypair (ECDSA P-256 / SHA-256):
 *    - Purpose: Identity authentication and cryptographic message signing.
 *    - Private Key: Non-extractable (`extractable = false`), residing strictly in browser keystore.
 *    - Usages: ["sign", "verify"]
 * 
 * 2. Key Agreement Keypair (ECDH P-256):
 *    - Purpose: Future Diffie-Hellman shared-secret derivation with peers over WebRTC.
 *    - Private Key: Non-extractable (`extractable = false`), protecting derived shared secrets.
 *    - Usages: ["deriveKey", "deriveBits"]
 * 
 * 3. Identity Fingerprint:
 *    - Purpose: Human-readable authentication code to detect Man-In-The-Middle (MITM) attacks.
 *    - Computation: SHA-256 digest over the canonical string representation of both public JWKs.
 */

/**
 * Step 1: Generate an ECDSA P-256 keypair for identity signing and authenticity.
 * The private key is flagged as non-extractable (extractable: false) to prevent
 * raw private key extraction via JavaScript.
 * 
 * @returns {Promise<CryptoKeyPair>}
 */
export async function generateSigningKeypair() {
  if (!window.crypto || !window.crypto.subtle) {
    throw new Error('Web Crypto API (crypto.subtle) is not supported in this environment.');
  }

  return await window.crypto.subtle.generateKey(
    {
      name: 'ECDSA',
      namedCurve: 'P-256', // Standard NIST P-256 / secp256r1 elliptic curve
    },
    false, // extractable = false: Private key cannot be exported via exportKey()
    ['sign', 'verify'] // Allowed cryptographic operations
  );
}

/**
 * Step 2: Generate an ECDH P-256 keypair for Diffie-Hellman key agreement.
 * This keypair is used exclusively to establish shared encryption secrets with peers.
 * 
 * @returns {Promise<CryptoKeyPair>}
 */
export async function generateAgreementKeypair() {
  if (!window.crypto || !window.crypto.subtle) {
    throw new Error('Web Crypto API (crypto.subtle) is not supported in this environment.');
  }

  return await window.crypto.subtle.generateKey(
    {
      name: 'ECDH',
      namedCurve: 'P-256', // Matching curve for seamless compatibility
    },
    false, // extractable = false: Non-extractable private key
    ['deriveKey', 'deriveBits'] // Operations permitted for key agreement
  );
}

/**
 * Step 3: Export public keys into JSON Web Key (JWK) format.
 * Public keys are safe to distribute to peers and display via QR codes.
 * 
 * @param {CryptoKey} signingPublicKey - ECDSA public key
 * @param {CryptoKey} agreementPublicKey - ECDH public key
 * @returns {Promise<{ ecdsa: JsonWebKey, ecdh: JsonWebKey }>}
 */
export async function exportPublicJWKs(signingPublicKey, agreementPublicKey) {
  const [ecdsaJWK, ecdhJWK] = await Promise.all([
    window.crypto.subtle.exportKey('jwk', signingPublicKey),
    window.crypto.subtle.exportKey('jwk', agreementPublicKey),
  ]);

  // Clean JWK to only include canonical public key fields (kty, crv, x, y)
  const canonicalEcdsa = {
    kty: ecdsaJWK.kty,
    crv: ecdsaJWK.crv,
    x: ecdsaJWK.x,
    y: ecdsaJWK.y,
    key_ops: ['verify'],
  };

  const canonicalEcdh = {
    kty: ecdhJWK.kty,
    crv: ecdhJWK.crv,
    x: ecdhJWK.x,
    y: ecdhJWK.y,
    key_ops: [], // ECDH public key is used as external party in deriveKey
  };

  return { ecdsa: canonicalEcdsa, ecdh: canonicalEcdh };
}

/**
 * Step 4: Compute a deterministic SHA-256 fingerprint for public identity.
 * Hashes canonical concatenated coordinates (x, y) of both ECDSA and ECDH public keys.
 * Formats the output as clean uppercase hex chunks (e.g. "4A7B 9C12 8D3E ... 9F21").
 * 
 * @param {JsonWebKey} ecdsaJWK
 * @param {JsonWebKey} ecdhJWK
 * @returns {Promise<string>} Hex fingerprint
 */
export async function computeFingerprint(ecdsaJWK, ecdhJWK) {
  // Deterministic canonical string representation
  const canonicalData = JSON.stringify({
    ecdsa: { crv: ecdsaJWK.crv, kty: ecdsaJWK.kty, x: ecdsaJWK.x, y: ecdsaJWK.y },
    ecdh: { crv: ecdhJWK.crv, kty: ecdhJWK.kty, x: ecdhJWK.x, y: ecdhJWK.y },
  });

  const encoder = new TextEncoder();
  const dataBuffer = encoder.encode(canonicalData);

  // Perform SHA-256 digest on public key data
  const hashBuffer = await window.crypto.subtle.digest('SHA-256', dataBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hex = hashArray.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join('');

  // Format into 8 readable 4-byte groups (e.g. "4A7B 9C12 ... 9F21")
  return hex.match(/.{1,4}/g)?.join(' ') || hex;
}

/**
 * Helper: Generate complete fresh identity package (CryptoKeys + Exported JWKs + Fingerprint)
 * 
 * @returns {Promise<{
 *   signingKeyPair: CryptoKeyPair,
 *   agreementKeyPair: CryptoKeyPair,
 *   publicJWKs: { ecdsa: JsonWebKey, ecdh: JsonWebKey },
 *   fingerprint: string,
 *   createdAt: number
 * }>}
 */
export async function generateFullIdentity() {
  const [signingKeyPair, agreementKeyPair] = await Promise.all([
    generateSigningKeypair(),
    generateAgreementKeypair(),
  ]);

  const publicJWKs = await exportPublicJWKs(
    signingKeyPair.publicKey,
    agreementKeyPair.publicKey
  );

  const fingerprint = await computeFingerprint(publicJWKs.ecdsa, publicJWKs.ecdh);

  return {
    signingKeyPair,
    agreementKeyPair,
    publicJWKs,
    fingerprint,
    createdAt: Date.now(),
  };
}

/**
 * Step 5: Validate and parse a peer's scanned public identity payload.
 * Verifies that the payload contains valid P-256 ECDSA and ECDH JWKs and recomputes the fingerprint.
 * 
 * @param {string|object} rawPayload - JSON string or parsed object from QR code / file
 * @returns {Promise<{ valid: boolean, peerIdentity?: object, error?: string }>}
 */
export async function validatePeerIdentityPayload(rawPayload) {
  try {
    let payload = rawPayload;
    if (typeof rawPayload === 'string') {
      payload = JSON.parse(rawPayload);
    }

    if (!payload || typeof payload !== 'object') {
      return { valid: false, error: 'Invalid identity payload: Expected a JSON object.' };
    }

    const { ecdsa, ecdh, fingerprint, protocol, version } = payload;

    if (!ecdsa || !ecdh) {
      return { valid: false, error: 'Missing public keys (ecdsa or ecdh missing).' };
    }

    // Verify ECDSA JWK structure
    if (ecdsa.kty !== 'EC' || ecdsa.crv !== 'P-256' || !ecdsa.x || !ecdsa.y) {
      return { valid: false, error: 'Invalid ECDSA key: Must be EC curve P-256 with x and y coordinates.' };
    }

    // Verify ECDH JWK structure
    if (ecdh.kty !== 'EC' || ecdh.crv !== 'P-256' || !ecdh.x || !ecdh.y) {
      return { valid: false, error: 'Invalid ECDH key: Must be EC curve P-256 with x and y coordinates.' };
    }

    // Recompute fingerprint to ensure cryptographic integrity
    const computedFingerprint = await computeFingerprint(ecdsa, ecdh);

    if (fingerprint && fingerprint !== computedFingerprint) {
      return {
        valid: false,
        error: 'Fingerprint mismatch: The payload fingerprint does not match computed public key digest.',
      };
    }

    return {
      valid: true,
      peerIdentity: {
        protocol: protocol || 'covert-chatter',
        version: version || 1,
        room: parsed.room || null,
        ecdsa,
        ecdh,
        fingerprint: computedFingerprint,
        verifiedAt: Date.now(),
      },
    };
  } catch (err) {
    return { valid: false, error: `Failed to parse peer identity: ${err.message}` };
  }
}

/**
 * Step 6: Derive a symmetric AES-GCM 256-bit session key using ECDH key agreement.
 * 
 * 🎓 How Elliptic-Curve Diffie-Hellman (ECDH) Works:
 * ----------------------------------------------------
 * - Alice has a private scalar `a` and public curve point `A = a * G`.
 * - Bob has a private scalar `b` and public curve point `B = b * G`.
 * - When Alice multiplies her private scalar `a` by Bob's public point `B`:
 *     Shared Point = a * (b * G) = (a * b) * G
 * - When Bob multiplies his private scalar `b` by Alice's public point `A`:
 *     Shared Point = b * (a * G) = (a * b) * G
 * - Both Alice and Bob arrive at the exact same shared curve point without
 *   ever transmitting their private keys across the wire!
 * - Web Crypto uses this shared point as entropy to derive a symmetric
 *   AES-GCM 256-bit CryptoKey.
 * 
 * 🔒 Security: The derived AES-GCM key is also marked non-extractable
 * (`extractable = false`) so raw session key bytes cannot be extracted by scripts.
 * 
 * @param {CryptoKey} myEcdhPrivateKey - Local non-extractable ECDH private key
 * @param {JsonWebKey} peerEcdhPublicKeyJWK - Remote peer's public ECDH JWK
 * @returns {Promise<CryptoKey>} Non-extractable AES-GCM 256-bit CryptoKey
 */
export async function deriveSharedSecret(myEcdhPrivateKey, peerEcdhPublicKeyJWK) {
  if (!window.crypto || !window.crypto.subtle) {
    throw new Error('Web Crypto API (crypto.subtle) is not supported in this environment.');
  }

  // 1. Import the peer's public ECDH key from raw JWK format into a CryptoKey object
  const peerPublicKey = await window.crypto.subtle.importKey(
    'jwk',
    peerEcdhPublicKeyJWK,
    {
      name: 'ECDH',
      namedCurve: 'P-256',
    },
    true, // Public key is extractable/importable
    [] // No direct operations on the external public key (it acts as peer input to deriveKey)
  );

  // 2. Perform ECDH Diffie-Hellman derivation to produce an AES-256-GCM symmetric key
  const derivedSessionKey = await window.crypto.subtle.deriveKey(
    {
      name: 'ECDH',
      public: peerPublicKey, // Peer's public point (B)
    },
    myEcdhPrivateKey, // Local private scalar (a)
    {
      name: 'AES-GCM',
      length: 256, // 256-bit symmetric encryption key
    },
    false, // extractable: false -> Non-extractable session key in browser keystore
    ['encrypt', 'decrypt'] // Operations permitted with derived symmetric key
  );

  return derivedSessionKey;
}

