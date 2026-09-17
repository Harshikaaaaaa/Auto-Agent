import crypto from 'node:crypto';
import { env } from '../config/env.js';

/**
 * Encryption for stored OAuth tokens.
 *
 * The tokens this protects used to live in the browser's localStorage in plain
 * text, readable by any script on the page and by anyone with the device. Moving
 * them to the database fixes that, but a database dump or a stray backup would
 * then contain live Google credentials, so they are encrypted at rest with a key
 * that lives only in the environment.
 *
 * AES-256-GCM: authenticated, so a tampered ciphertext fails to decrypt rather
 * than silently yielding garbage that gets sent to Google as a bearer token.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // 96-bit nonce, the size GCM is specified for
const KEY_BYTES = 32;
/** Bumped if the scheme ever changes, so old rows can be recognised. */
const VERSION = 'v1';

let cachedKey;

/**
 * Derive the 32-byte key from CREDENTIAL_SECRET.
 *
 * scrypt rather than using the secret directly: the secret is a human-supplied
 * string of arbitrary length, and this turns any of them into a uniform key
 * without requiring the operator to generate exact key material. The salt is
 * fixed because the same secret must produce the same key on every process and
 * every replica — this is key derivation, not password hashing.
 */
function key() {
    if (!cachedKey) {
        cachedKey = crypto.scryptSync(env.CREDENTIAL_SECRET, 'autoagent:credentials:v1', KEY_BYTES);
    }
    return cachedKey;
}

/** For tests that change the secret between cases. */
export function resetKeyCache() {
    cachedKey = undefined;
}

/**
 * Encrypt a token.
 * @returns `v1.<iv>.<tag>.<ciphertext>`, all base64url.
 */
export function encryptSecret(plaintext) {
    if (typeof plaintext !== 'string' || plaintext.length === 0) {
        throw new Error('encryptSecret requires a non-empty string');
    }

    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv(ALGORITHM, key(), iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    return [
        VERSION,
        iv.toString('base64url'),
        tag.toString('base64url'),
        ciphertext.toString('base64url'),
    ].join('.');
}

/**
 * Decrypt a token produced by `encryptSecret`.
 * @throws when the payload is malformed, or the key or ciphertext is wrong.
 */
export function decryptSecret(payload) {
    if (typeof payload !== 'string') throw new Error('decryptSecret requires a string');

    const parts = payload.split('.');
    if (parts.length !== 4 || parts[0] !== VERSION) {
        throw new Error('stored credential is not in a recognised format');
    }

    const [, ivPart, tagPart, dataPart] = parts;
    const decipher = crypto.createDecipheriv(
        ALGORITHM,
        key(),
        Buffer.from(ivPart, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));

    return Buffer.concat([
        decipher.update(Buffer.from(dataPart, 'base64url')),
        decipher.final(),
    ]).toString('utf8');
}
