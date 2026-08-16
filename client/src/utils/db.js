/**
 * Whisper Drop — Persistent Identity Storage Module (IndexedDB)
 * 
 * Storage Architecture:
 * - Database Name: "whisper_drop_identity"
 * - Store Name: "key_store"
 * - Stored Items:
 *   - Non-extractable ECDSA CryptoKeyPair (Signing)
 *   - Non-extractable ECDH CryptoKeyPair (Key Agreement)
 *   - Exported public JWKs
 *   - SHA-256 fingerprint & creation timestamp
 * 
 * Privacy & Separation of Concerns:
 * - This database is strictly dedicated to persistent cryptographic identity.
 * - It is isolated from ephemeral chat logs, message caches, or room states.
 * - Non-extractable CryptoKey objects are stored using the Structured Clone Algorithm.
 */

import { generateFullIdentity } from './crypto';

const DB_NAME = 'whisper_drop_identity';
const DB_VERSION = 1;
const STORE_NAME = 'key_store';
const IDENTITY_RECORD_ID = 'primary_identity';

export const BROWSER_SUPPORT_ERROR_MSG =
  "Your browser doesn't support secure key storage — please use a recent version of Chrome, Firefox, or Edge.";

/**
 * Open or upgrade the IndexedDB database instance.
 * @returns {Promise<IDBDatabase>}
 */
function openDB() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error(BROWSER_SUPPORT_ERROR_MSG));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };

    request.onsuccess = (event) => {
      resolve(event.target.result);
    };

    request.onerror = () => {
      reject(new Error(BROWSER_SUPPORT_ERROR_MSG));
    };
  });
}

/**
 * Retrieve the existing persistent identity from IndexedDB.
 * Returns null if no identity has been created yet.
 * 
 * @returns {Promise<object|null>}
 */
export async function getStoredIdentity() {
  try {
    const db = await openDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.get(IDENTITY_RECORD_ID);

      request.onsuccess = () => {
        resolve(request.result || null);
      };

      request.onerror = () => {
        reject(new Error(BROWSER_SUPPORT_ERROR_MSG));
      };
    });
  } catch (err) {
    console.error('[IndexedDB] Error loading identity:', err);
    throw new Error(BROWSER_SUPPORT_ERROR_MSG);
  }
}

/**
 * Store a newly generated identity record into IndexedDB.
 * 
 * @param {object} identityData
 * @returns {Promise<void>}
 */
export async function saveIdentity(identityData) {
  try {
    const db = await openDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);

      const record = {
        id: IDENTITY_RECORD_ID,
        signingKeyPair: identityData.signingKeyPair,
        agreementKeyPair: identityData.agreementKeyPair,
        publicJWKs: identityData.publicJWKs,
        fingerprint: identityData.fingerprint,
        createdAt: identityData.createdAt || Date.now(),
      };

      const request = store.put(record);

      request.onsuccess = () => {
        resolve(record);
      };

      request.onerror = (e) => {
        console.error('[IndexedDB] Put error:', e);
        reject(new Error(BROWSER_SUPPORT_ERROR_MSG));
      };

      tx.onerror = (e) => {
        console.error('[IndexedDB] Transaction error:', e);
        reject(new Error(BROWSER_SUPPORT_ERROR_MSG));
      };
    });
  } catch (err) {
    console.error('[IndexedDB] Error saving identity:', err);
    throw new Error(BROWSER_SUPPORT_ERROR_MSG);
  }
}

/**
 * Load existing identity if present, or generate and persist a fresh identity.
 * Handles structured clone verification for CryptoKey objects.
 * 
 * @returns {Promise<{
 *   identity: object,
 *   isNew: boolean
 * }>}
 */
export async function getOrCreateIdentity() {
  try {
    const existing = await getStoredIdentity();
    if (existing && existing.signingKeyPair && existing.agreementKeyPair) {
      return { identity: existing, isNew: false };
    }

    // Generate fresh cryptographic identity
    const newIdentity = await generateFullIdentity();
    const saved = await saveIdentity(newIdentity);
    return { identity: saved, isNew: true };
  } catch (err) {
    console.error('[Identity DB] Failed to get or create identity:', err);
    throw new Error(BROWSER_SUPPORT_ERROR_MSG);
  }
}

/**
 * Explicit manual identity reset.
 * Purges the persistent database record and generates a brand-new identity.
 * 
 * @returns {Promise<object>} New identity record
 */
export async function resetIdentity() {
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.delete(IDENTITY_RECORD_ID);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(new Error(BROWSER_SUPPORT_ERROR_MSG));
    });

    // Generate and persist brand new keypairs
    const freshIdentity = await generateFullIdentity();
    return await saveIdentity(freshIdentity);
  } catch (err) {
    console.error('[Identity DB] Reset error:', err);
    throw new Error(BROWSER_SUPPORT_ERROR_MSG);
  }
}
