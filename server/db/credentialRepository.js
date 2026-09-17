import { getPool } from './pool.js';
import { decryptSecret, encryptSecret } from '../lib/credentialCrypto.js';

/**
 * Storage for connected-tool OAuth credentials.
 *
 * Tokens go in and out of this module encrypted; nothing above it ever sees
 * ciphertext, and nothing below it ever sees a token. The only function that
 * returns a usable access token is `readCredential`, and it is called solely by
 * the server-side Google proxy.
 */

function toIsoString(value) {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Ensure the owner row exists, so the credential's foreign key holds. */
async function ensureOwner(ownerId) {
    await getPool().query(
        'INSERT INTO owners (id, created_at) VALUES (?, ?) ON DUPLICATE KEY UPDATE id = id',
        [ownerId, new Date()],
    );
}

/**
 * Store or replace the credential for one owner + tool.
 *
 * A re-consent that returns no refresh token keeps the one already stored:
 * Google only issues a refresh token on the first authorisation for a client,
 * and discarding it would leave the connection unable to refresh and force the
 * user back through consent every hour.
 */
export async function saveCredential({
    ownerId,
    toolId,
    provider,
    accessToken,
    refreshToken,
    expiresAt,
    scopes,
}) {
    if (!ownerId || !toolId) throw new Error('saveCredential requires ownerId and toolId');
    if (!accessToken) throw new Error('saveCredential requires an accessToken');

    await ensureOwner(ownerId);

    const now = new Date();
    const encryptedRefresh = refreshToken ? encryptSecret(refreshToken) : null;

    await getPool().query(
        `INSERT INTO tool_credentials
           (owner_id, tool_id, provider, access_token_enc, refresh_token_enc,
            expires_at, scopes, connected_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           provider          = VALUES(provider),
           access_token_enc  = VALUES(access_token_enc),
           refresh_token_enc = COALESCE(VALUES(refresh_token_enc), refresh_token_enc),
           expires_at        = VALUES(expires_at),
           scopes            = VALUES(scopes),
           updated_at        = VALUES(updated_at)`,
        [
            ownerId,
            toolId,
            provider,
            encryptSecret(accessToken),
            encryptedRefresh,
            expiresAt ? new Date(expiresAt) : null,
            JSON.stringify(Array.isArray(scopes) ? scopes : []),
            now,
            now,
        ],
    );
}

/**
 * The decrypted credential, or null when the tool is not connected.
 *
 * SERVER ONLY. The returned object contains live tokens and must never be put in
 * an HTTP response.
 */
export async function readCredential(ownerId, toolId) {
    const [rows] = await getPool().query(
        `SELECT provider, access_token_enc, refresh_token_enc, expires_at, scopes
           FROM tool_credentials
          WHERE owner_id = ? AND tool_id = ?`,
        [ownerId, toolId],
    );

    const row = rows[0];
    if (!row) return null;

    return {
        provider: row.provider,
        accessToken: decryptSecret(row.access_token_enc),
        refreshToken: row.refresh_token_enc ? decryptSecret(row.refresh_token_enc) : null,
        expiresAt: row.expires_at ? new Date(row.expires_at).getTime() : null,
        scopes: Array.isArray(row.scopes) ? row.scopes : JSON.parse(row.scopes ?? '[]'),
    };
}

/**
 * Connection state for the UI: which tools are connected, since when, with what
 * scopes. Deliberately returns NO token material — this is what the browser sees.
 */
export async function listConnections(ownerId) {
    const [rows] = await getPool().query(
        `SELECT tool_id, provider, expires_at, scopes, connected_at, updated_at
           FROM tool_credentials
          WHERE owner_id = ?
          ORDER BY tool_id`,
        [ownerId],
    );

    return rows.map((row) => ({
        toolId: row.tool_id,
        provider: row.provider,
        connected: true,
        /** When the ACCESS token expires. A connection with a refresh token
         *  survives this, so the UI must not treat it as disconnected. */
        expiresAt: toIsoString(row.expires_at),
        scopes: Array.isArray(row.scopes) ? row.scopes : JSON.parse(row.scopes ?? '[]'),
        connectedAt: toIsoString(row.connected_at),
        updatedAt: toIsoString(row.updated_at),
    }));
}

/** Remove a credential. Returns true when a row was actually deleted. */
export async function deleteCredential(ownerId, toolId) {
    const [result] = await getPool().query(
        'DELETE FROM tool_credentials WHERE owner_id = ? AND tool_id = ?',
        [ownerId, toolId],
    );
    return result.affectedRows > 0;
}

/** Replace just the access token after a refresh, keeping the refresh token. */
export async function updateAccessToken({ ownerId, toolId, accessToken, expiresAt }) {
    await getPool().query(
        `UPDATE tool_credentials
            SET access_token_enc = ?, expires_at = ?, updated_at = ?
          WHERE owner_id = ? AND tool_id = ?`,
        [
            encryptSecret(accessToken),
            expiresAt ? new Date(expiresAt) : null,
            new Date(),
            ownerId,
            toolId,
        ],
    );
}
