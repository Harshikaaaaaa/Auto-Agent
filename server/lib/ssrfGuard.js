import dns from 'dns';
import net from 'net';

/**
 * SSRF protection for outbound fetches.
 *
 * A "fetch this URL" endpoint is a server-side request forgery primitive: the
 * caller chooses the destination and the request originates from inside the
 * network, with whatever the network trusts. The dangerous targets are the
 * loopback interface, RFC1918 ranges, and the cloud metadata endpoint at
 * 169.254.169.254 — which on an unprotected instance hands out credentials.
 *
 * Blocking by hostname alone is not enough:
 *   - a hostname can resolve straight to a private address
 *   - a *public* host can redirect to a private one, so every hop needs checking
 *   - a host can resolve to a public address on first lookup and a private one on
 *     the second (DNS rebinding), so the address that was validated has to be the
 *     address actually connected to
 *
 * This module therefore resolves DNS itself, validates every resolved address,
 * and hands the connection a `lookup` that only ever returns an already-validated
 * address. Redirects are followed manually so each hop repeats the check.
 */

/** Only these schemes may be fetched. */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * Hostnames that must never be resolved, as a fast and readable first gate.
 * The address checks below are what actually enforce the policy.
 */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  // Cloud metadata services, by their well-known names.
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
]);

/** IPv4 CIDR ranges that must not be reached. */
const BLOCKED_IPV4_RANGES = [
  ['0.0.0.0', 8], // "this host on this network"
  ['10.0.0.0', 8], // RFC1918 private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, includes the 169.254.169.254 metadata endpoint
  ['172.16.0.0', 12], // RFC1918 private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // RFC1918 private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved
];

function ipv4ToInt(address) {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

function isBlockedIpv4(address) {
  const value = ipv4ToInt(address);
  if (value === null) return true; // Unparseable means unsafe.

  for (const [range, prefix] of BLOCKED_IPV4_RANGES) {
    const rangeValue = ipv4ToInt(range);
    // A /0 mask would shift by 32, which is undefined for JS bit ops.
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    if ((value & mask) >>> 0 === (rangeValue & mask) >>> 0) return true;
  }

  return false;
}

/** Expand an IPv6 address to its eight 16-bit groups. */
function expandIpv6(address) {
  let text = address.toLowerCase();

  // Strip a zone index such as %eth0.
  const zoneIndex = text.indexOf('%');
  if (zoneIndex !== -1) text = text.slice(0, zoneIndex);

  // An embedded IPv4 tail (::ffff:1.2.3.4) becomes two hex groups.
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    const value = ipv4ToInt(tail);
    if (value === null) return null;
    const high = ((value >>> 16) & 0xffff).toString(16);
    const low = (value & 0xffff).toString(16);
    text = `${text.slice(0, lastColon + 1)}${high}:${low}`;
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;

  const head = halves[0] ? halves[0].split(':').filter(Boolean) : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':').filter(Boolean) : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 2 && missing < 0) return null;

  const groups =
    halves.length === 2 ? [...head, ...Array(missing).fill('0'), ...rest] : head;
  if (groups.length !== 8) return null;

  const parsed = groups.map((group) => Number.parseInt(group || '0', 16));
  return parsed.some((n) => Number.isNaN(n) || n < 0 || n > 0xffff) ? null : parsed;
}

function isBlockedIpv6(address) {
  const groups = expandIpv6(address);
  if (!groups) return true; // Unparseable means unsafe.

  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;
  const isZeroPrefix = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;

  // :: (unspecified) and ::1 (loopback)
  if (isZeroPrefix && g5 === 0 && g6 === 0 && (g7 === 0 || g7 === 1)) return true;

  // IPv4-mapped ::ffff:a.b.c.d — judge it by the embedded IPv4 address.
  if (isZeroPrefix && g5 === 0xffff) {
    return isBlockedIpv4(ipv6TailAsIpv4(g6, g7));
  }

  // NAT64 64:ff9b::/96 — also judge by the embedded IPv4 address.
  if (g0 === 0x0064 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return isBlockedIpv4(ipv6TailAsIpv4(g6, g7));
  }

  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (g0 === 0x2001 && g1 === 0x0db8) return true; // 2001:db8::/32 documentation

  return false;
}

