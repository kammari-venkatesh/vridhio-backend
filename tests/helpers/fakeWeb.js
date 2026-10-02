import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { websiteAnalysisConfig } from '../../src/config/websiteAnalysis.js';
import { createWebsiteAnalyzer } from '../../src/services/websiteAnalysis/websiteAnalyzer.js';
import { createWebsiteFetcher } from '../../src/services/websiteAnalysis/websiteFetcher.js';
import { createSafeResolver } from '../../src/services/websiteAnalysis/urlValidator.js';

/**
 * Deterministic stand-in for the internet: a fake DNS (hostname -> address) and a fake
 * HTTP transport (URL -> canned response). Nothing here opens a socket, so automated
 * tests never make real requests. Unknown URLs answer 404.
 */

export const fixture = (name) => readFileSync(new URL(`../fixtures/websites/${name}`, import.meta.url), 'utf8');

const PUBLIC_IP = '93.184.216.34';

export const html = (body, extra = {}) => ({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body, ...extra });
export const text = (body, status = 200) => ({ status, headers: { 'content-type': 'text/plain' }, body });
export const xml = (body, status = 200) => ({ status, headers: { 'content-type': 'application/xml' }, body });
export const redirect = (location, status = 301) => ({ status, headers: { location }, body: '' });

const networkError = (code) => Object.assign(new Error(`fake ${code}`), { code });

export const createFakeWeb = (routes = {}, { dns = {}, dnsErrors = {} } = {}) => {
  const requests = [];
  const lookups = [];

  const lookup = async (host) => {
    lookups.push(host);
    if (dnsErrors[host]) throw networkError(dnsErrors[host]);
    const answer = dns[host] ?? PUBLIC_IP;
    return (Array.isArray(answer) ? answer : [answer]).map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  };

  const transport = async ({ url, address, signal, headers }) => {
    requests.push({ url: url.href, address, headers });
    let route = routes[url.href];
    if (typeof route === 'function') route = route({ url, attempt: requests.filter((r) => r.url === url.href).length });
    if (!route) return { status: 404, headers: { 'content-type': 'text/html' }, body: Readable.from([Buffer.from('<html><title>Not found</title></html>')]) };
    if (route.error) throw networkError(route.error);
    if (route.hang) {
      return new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
      });
    }
    const responseHeaders = { ...(route.headers ?? {}) };
    if (route.endlessBody) {
      return { status: route.status ?? 200, headers: responseHeaders, body: new Readable({ read() {} }) };
    }
    let payload = Buffer.isBuffer(route.body) ? route.body : Buffer.from(route.body ?? '', 'utf8');
    if (route.gzip) {
      payload = gzipSync(payload);
      responseHeaders['content-encoding'] = 'gzip';
    }
    // Large bodies arrive in several chunks, like a real socket.
    const chunks = [];
    for (let i = 0; i < payload.length; i += 64 * 1024) chunks.push(payload.subarray(i, i + 64 * 1024));
    return { status: route.status ?? 200, headers: responseHeaders, body: Readable.from(chunks.length ? chunks : [Buffer.alloc(0)]) };
  };

  return { transport, lookup, resolve: createSafeResolver({ lookup }), requests, lookups };
};

/** Fast config for tests: short timeout, no retry delay. */
export const testConfig = (overrides = {}) => ({
  ...websiteAnalysisConfig,
  request: { ...websiteAnalysisConfig.request, timeoutMs: 300, retryDelayMs: 0, ...overrides },
});

export const createTestAnalyzer = (web, configOverrides) => {
  const config = testConfig(configOverrides);
  const fetcher = createWebsiteFetcher({
    resolve: web.resolve,
    transport: web.transport,
    timeoutMs: config.request.timeoutMs,
    maxRedirects: config.request.maxRedirects,
  });
  return createWebsiteAnalyzer({ fetcher, config, logger: { error() {} } });
};
