import { describe, expect, it } from 'vitest';
import {
  BlockedRequestError,
  assertAllowedUrl,
  assertNavigationAllowed,
  createPinnedLookup,
  isBlockedAddress,
} from '../ssrfGuard.js';

/**
 * The address policy behind /api/fetch.
 *
 * An endpoint that fetches a caller-supplied URL is an SSRF primitive. The
 * targets that matter are loopback, RFC1918, and above all the cloud metadata
 * endpoint at 169.254.169.254, which on an unprotected instance hands out
 * credentials.
 */

describe('isBlockedAddress', () => {
  describe('IPv4 that must be refused', () => {
    const blocked = [
      ['127.0.0.1', 'loopback'],
      ['127.1.2.3', 'loopback, non-canonical form'],
      ['0.0.0.0', 'this host'],
      ['10.1.2.3', 'RFC1918'],
      ['172.16.0.1', 'RFC1918 lower bound'],
      ['172.31.255.254', 'RFC1918 upper bound'],
      ['192.168.1.1', 'RFC1918'],
      ['169.254.1.1', 'link-local'],
      ['169.254.169.254', 'CLOUD METADATA — credential theft'],
      ['100.64.0.1', 'carrier-grade NAT'],
      ['192.0.0.1', 'IETF assignments'],
      ['198.18.0.1', 'benchmarking'],
      ['224.0.0.1', 'multicast'],
      ['240.0.0.1', 'reserved'],
      ['255.255.255.255', 'broadcast'],
    ];

    it.each(blocked)('blocks %s (%s)', (address) => {
      expect(isBlockedAddress(address)).toBe(true);
    });
  });

  describe('IPv4 that may be reached', () => {
    const allowed = ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '11.0.0.1'];

    it.each(allowed)('allows %s', (address) => {
      expect(isBlockedAddress(address)).toBe(false);
    });

    it('allows 172.32.x, just outside the RFC1918 block', () => {
      // 172.16.0.0/12 ends at 172.31.255.255; an off-by-one here would either
      // block legitimate hosts or open a private range.
      expect(isBlockedAddress('172.15.255.255')).toBe(false);
      expect(isBlockedAddress('172.16.0.0')).toBe(true);
      expect(isBlockedAddress('172.31.255.255')).toBe(true);
      expect(isBlockedAddress('172.32.0.0')).toBe(false);
    });
  });

  describe('IPv6 that must be refused', () => {
    const blocked = [
      ['::1', 'loopback'],
      ['::', 'unspecified'],
      ['fe80::1', 'link-local'],
      ['fc00::1', 'unique local'],
      ['fd12:3456::1', 'unique local'],
      ['ff02::1', 'multicast'],
      ['2001:db8::1', 'documentation'],
      ['::ffff:127.0.0.1', 'IPv4-mapped loopback'],
      ['::ffff:169.254.169.254', 'IPv4-mapped METADATA'],
      ['::ffff:10.0.0.1', 'IPv4-mapped RFC1918'],
      ['64:ff9b::127.0.0.1', 'NAT64 wrapped loopback'],
    ];

    it.each(blocked)('blocks %s (%s)', (address) => {
      expect(isBlockedAddress(address)).toBe(true);
    });
  });

  describe('IPv6 that may be reached', () => {
    it.each([['2606:4700:4700::1111'], ['2001:4860:4860::8888']])('allows %s', (address) => {
      expect(isBlockedAddress(address)).toBe(false);
    });
  });

  it('treats anything unparseable as blocked, failing closed', () => {
    for (const value of ['', 'not-an-ip', '999.999.999.999', '::gggg', undefined, null]) {
      expect(isBlockedAddress(value)).toBe(true);
    }
  });
});

