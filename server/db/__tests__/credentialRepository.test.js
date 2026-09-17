import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  isMysqlAvailable,
  loadDbModules,
  restoreEnv,
  truncateAll,
} from '../../test/dbTestHelper.js';

/**
 * The credential repository against a real MySQL schema.
 *
 * What matters here is behaviour the database owns: the unique key per owner+tool,
 * the cascade from owners, and — the security point of the whole task — that the
 * token columns hold ciphertext, not the token. A fake would prove none of it.
 *
 * Skips when no MySQL is reachable (see dbTestHelper), and uses its OWN schema so
 * it can run in parallel with the other DB suites without cross-truncation.
 */

const originalEnv = { ...process.env };
const mysqlAvailable = await isMysqlAvailable();

let pool;
let credentials;
let queryRaw;

const OWNER = 'operator';

beforeAll(async () => {
  if (!mysqlAvailable) {
    console.warn('[credentialRepository.test] MySQL not reachable — skipping');
    return;
  }
  const modules = await loadDbModules(vi, {
    DB_NAME: `${process.env.TEST_DB_NAME ?? 'autoagent_test'}_cred`,
  });
  pool = modules.pool;
  credentials = modules.credentials;
  queryRaw = (sql, params) => pool.getPool().query(sql, params);
});

afterEach(async () => {
  if (mysqlAvailable && pool) await truncateAll(pool);
});

afterAll(async () => {
  if (mysqlAvailable && pool) await pool.closePool();
  restoreEnv(originalEnv);
});

describe.skipIf(!mysqlAvailable)('credentialRepository', () => {
  it('round-trips a credential through encryption', async () => {
    await credentials.saveCredential({
      ownerId: OWNER,
      toolId: 'gmail',
      provider: 'google',
      accessToken: 'access-token-value',
      refreshToken: 'refresh-token-value',
      expiresAt: Date.now() + 3_600_000,
      scopes: ['https://www.googleapis.com/auth/gmail.send'],
    });

    const read = await credentials.readCredential(OWNER, 'gmail');
    expect(read.accessToken).toBe('access-token-value');
    expect(read.refreshToken).toBe('refresh-token-value');
    expect(read.scopes).toEqual(['https://www.googleapis.com/auth/gmail.send']);
  });

  it('stores the tokens as ciphertext, not plaintext', async () => {
    await credentials.saveCredential({
      ownerId: OWNER,
      toolId: 'gmail',
      provider: 'google',
      accessToken: 'PLAINTEXT-ACCESS',
      refreshToken: 'PLAINTEXT-REFRESH',
      expiresAt: null,
      scopes: [],
    });

    // Read the raw column. This is the assertion the whole task exists for: a
    // database dump must not contain a usable Google token.
    const [rows] = await queryRaw(
      'SELECT access_token_enc, refresh_token_enc FROM tool_credentials WHERE owner_id = ? AND tool_id = ?',
      [OWNER, 'gmail'],
    );
    expect(rows[0].access_token_enc).not.toContain('PLAINTEXT-ACCESS');
    expect(rows[0].refresh_token_enc).not.toContain('PLAINTEXT-REFRESH');
    expect(rows[0].access_token_enc).toMatch(/^v1\./);
  });

  it('keeps the existing refresh token when a re-consent omits one', async () => {
    await credentials.saveCredential({
      ownerId: OWNER,
      toolId: 'gmail',
      provider: 'google',
      accessToken: 'first-access',
      refreshToken: 'the-only-refresh-token',
      expiresAt: null,
      scopes: [],
    });

    // Google issues a refresh token only on first authorisation; a later
    // consent returns none. Discarding the stored one would break renewal.
    await credentials.saveCredential({
      ownerId: OWNER,
      toolId: 'gmail',
      provider: 'google',
      accessToken: 'second-access',
      refreshToken: null,
      expiresAt: null,
      scopes: [],
    });

    const read = await credentials.readCredential(OWNER, 'gmail');
    expect(read.accessToken).toBe('second-access');
    expect(read.refreshToken).toBe('the-only-refresh-token');
  });

  it('updates only the access token on refresh', async () => {
    await credentials.saveCredential({
      ownerId: OWNER,
      toolId: 'gmail',
      provider: 'google',
      accessToken: 'old',
      refreshToken: 'keep-me',
      expiresAt: Date.now(),
      scopes: [],
    });

    await credentials.updateAccessToken({
      ownerId: OWNER,
      toolId: 'gmail',
      accessToken: 'new',
      expiresAt: Date.now() + 3_600_000,
    });

    const read = await credentials.readCredential(OWNER, 'gmail');
    expect(read.accessToken).toBe('new');
    expect(read.refreshToken).toBe('keep-me');
  });

  it('is one row per owner and tool', async () => {
    for (const toolId of ['gmail', 'google_sheets', 'gmail']) {
      await credentials.saveCredential({
        ownerId: OWNER,
        toolId,
        provider: 'google',
        accessToken: `token-for-${toolId}`,
        refreshToken: null,
        expiresAt: null,
        scopes: [],
      });
    }

    const [rows] = await queryRaw('SELECT tool_id FROM tool_credentials WHERE owner_id = ?', [
      OWNER,
    ]);
    // gmail was written twice; it must be one row, upserted.
    expect(rows).toHaveLength(2);
  });

  it('lists connections without any token material', async () => {
    await credentials.saveCredential({
      ownerId: OWNER,
      toolId: 'gmail',
      provider: 'google',
      accessToken: 'SECRET-ACCESS',
      refreshToken: 'SECRET-REFRESH',
      expiresAt: Date.now() + 1000,
      scopes: ['s'],
    });

    const connections = await credentials.listConnections(OWNER);
    expect(connections).toHaveLength(1);

    // This is what the browser receives, so it must carry no token at all.
    const serialised = JSON.stringify(connections);
    expect(serialised).not.toContain('SECRET-ACCESS');
    expect(serialised).not.toContain('SECRET-REFRESH');
    expect(connections[0]).toMatchObject({ toolId: 'gmail', provider: 'google', connected: true });
    expect(connections[0].scopes).toEqual(['s']);
  });

  it('deletes a credential and reports whether a row went', async () => {
    await credentials.saveCredential({
      ownerId: OWNER,
      toolId: 'gmail',
      provider: 'google',
      accessToken: 'a',
      refreshToken: null,
      expiresAt: null,
      scopes: [],
    });

    expect(await credentials.deleteCredential(OWNER, 'gmail')).toBe(true);
    expect(await credentials.readCredential(OWNER, 'gmail')).toBeNull();
    // Deleting again is a no-op.
    expect(await credentials.deleteCredential(OWNER, 'gmail')).toBe(false);
  });

  it('cascades when the owner is removed', async () => {
    await credentials.saveCredential({
      ownerId: OWNER,
      toolId: 'gmail',
      provider: 'google',
      accessToken: 'a',
      refreshToken: null,
      expiresAt: null,
      scopes: [],
    });

    await queryRaw('DELETE FROM owners WHERE id = ?', [OWNER]);
    const [rows] = await queryRaw('SELECT tool_id FROM tool_credentials WHERE owner_id = ?', [
      OWNER,
    ]);
    expect(rows).toHaveLength(0);
  });
});
