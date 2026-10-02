import dns from 'node:dns';
import net from 'node:net';
import { ANALYSIS_ERROR_CODES as C, AnalysisError } from './analysisErrors.js';

/**
 * SSRF protection for every outbound analysis request.
 *
 * 1. `normalizeWebsiteUrl` turns a stored website into an absolute http(s) URL.
 * 2. `assertSafeUrl` rejects unsafe schemes, credentials, non-standard ports, internal
 *    hostnames and literal private/reserved IP addresses (checked again on every redirect).
 * 3. `createSafeResolver` resolves the hostname and rejects it if ANY resolved address is
 *    private/reserved; the fetcher then connects to that exact, already-validated address,
 *    so a second DNS answer (rebinding) can never redirect the connection.
 */

const MAX_URL_LENGTH = 2048;
const ALLOWED_PORTS = new Set(['', '80', '443']);

const BLOCKED_HOSTNAMES = new Set(['localhost', 'metadata', 'instance-data', 'metadata.google.internal']);
const BLOCKED_SUFFIXES = [
  '.localhost',
  '.local',
  '.localdomain',
  '.internal',
  '.intranet',
  '.lan',
  '.home',
  '.corp',
  '.private',
  '.arpa',
  '.onion',
];

const v4 = new net.BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], // "this" network, incl. 0.0.0.0
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT (incl. 100.100.100.200 cloud metadata)
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local (incl. 169.254.169.254 cloud metadata)
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, incl. 255.255.255.255
]) {
  v4.addSubnet(network, prefix, 'ipv4');
}

const v6 = new net.BlockList();
for (const [network, prefix] of [
  ['64:ff9b::', 96], // NAT64 (embeds IPv4)
  ['64:ff9b:1::', 48], // local-use NAT64
  ['2001::', 23], // IETF protocol assignments, incl. Teredo
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4 (embeds IPv4)
  ['3fff::', 20], // documentation
]) {
  v6.addSubnet(network, prefix, 'ipv6');
}