describe('assertAllowedUrl', () => {
  it('accepts ordinary http and https URLs', () => {
    expect(assertAllowedUrl('https://example.com/page').hostname).toBe('example.com');
    expect(assertAllowedUrl('http://example.com:8080/a?b=c').port).toBe('8080');
  });

  describe('rejects non-http schemes', () => {
    // These are the classic SSRF escalation paths.
    const schemes = [
      'file:///etc/passwd',
      'ftp://example.com/x',
      'gopher://example.com/x',
      'data:text/html,hello',
      'javascript:alert(1)',
      'ws://example.com',
    ];

    it.each(schemes)('rejects %s', (url) => {
      expect(() => assertAllowedUrl(url)).toThrow(BlockedRequestError);
    });

    it('reports the reason as protocol_not_allowed', () => {
      const error = (() => {
        try {
          assertAllowedUrl('file:///etc/passwd');
          return null;
        } catch (err) {
          return err;
        }
      })();
      expect(error.reason).toBe('protocol_not_allowed');
    });
  });

  describe('rejects internal hostnames', () => {
    const hosts = [
      'http://localhost/',
      'http://localhost:8080/admin',
      'http://LOCALHOST/',
      'http://anything.localhost/',
      'http://metadata.google.internal/computeMetadata/v1/',
      'http://instance-data/latest/meta-data/',
    ];

    it.each(hosts)('rejects %s', (url) => {
      expect(() => assertAllowedUrl(url)).toThrow(BlockedRequestError);
    });
  });

  describe('rejects literal private addresses without needing DNS', () => {
    const urls = [
      'http://127.0.0.1:3306/',
      'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
      'http://10.0.0.1/',
      'http://192.168.1.1/',
      'http://[::1]:8080/',
      'http://[fe80::1]/',
      'http://[::ffff:127.0.0.1]/',
    ];

    it.each(urls)('rejects %s', (url) => {
      expect(() => assertAllowedUrl(url)).toThrow(BlockedRequestError);
    });

    it('reports the reason as address_blocked', () => {
      const error = (() => {
        try {
          assertAllowedUrl('http://169.254.169.254/latest/meta-data/');
          return null;
        } catch (err) {
          return err;
        }
      })();
      expect(error.reason).toBe('address_blocked');
    });
  });

  it('rejects a malformed URL', () => {
    expect(() => assertAllowedUrl('not a url')).toThrow(/not a valid URL/i);
    expect(() => assertAllowedUrl('')).toThrow(BlockedRequestError);
  });

  it('allows a public address literal', () => {
    expect(() => assertAllowedUrl('http://93.184.216.34/')).not.toThrow();
  });
});

describe('createPinnedLookup', () => {
  /**
   * Pinning is what closes DNS rebinding: the socket must connect to the address
   * that was validated, not re-resolve and possibly get a private one.
   */
  it('returns only the validated address', () => {
    const lookup = createPinnedLookup([{ address: '93.184.216.34', family: 4 }]);

    const seen = [];
    lookup('example.com', {}, (err, address, family) => seen.push({ err, address, family }));

    expect(seen[0].err).toBeNull();
    expect(seen[0].address).toBe('93.184.216.34');
    expect(seen[0].family).toBe(4);
  });

  it('supports the all:true form used by the http agent', () => {
    const lookup = createPinnedLookup([
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1::', family: 6 },
    ]);

    const seen = [];
    lookup('example.com', { all: true }, (err, results) => seen.push({ err, results }));

    expect(seen[0].results).toHaveLength(2);
    expect(seen[0].results[0].address).toBe('93.184.216.34');
  });

  it('filters by requested family', () => {
    const lookup = createPinnedLookup([
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1::', family: 6 },
    ]);

    const seen = [];
    lookup('example.com', { family: 6 }, (err, address) => seen.push({ err, address }));

    expect(seen[0].address).toBe('2606:2800:220:1::');
  });

  it('fails with ENOTFOUND rather than falling back to a real lookup', () => {
    // Falling through to dns.lookup here would reopen the rebinding hole.
    const lookup = createPinnedLookup([]);

    const seen = [];
    lookup('example.com', {}, (err) => seen.push(err));

    expect(seen[0]).toBeInstanceOf(Error);
    expect(seen[0].code).toBe('ENOTFOUND');
  });
});

describe('assertNavigationAllowed (the render-tier request guard)', () => {
  // A resolver that pretends one public host resolves to a public address, and
  // defers everything else to the real policy — so blocked cases are judged by
  // the real guard, not a stub.
  const resolve = async (hostname) => {
    if (hostname === 'good.example') return [{ address: '93.184.216.34', family: 4 }];
    const { resolveAllowedAddresses } = await import('../ssrfGuard.js');
    return resolveAllowedAddresses(hostname);
  };

  it('allows a well-formed public URL', async () => {
    const verdict = await assertNavigationAllowed('https://good.example/page', resolve);
    expect(verdict.allowed).toBe(true);
  });

  it('blocks the cloud metadata endpoint by literal IP', async () => {
    const verdict = await assertNavigationAllowed('http://169.254.169.254/latest/meta-data/');
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe('address_blocked');
  });

  it('blocks a private RFC1918 literal address', async () => {
    const verdict = await assertNavigationAllowed('http://10.0.0.5/internal');
    expect(verdict.allowed).toBe(false);
  });

  it('blocks a non-http scheme', async () => {
    const verdict = await assertNavigationAllowed('file:///etc/passwd');
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe('protocol_not_allowed');
  });

  it('blocks a host that resolves only to a private address (rebinding)', async () => {
    // The resolver returns a blocked address, so the DNS gate must reject it
    // even though the URL shape is fine.
    const rebinding = async () => {
      const { BlockedRequestError: E } = await import('../ssrfGuard.js');
      throw new E('resolves only to private addresses', { reason: 'address_blocked' });
    };
    const verdict = await assertNavigationAllowed('https://sneaky.example/x', rebinding);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe('address_blocked');
  });

  it('reports an invalid URL rather than throwing', async () => {
    const verdict = await assertNavigationAllowed('not a url');
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe('invalid_url');
  });
});