function ipv6TailAsIpv4(g6, g7) {
  return [(g6 >> 8) & 0xff, g6 & 0xff, (g7 >> 8) & 0xff, g7 & 0xff].join('.');
}

/**
 * Whether an IP address must not be connected to.
 * Anything unrecognised is treated as blocked.
 */
export function isBlockedAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return isBlockedIpv4(address);
  if (family === 6) return isBlockedIpv6(address);
  return true;
}

/** Raised for a URL or address that policy forbids. */
export class BlockedRequestError extends Error {
  constructor(message, { reason, url } = {}) {
    super(message);
    this.name = 'BlockedRequestError';
    this.reason = reason;
    this.url = url;
    this.status = 400;
  }
}

/**
 * Validate the shape of a URL before any DNS happens.
 * @returns {URL}
 */
export function assertAllowedUrl(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch {
    throw new BlockedRequestError('That is not a valid URL.', { reason: 'invalid_url' });
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    // file:, gopher:, ftp: and friends are classic SSRF escalation paths.
    throw new BlockedRequestError(
      `Only http and https URLs can be fetched (got "${url.protocol}").`,
      { reason: 'protocol_not_allowed', url: url.href },
    );
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (!hostname) {
    throw new BlockedRequestError('That URL has no host.', { reason: 'missing_host' });
  }

  if (BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith('.localhost')) {
    throw new BlockedRequestError('That host is not allowed.', {
      reason: 'host_blocked',
      url: url.href,
    });
  }

  // A literal private IP in the URL is rejected without needing DNS.
  if (net.isIP(hostname) && isBlockedAddress(hostname)) {
    throw new BlockedRequestError('That address is on a private or reserved range.', {
      reason: 'address_blocked',
      url: url.href,
    });
  }

  return url;
}

/**
 * Resolve a hostname and return only addresses that pass the policy.
 * @throws {BlockedRequestError} when it does not resolve, or every address is blocked.
 */
export async function resolveAllowedAddresses(hostname) {
  const cleaned = hostname.toLowerCase().replace(/^\[|\]$/g, '');

  // A literal address needs no resolution.
  if (net.isIP(cleaned)) {
    if (isBlockedAddress(cleaned)) {
      throw new BlockedRequestError('That address is on a private or reserved range.', {
        reason: 'address_blocked',
      });
    }
    return [{ address: cleaned, family: net.isIP(cleaned) }];
  }

  let records;
  try {
    records = await dns.promises.lookup(cleaned, { all: true, verbatim: true });
  } catch {
    throw new BlockedRequestError(`Could not resolve "${cleaned}".`, {
      reason: 'dns_failure',
    });
  }

  const allowed = records.filter((record) => !isBlockedAddress(record.address));

  if (allowed.length === 0) {
    // Either every address is private, or the name is a rebinding attempt.
    throw new BlockedRequestError(
      `"${cleaned}" resolves only to private or reserved addresses.`,
      { reason: 'address_blocked' },
    );
  }

  return allowed;
}

/**
 * Build a `lookup` implementation for http.request that can only ever return an
 * address from `allowedAddresses`.
 *
 * This is what closes DNS rebinding: the socket connects to the exact address
 * that was validated, instead of re-resolving and possibly getting a private one.
 */
export function createPinnedLookup(allowedAddresses) {
  return function pinnedLookup(_hostname, options, callback) {
    const wantsAll = Boolean(options?.all);
    const family = options?.family;

    const candidates = family
      ? allowedAddresses.filter((record) => record.family === family)
      : allowedAddresses;

    if (candidates.length === 0) {
      const error = new Error('No allowed address for this host.');
      error.code = 'ENOTFOUND';
      callback(error);
      return;
    }

    if (wantsAll) {
      callback(null, candidates.map((r) => ({ address: r.address, family: r.family })));
    } else {
      callback(null, candidates[0].address, candidates[0].family);
    }
  };
}

/** Exposed for tests. */
export const __testing = { isBlockedIpv4, isBlockedIpv6, expandIpv6, BLOCKED_IPV4_RANGES };
