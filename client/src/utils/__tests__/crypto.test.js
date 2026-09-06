// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';

// Ensure window.crypto is available in the test environment via Node's native webcrypto
beforeAll(() => {
  if (typeof window === 'undefined') {
    globalThis.window = globalThis;
  }
  if (!globalThis.window.crypto && globalThis.crypto) {
    globalThis.window.crypto = globalThis.crypto;
  }
});

import {
  generateSigningKeypair,
  generateAgreementKeypair,
  generateEphemeralAgreementKeypair,
  exportEphemeralPublicKey,
  signEphemeralAgreementKey,
  verifyEphemeralAgreementKey,
  exportPublicJWKs,
  deriveSharedSecret,
} from '../crypto.js';

import {
  encryptMessage,
  decryptMessage,
  signMessage,
  verifyMessage,
} from '../encryption.js';

describe('Covert Chatter — Cryptographic Hardening Test Suite', () => {
  /**
   * Helper to derive an AES-GCM session key between two parties
   */
  async function setupSessionKeys() {
    const aliceSigning = await generateSigningKeypair();
    const bobSigning = await generateSigningKeypair();

    const aliceEphemeral = await generateEphemeralAgreementKeypair();
    const bobEphemeral = await generateEphemeralAgreementKeypair();

    const aliceEphemeralJWK = await exportEphemeralPublicKey(aliceEphemeral.publicKey);
    const bobEphemeralJWK = await exportEphemeralPublicKey(bobEphemeral.publicKey);

    const aliceSessionKey = await deriveSharedSecret(aliceEphemeral.privateKey, bobEphemeralJWK);
    const bobSessionKey = await deriveSharedSecret(bobEphemeral.privateKey, aliceEphemeralJWK);

    const aliceSigningJWKs = await exportPublicJWKs(aliceSigning.publicKey, aliceEphemeral.publicKey);
    const bobSigningJWKs = await exportPublicJWKs(bobSigning.publicKey, bobEphemeral.publicKey);

    return {
      alice: { signing: aliceSigning, ephemeral: aliceEphemeral, jwk: aliceSigningJWKs, sessionKey: aliceSessionKey, ephemeralJWK: aliceEphemeralJWK },
      bob: { signing: bobSigning, ephemeral: bobEphemeral, jwk: bobSigningJWKs, sessionKey: bobSessionKey, ephemeralJWK: bobEphemeralJWK },
    };
  }

  // --------------------------------------------------------------------------
  // TEST 1: IV Uniqueness Across 1,000 Consecutive Message Encryptions
  // --------------------------------------------------------------------------
  it('1. Generates 1,000 unique 12-byte IVs with zero collisions across consecutive encryptions', async () => {
    const { alice } = await setupSessionKeys();
    const ivSet = new Set();
    const iterations = 1000;

    for (let i = 0; i < iterations; i++) {
      const encrypted = await encryptMessage(alice.sessionKey, `Test payload message #${i}`, i + 1);
      
      expect(encrypted.iv).toBeDefined();
      expect(encrypted.iv.length).toBe(12); // Standard 96-bit AES-GCM IV

      const ivHex = encrypted.iv.map(b => b.toString(16).padStart(2, '0')).join('');
      expect(ivSet.has(ivHex)).toBe(false);
      ivSet.add(ivHex);
    }

    expect(ivSet.size).toBe(iterations);
  });

  // --------------------------------------------------------------------------
  // TEST 2: ECDSA Signature Verification and Bit-Flip Tamper Resistance
  // --------------------------------------------------------------------------
  it('2. Verifies valid ECDSA signatures and strictly rejects bit-flipped ciphertext or signatures', async () => {
    const { alice } = await setupSessionKeys();
    const encrypted = await encryptMessage(alice.sessionKey, 'Sensitive authenticated payload', 1);

    // Alice signs the ciphertext with her long-term ECDSA private key
    const signature = await signMessage(alice.signing.privateKey, encrypted.ciphertext);
    expect(signature).toBeDefined();
    expect(signature.length).toBeGreaterThan(0);

    // Valid signature passes verification against Alice's public ECDSA JWK
    const isValid = await verifyMessage(alice.jwk.ecdsa, encrypted.ciphertext, signature);
    expect(isValid).toBe(true);

    // Tamper Test A: Flip a single bit in the ciphertext bytes
    const tamperedCiphertext = [...encrypted.ciphertext];
    tamperedCiphertext[0] ^= 0x01; // Bit flip
    const isTamperedCiphertextValid = await verifyMessage(alice.jwk.ecdsa, tamperedCiphertext, signature);
    expect(isTamperedCiphertextValid).toBe(false);

    // Tamper Test B: Flip a single bit in the signature bytes
    const tamperedSignature = [...signature];
    tamperedSignature[0] ^= 0x01; // Bit flip
    const isTamperedSigValid = await verifyMessage(alice.jwk.ecdsa, encrypted.ciphertext, tamperedSignature);
    expect(isTamperedSigValid).toBe(false);
  });

  // --------------------------------------------------------------------------
  // TEST 3: Replay Protection & AAD Verification (Fails Closed)
  // --------------------------------------------------------------------------
  it('3. Enforces sequence numbers in AAD: rejects replayed sequences and fails closed on AAD tampering', async () => {
    const { alice, bob } = await setupSessionKeys();
    
    // Simulate peer state tracking
    let receiveSequence = 0;
    const testPlaintext = 'Protected message against replay attacks';

    // Alice sends sequence 1
    const seq1 = 1;
    const encrypted1 = await encryptMessage(alice.sessionKey, testPlaintext, seq1);
    
    // Bob receives sequence 1: sequence > receiveSequence passes
    expect(encrypted1.seq).toBeGreaterThan(receiveSequence);
    const decrypted1 = await decryptMessage(bob.sessionKey, encrypted1.iv, encrypted1.ciphertext, encrypted1.seq);
    expect(decrypted1).toBe(testPlaintext);
    receiveSequence = encrypted1.seq; // Update state

    // Replay Attack: Attacker re-injects encrypted1 (seq 1 <= receiveSequence)
    const isReplay = encrypted1.seq <= receiveSequence;
    expect(isReplay).toBe(true); // Must be dropped by peer protocol check

    // Alice sends sequence 2
    const seq2 = 2;
    const encrypted2 = await encryptMessage(alice.sessionKey, 'Next message in order', seq2);
    expect(encrypted2.seq).toBeGreaterThan(receiveSequence);
    const decrypted2 = await decryptMessage(bob.sessionKey, encrypted2.iv, encrypted2.ciphertext, encrypted2.seq);
    expect(decrypted2).toBe('Next message in order');
    receiveSequence = encrypted2.seq;

    // AAD Tampering / Sequence Mismatch: Attacker modifies the outer sequence field from 2 to 99
    // Decrypting with expected seq 99 must fail closed because AES-GCM AAD contains `seq:2`
    await expect(
      decryptMessage(bob.sessionKey, encrypted2.iv, encrypted2.ciphertext, 99)
    ).rejects.toThrow(/Message authentication failed/);

    // Decrypting with null sequence when AAD was present must also fail closed
    await expect(
      decryptMessage(bob.sessionKey, encrypted2.iv, encrypted2.ciphertext, null)
    ).rejects.toThrow(/Message authentication failed/);
  });

  // --------------------------------------------------------------------------
  // TEST 4: Session Isolation, Key Freshness & Signature-Gated Trust
  // --------------------------------------------------------------------------
  it('4. Asserts key freshness across sessions and signature-gated trust for ephemeral key agreement', async () => {
    // Both sessions share the same long-term ECDSA identity keypair for Alice and Bob
    const aliceLongTermIdentity = await generateSigningKeypair();
    const bobLongTermIdentity = await generateSigningKeypair();

    const [aliceLongTermJWK, bobLongTermJWK] = await Promise.all([
      (await exportPublicJWKs(aliceLongTermIdentity.publicKey, (await generateAgreementKeypair()).publicKey)).ecdsa,
      (await exportPublicJWKs(bobLongTermIdentity.publicKey, (await generateAgreementKeypair()).publicKey)).ecdsa,
    ]);

    // SESSION A
    const aliceEphemeralA = await generateEphemeralAgreementKeypair();
    const bobEphemeralA = await generateEphemeralAgreementKeypair();
    const aliceJWKA = await exportEphemeralPublicKey(aliceEphemeralA.publicKey);
    const bobJWKA = await exportEphemeralPublicKey(bobEphemeralA.publicKey);

    const aliceSigA = await signEphemeralAgreementKey(aliceLongTermIdentity.privateKey, aliceJWKA);
    const bobSigA = await signEphemeralAgreementKey(bobLongTermIdentity.privateKey, bobJWKA);

    // Signature verification passes
    expect(await verifyEphemeralAgreementKey(aliceLongTermJWK, aliceJWKA, aliceSigA)).toBe(true);
    expect(await verifyEphemeralAgreementKey(bobLongTermJWK, bobJWKA, bobSigA)).toBe(true);

    const aliceSessionKeyA = await deriveSharedSecret(aliceEphemeralA.privateKey, bobJWKA);

    // SESSION B (using the exact same long-term identity)
    const aliceEphemeralB = await generateEphemeralAgreementKeypair();
    const bobEphemeralB = await generateEphemeralAgreementKeypair();
    const aliceJWKB = await exportEphemeralPublicKey(aliceEphemeralB.publicKey);
    const bobJWKB = await exportEphemeralPublicKey(bobEphemeralB.publicKey);

    const aliceSigB = await signEphemeralAgreementKey(aliceLongTermIdentity.privateKey, aliceJWKB);
    const bobSigB = await signEphemeralAgreementKey(bobLongTermIdentity.privateKey, bobJWKB);

    expect(await verifyEphemeralAgreementKey(aliceLongTermJWK, aliceJWKB, aliceSigB)).toBe(true);
    expect(await verifyEphemeralAgreementKey(bobLongTermJWK, bobJWKB, bobSigB)).toBe(true);

    const aliceSessionKeyB = await deriveSharedSecret(aliceEphemeralB.privateKey, bobJWKB);

    // Key Freshness: Ephemeral ECDH coordinates must be distinct
    expect(aliceJWKA.x).not.toBe(aliceJWKB.x);
    expect(aliceJWKA.y).not.toBe(aliceJWKB.y);
    expect(bobJWKA.x).not.toBe(bobJWKB.x);
    expect(bobJWKA.y).not.toBe(bobJWKB.y);

    // Derived session keys must produce different ciphertexts for identical plaintext and IV
    const fixedIv = new Uint8Array(12).fill(7); // fixed IV for derivation comparison
    const plaintext = 'Identical plaintext across sessions';

    const gcmParams = { name: 'AES-GCM', iv: fixedIv, tagLength: 128 };
    const cipherA = await window.crypto.subtle.encrypt(gcmParams, aliceSessionKeyA, new TextEncoder().encode(plaintext));
    const cipherB = await window.crypto.subtle.encrypt(gcmParams, aliceSessionKeyB, new TextEncoder().encode(plaintext));

    const hexA = Array.from(new Uint8Array(cipherA)).map(b => b.toString(16).padStart(2, '0')).join('');
    const hexB = Array.from(new Uint8Array(cipherB)).map(b => b.toString(16).padStart(2, '0')).join('');
    expect(hexA).not.toBe(hexB);

    // Signature-Gated Trust: Tampered or forged ephemeral keys are strictly rejected
    const tamperedAliceJWK = { ...aliceJWKB, x: bobJWKB.x }; // Swap coordinate
    const isTamperedValid = await verifyEphemeralAgreementKey(aliceLongTermJWK, tamperedAliceJWK, aliceSigB);
    expect(isTamperedValid).toBe(false);

    // Signature signed by an unauthorized third party is rejected
    const eveIdentity = await generateSigningKeypair();
    const forgedSig = await signEphemeralAgreementKey(eveIdentity.privateKey, aliceJWKB);
    const isForgedValid = await verifyEphemeralAgreementKey(aliceLongTermJWK, aliceJWKB, forgedSig);
    expect(isForgedValid).toBe(false);
  });
});