/** Expands an IPv6 address into eight 16-bit numbers; null when it is not valid IPv6. */
export const expandIPv6 = (input) => {
  let address = String(input).replace(/^\[|\]$/g, '');
  const zone = address.indexOf('%');
  if (zone !== -1) address = address.slice(0, zone);
  if (!net.isIPv6(address)) return null;

  const dotted = address.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const [a, b, c, d] = dotted[1].split('.').map(Number);
    address = `${address.slice(0, -dotted[1].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = address.split('::');
  const headParts = head ? head.split(':') : [];
  const tailParts = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const fill = address.includes('::') ? 8 - headParts.length - tailParts.length : 0;
  const parts = [...headParts, ...Array(fill).fill('0'), ...tailParts].map((p) => parseInt(p, 16));
  return parts.length === 8 && parts.every((p) => Number.isInteger(p) && p >= 0 && p <= 0xffff) ? parts : null;
};

const isBlockedIPv4 = (address) => v4.check(address, 'ipv4');

/**
 * True for any address an analysis must never connect to: loopback, private, link-local,
 * carrier-grade NAT, multicast, reserved, documentation, cloud metadata, unique-local
 * IPv6, and IPv4-mapped/embedded forms of those. Only global unicast IPv6 (2000::/3)
 * outside the special-purpose blocks is allowed.
 */
export const isBlockedAddress = (input) => {
  const address = String(input ?? '').replace(/^\[|\]$/g, '');
  if (net.isIPv4(address)) return isBlockedIPv4(address);
  const parts = expandIPv6(address);
  if (!parts) return true;

  const upperZero = parts.slice(0, 5).every((p) => p === 0);
  // IPv4-mapped (::ffff:a.b.c.d) and the deprecated IPv4-compatible (::a.b.c.d) forms.
  if (upperZero && (parts[5] === 0xffff || parts[5] === 0)) {
    if (parts[5] === 0) return true;
    const ipv4 = [parts[6] >> 8, parts[6] & 0xff, parts[7] >> 8, parts[7] & 0xff].join('.');
    return isBlockedIPv4(ipv4);
  }
  // Global unicast only: excludes ::, ::1, fc00::/7 (unique local), fe80::/10 (link-local),
  // fec0::/10 (site-local), ff00::/8 (multicast) and every other non-2000::/3 range.
  if ((parts[0] & 0xe000) !== 0x2000) return true;
  const canonical = parts.map((p) => p.toString(16)).join(':');
  return v6.check(canonical, 'ipv6');
};

const isBlockedHostname = (hostname) => {
  if (BLOCKED_HOSTNAMES.has(hostname)) return true;
  if (BLOCKED_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) return true;
  // Single-label names ("intranet", "router") only resolve inside private networks.
  return !hostname.includes('.');
};

const hostOf = (url) => url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();

/**
 * Throws AnalysisError(UNSAFE_URL | INVALID_URL) unless `url` may be requested. Checked
 * for the first URL and again for every redirect target. DNS is checked separately.
 */
export const assertSafeUrl = (url) => {
  if (!(url instanceof URL)) throw new AnalysisError(C.INVALID_URL);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new AnalysisError(C.UNSAFE_URL, { detail: 'scheme' });
  if (url.username || url.password) throw new AnalysisError(C.UNSAFE_URL, { detail: 'credentials' });
  if (!ALLOWED_PORTS.has(url.port)) throw new AnalysisError(C.UNSAFE_URL, { detail: 'port' });
  if (url.href.length > MAX_URL_LENGTH) throw new AnalysisError(C.INVALID_URL, { detail: 'length' });

  const host = hostOf(url);
  if (!host || host.length > 253) throw new AnalysisError(C.INVALID_URL, { detail: 'host' });
  if (net.isIP(host)) {
    if (isBlockedAddress(host)) throw new AnalysisError(C.UNSAFE_URL, { detail: 'ip-literal' });
    return;
  }
  if (isBlockedHostname(host)) throw new AnalysisError(C.UNSAFE_URL, { detail: 'hostname' });
};

/**
 * Normalises a stored website ("example.com", "https://Example.com/path#x") into an
 * absolute URL string. Returns { url, assumedScheme } or { error } with an error code;
 * never throws. No DNS lookups happen here.
 */
export const normalizeWebsiteUrl = (raw) => {
  if (typeof raw !== 'string' || raw.trim() === '') return { error: C.NO_WEBSITE };
  const text = raw.trim();
  // eslint-disable-next-line no-control-regex
  if (text.length > MAX_URL_LENGTH || /[\s\u0000-\u001f\u007f]/.test(text)) return { error: C.INVALID_URL };

  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) && !/^[^/]+:\d+(\/|$)/.test(text);
  let url;
  try {
    url = new URL(hasScheme ? text : `https://${text.replace(/^\/\//, '')}`);
  } catch {
    return { error: C.INVALID_URL };
  }
  try {
    assertSafeUrl(url);
  } catch (err) {
    return { error: err.code };
  }
  url.hash = '';
  return { url: url.href, assumedScheme: !hasScheme };
};

/**
 * Returns `resolve(hostname) -> { address, family }`. Every address the name resolves to
 * must be public; one private answer blocks the whole hostname. `lookup` is injectable
 * so tests never touch real DNS.
 */
export const createSafeResolver = ({ lookup = dns.promises.lookup } = {}) => async (hostname) => {
  const host = String(hostname).replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (net.isIP(host)) {
    if (isBlockedAddress(host)) throw new AnalysisError(C.UNSAFE_URL, { detail: 'ip-literal' });
    return { address: host, family: net.isIPv6(host) ? 6 : 4 };
  }
  let records;
  try {
    records = await lookup(host, { all: true, verbatim: true });
  } catch (err) {
    const transient = err?.code === 'EAI_AGAIN' || err?.code === 'ETIMEOUT';
    throw new AnalysisError(C.DNS_ERROR, { detail: `${err?.code ?? 'lookup'}${transient ? ':transient' : ''}` });
  }
  const list = (Array.isArray(records) ? records : [records]).filter((r) => r && net.isIP(r.address));
  if (list.length === 0) throw new AnalysisError(C.DNS_ERROR, { detail: 'no-records' });
  if (list.some((r) => isBlockedAddress(r.address))) {
    throw new AnalysisError(C.UNSAFE_URL, { detail: 'resolved-private' });
  }
  const chosen = list[0];
  return { address: chosen.address, family: net.isIPv6(chosen.address) ? 6 : 4 };
};

export const isTransientDnsError = (err) =>
  err instanceof AnalysisError && err.code === C.DNS_ERROR && String(err.detail).endsWith(':transient');
