import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../password.js';

describe('password hashing (scrypt)', () => {
  it('verifies a correct password and rejects a wrong one', () => {
    const stored = hashPassword('correct horse battery staple');
    expect(verifyPassword('correct horse battery staple', stored)).toBe(true);
    expect(verifyPassword('wrong password', stored)).toBe(false);
  });

  it('produces a self-describing, salted hash (different each time)', () => {
    const a = hashPassword('same-password');
    const b = hashPassword('same-password');
    expect(a).not.toBe(b); // random salt
    expect(a.startsWith('scrypt$')).toBe(true);
    expect(a.split('$')).toHaveLength(6);
    // Both still verify.
    expect(verifyPassword('same-password', a)).toBe(true);
    expect(verifyPassword('same-password', b)).toBe(true);
  });

  it('never throws on a malformed stored hash — it just fails to verify', () => {
    for (const bad of ['', 'not-a-hash', 'scrypt$only$three$parts', 'bcrypt$1$2$3$4$5']) {
      expect(verifyPassword('x', bad)).toBe(false);
    }
  });

  it('rejects an empty plaintext on hash', () => {
    expect(() => hashPassword('')).toThrow();
  });
});
