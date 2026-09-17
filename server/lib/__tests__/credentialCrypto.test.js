import { afterEach, describe, expect, it } from 'vitest';

/**
 * credentialCrypto encrypts OAuth tokens at rest. The tokens used to sit in the
 * browser's localStorage in plain text; the point of this module is that a
 * database dump now contains ciphertext no one can use.
 *
 * The env module reads process.env at import time, so each case that needs a
 * particular CREDENTIAL_SECRET sets it and imports the module fresh with a reset
 * module registry.
 */

const BASE_ENV = {
  AUTOAGENT_SKIP_ENV_FILES: '1',
  AUTH_ENABLED: 'false',
  CREDENTIAL_SECRET: 'unit-test-credential-secret-value-32chars-min',
};

async function loadCrypto(overrides = {}) {
  vi.resetModules();
  for (const [key, value] of Object.entries({ ...BASE_ENV, ...overrides })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return import('../credentialCrypto.js');
}

afterEach(() => {
  for (const key of Object.keys(BASE_ENV)) delete process.env[key];
});

describe('encrypt / decrypt round trip', () => {
  it('recovers the original token', async () => {
    const { encryptSecret, decryptSecret } = await loadCrypto();
    const token = 'ya29.a0AfB_byC-not-a-real-token-'.repeat(4);

    const sealed = encryptSecret(token);
    expect(decryptSecret(sealed)).toBe(token);
  });

  it('does not leak the plaintext into the ciphertext', async () => {
    const { encryptSecret } = await loadCrypto();
    const token = 'super-secret-refresh-token';

    expect(encryptSecret(token)).not.toContain(token);
  });

  it('produces a different ciphertext each time (random IV)', async () => {
    const { encryptSecret, decryptSecret } = await loadCrypto();

    const a = encryptSecret('same-token');
    const b = encryptSecret('same-token');
    expect(a).not.toBe(b);
    // Both still decrypt to the same plaintext.
    expect(decryptSecret(a)).toBe('same-token');
    expect(decryptSecret(b)).toBe('same-token');
  });

  it('tags the payload with a version', async () => {
    const { encryptSecret } = await loadCrypto();
    expect(encryptSecret('x')).toMatch(/^v1\./);
  });

  it('handles a long token and unicode', async () => {
    const { encryptSecret, decryptSecret } = await loadCrypto();
    const token = 'tok-📮-'.repeat(2000);
    expect(decryptSecret(encryptSecret(token))).toBe(token);
  });
});

describe('rejects tampering and misuse', () => {
  it('refuses an empty plaintext', async () => {
    const { encryptSecret } = await loadCrypto();
    expect(() => encryptSecret('')).toThrow();
  });

  it('rejects a payload that is not in the expected format', async () => {
    const { decryptSecret } = await loadCrypto();
    expect(() => decryptSecret('not-a-payload')).toThrow(/recognised format/);
    expect(() => decryptSecret('v2.a.b.c')).toThrow(/recognised format/);
  });

  it('fails to decrypt when a byte is flipped (GCM auth)', async () => {
    const { encryptSecret, decryptSecret } = await loadCrypto();
    const sealed = encryptSecret('token');
    const parts = sealed.split('.');
    // Corrupt the ciphertext segment.
    const bytes = Buffer.from(parts[3], 'base64url');
    bytes[0] ^= 0xff;
    parts[3] = bytes.toString('base64url');

    // A tampered ciphertext must throw, never yield a wrong-but-usable string
    // that then gets sent to Google as a bearer token.
    expect(() => decryptSecret(parts.join('.'))).toThrow();
  });

  it('cannot be decrypted with a different secret', async () => {
    const first = await loadCrypto({
      CREDENTIAL_SECRET: 'secret-number-one-padded-to-32-characters',
    });
    const sealed = first.encryptSecret('token');

    const second = await loadCrypto({
      CREDENTIAL_SECRET: 'secret-number-two-padded-to-32-characters',
    });
    // This is why rotating CREDENTIAL_SECRET forces every tool to reconnect.
    expect(() => second.decryptSecret(sealed)).toThrow();
  });
});
