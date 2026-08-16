/**
 * Covert Chatter — Persistent Identity Storage Module (IndexedDB)
 * 
 * Storage Architecture:
 * - Database Name: "covert_chatter_identity" (with auto-migration from "whisper_drop_identity")
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

const DB_NAME = 'covert_chatter_identity';
const LEGACY_DB_NAME = 'whisper_drop_identity';
const DB_VERSION = 1;
const STORE_NAME = 'key_store';
const IDENTITY_RECORD_ID = 'primary_identity';

export const BROWSER_SUPPORT_ERROR_MSG =
  "Your browser doesn't support secure key storage — please use a recent version of Chrome, Firefox, or Edge.";

/**
 * Open or upgrade the IndexedDB database instance.
 * @param {string} [name=DB_NAME]
 * @returns {Promise<IDBDatabase>}
 */
function openDB(name = DB_NAME) {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error(BROWSER_SUPPORT_ERROR_MSG));
      return;
    }

    const request = indexedDB.open(name, DB_VERSION);

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
 * Helper to check legacy database for existing identity to migrate.
 * @returns {Promise<object|null>}
 */
async function checkLegacyIdentity() {
  try {
    const db = await openDB(LEGACY_DB_NAME);
    return await new Promise((resolve) => {
      try {
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          resolve(null);
          return;
        }
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const request = store.get(IDENTITY_RECORD_ID);

        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  } catch {
    return null;
  }
}

/**
 * Retrieve the existing persistent identity from IndexedDB.
 * Performs automatic one-time migration from legacy whisper_drop_identity if present.
 * 
 * @returns {Promise<object|null>}
 */
export async function getStoredIdentity() {
  try {
    const db = await openDB(DB_NAME);
    const existing = await new Promise((resolve, reject) => {
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

    if (existing) {
      return existing;
    }

    // Check for legacy identity migration
    const legacyIdentity = await checkLegacyIdentity();
    if (legacyIdentity && legacyIdentity.signingKeyPair && legacyIdentity.agreementKeyPair) {
      console.log('[Covert Chatter Migration] Migrating legacy identity to covert_chatter_identity...');
      await saveIdentity(legacyIdentity);
      return legacyIdentity;
    }

    return null;
  } catch (err) {
    console.error('[IndexedDB] Error loading identity:', err);
    throw new Error(BROWSER_SUPPORT_ERROR_MSG);
  }
}

/**
 * Store an identity record into IndexedDB.
 * 
 * @param {object} identityData
 * @returns {Promise<object>}
 */
export async function saveIdentity(identityData) {
  try {
    const db = await openDB(DB_NAME);
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
    const db = await openDB(DB_NAME);
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
