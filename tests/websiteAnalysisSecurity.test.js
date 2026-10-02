import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import { ANALYSIS_ERROR_CODES as C } from '../src/services/websiteAnalysis/analysisErrors.js';
import {
  assertSafeUrl,
  createSafeResolver,
  isBlockedAddress,
  normalizeWebsiteUrl,
} from '../src/services/websiteAnalysis/urlValidator.js';
import { createWebsiteFetcher, nodeTransport } from '../src/services/websiteAnalysis/websiteFetcher.js';
import { createFakeWeb, createTestAnalyzer, fixture, html, redirect } from './helpers/fakeWeb.js';

const unsafe = (raw) => normalizeWebsiteUrl(raw).error;

describe('Website analysis SSRF protection: URL validation', () => {
  it('accepts public HTTPS and HTTP URLs and normalises scheme-less ones to HTTPS', () => {
    assert.deepEqual(normalizeWebsiteUrl('https://abc-dental.com/path?x=1#top'), {
      url: 'https://abc-dental.com/path?x=1',
      assumedScheme: false,
    });
    assert.deepEqual(normalizeWebsiteUrl('http://abc-dental.com'), { url: 'http://abc-dental.com/', assumedScheme: false });
    assert.deepEqual(normalizeWebsiteUrl('  www.Abc-Dental.com  '), { url: 'https://www.abc-dental.com/', assumedScheme: true });
  });

  it('reports a missing website separately from an invalid one', () => {
    assert.equal(unsafe(''), C.NO_WEBSITE);
    assert.equal(unsafe(null), C.NO_WEBSITE);
    assert.equal(unsafe('not a url'), C.INVALID_URL);
    assert.equal(unsafe('https://exa mple.com'), C.INVALID_URL);
    assert.equal(unsafe('https://'), C.INVALID_URL);
  });

  it('blocks localhost and internal hostnames', () => {
    for (const url of [
      'http://localhost',
      'http://LOCALHOST./admin',
      'http://app.localhost',
      'http://printer.local',
      'http://metadata.google.internal/computeMetadata/v1/',
      'http://intranet',
      'http://router.lan',
    ]) {
      assert.equal(unsafe(url), C.UNSAFE_URL, url);
    }
  });

  it('blocks loopback, private, link-local, CGNAT, metadata and reserved IPv4 literals', () => {
    for (const url of [
      'http://127.0.0.1',
      'http://127.1.2.3:80/',
      'http://0.0.0.0',
      'http://10.0.0.8',
      'http://172.16.0.1',
      'http://172.31.255.255',
      'http://192.168.1.1',
      'http://169.254.169.254/latest/meta-data/',
      'http://100.100.100.200',
      'http://224.0.0.1',
      'http://255.255.255.255',
    ]) {
      assert.equal(unsafe(url), C.UNSAFE_URL, url);
    }
  });

  it('blocks encoded IPv4 forms that URL parsing turns into loopback', () => {
    assert.equal(unsafe('http://2130706433'), C.UNSAFE_URL); // decimal 127.0.0.1
    assert.equal(unsafe('http://0x7f.0.0.1'), C.UNSAFE_URL); // hex
    assert.equal(unsafe('http://0177.0.0.1'), C.UNSAFE_URL); // octal
  });

  it('blocks loopback, unique-local, link-local and IPv4-mapped IPv6 literals', () => {
    for (const url of [
      'http://[::1]',
      'http://[::]',
      'http://[fd00:ec2::254]',
      'http://[fc00::1]',
      'http://[fe80::1]',
      'http://[::ffff:127.0.0.1]',
      'http://[::ffff:169.254.169.254]',
      'http://[64:ff9b::a00:1]',
      'http://[2002:7f00:1::]',
    ]) {
      assert.equal(unsafe(url), C.UNSAFE_URL, url);
    }
  });

  it('allows public addresses', () => {
    assert.equal(isBlockedAddress('93.184.216.34'), false);
    assert.equal(isBlockedAddress('8.8.8.8'), false);
    assert.equal(isBlockedAddress('2606:4700:4700::1111'), false);
    assert.equal(isBlockedAddress('::ffff:8.8.8.8'), false);
    assert.equal(isBlockedAddress('not-an-ip'), true);
  });

  it('rejects other schemes, embedded credentials and non-standard ports', () => {
    assert.equal(unsafe('file:///etc/passwd'), C.UNSAFE_URL);
    assert.equal(unsafe('ftp://abc-dental.com'), C.UNSAFE_URL);
    assert.equal(unsafe('gopher://abc-dental.com'), C.UNSAFE_URL);
    assert.equal(unsafe('https://user:pass@abc-dental.com'), C.UNSAFE_URL);
    assert.equal(unsafe('https://abc-dental.com:8443/'), C.UNSAFE_URL);
    assert.equal(unsafe('abc-dental.com:6379'), C.UNSAFE_URL);
    assert.doesNotThrow(() => assertSafeUrl(new URL('https://abc-dental.com:443/')));
  });
});

describe('Website analysis SSRF protection: DNS validation', () => {
  it('rejects a public-looking hostname that resolves to a private address', async () => {
    const resolve = createSafeResolver({ lookup: async () => [{ address: '10.1.2.3', family: 4 }] });
    await assert.rejects(resolve('innocent-looking.com'), { code: C.UNSAFE_URL });
  });

  it('rejects a hostname when any one of its addresses is private', async () => {
    const resolve = createSafeResolver({
      lookup: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ],
    });
    await assert.rejects(resolve('round-robin.com'), { code: C.UNSAFE_URL });
  });

  it('rejects hostnames resolving to the metadata endpoint or IPv6 loopback', async () => {
    for (const address of ['169.254.169.254', '::1', 'fd00::5']) {
      const resolve = createSafeResolver({ lookup: async () => [{ address, family: address.includes(':') ? 6 : 4 }] });
      await assert.rejects(resolve('cloud-trick.com'), { code: C.UNSAFE_URL }, address);
    }
  });

  it('returns the validated public address and maps lookup failures to DNS_ERROR', async () => {
    const ok = createSafeResolver({ lookup: async () => [{ address: '93.184.216.34', family: 4 }] });
    assert.deepEqual(await ok('abc-dental.com'), { address: '93.184.216.34', family: 4 });
    const missing = createSafeResolver({
      lookup: async () => {
        throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' });
      },
    });
    await assert.rejects(missing('no-such-domain.com'), { code: C.DNS_ERROR });
  });

  it('never connects when DNS points at a private network', async () => {
    const web = createFakeWeb({}, { dns: { 'rebind.com': '192.168.0.10' } });
    const { fetchUrl } = createWebsiteFetcher({ resolve: web.resolve, transport: web.transport, timeoutMs: 500 });
    await assert.rejects(fetchUrl('https://rebind.com/', { maxBytes: 1000 }), { code: C.UNSAFE_URL });
    assert.equal(web.requests.length, 0);
  });
});

describe('Website analysis redirect security', () => {
  const fetcherFor = (web, maxRedirects = 5) =>
    createWebsiteFetcher({ resolve: web.resolve, transport: web.transport, timeoutMs: 500, maxRedirects });

  it('follows a safe redirect and reports the final URL and redirect count', async () => {
    const web = createFakeWeb({
      'http://abc-dental.com/': redirect('https://abc-dental.com/'),
      'https://abc-dental.com/': redirect('/home', 302),
      'https://abc-dental.com/home': html('<title>Home</title>'),
    });
    const res = await fetcherFor(web).fetchUrl('http://abc-dental.com/', { maxBytes: 10_000 });
    assert.equal(res.status, 200);
    assert.equal(res.finalUrl, 'https://abc-dental.com/home');
    assert.equal(res.redirectCount, 2);
    assert.deepEqual(res.redirectChain, ['http://abc-dental.com/', 'https://abc-dental.com/']);
  });

  it('blocks a redirect to a loopback address before connecting', async () => {
    const web = createFakeWeb({
      'https://business.com/': redirect('https://business.com/login'),
      'https://business.com/login': redirect('http://127.0.0.1/admin'),
    });
    await assert.rejects(fetcherFor(web).fetchUrl('https://business.com/', { maxBytes: 1000 }), (err) => {
      assert.equal(err.code, C.UNSAFE_URL);
      assert.equal(err.partial.finalUrl, 'http://127.0.0.1/admin');
      assert.equal(err.partial.redirectCount, 2);
      return true;
    });
    assert.deepEqual(
      web.requests.map((r) => r.url),
      ['https://business.com/', 'https://business.com/login'],
    );
  });

  it('blocks redirects to the metadata endpoint, private hostnames and other schemes', async () => {
    for (const location of [
      'http://169.254.169.254/latest/meta-data/',
      'http://[::1]/',
      'http://internal-dashboard/',
      'file:///etc/passwd',
      'https://business.com:8080/',
    ]) {
      const web = createFakeWeb({ 'https://business.com/': redirect(location) });
      await assert.rejects(fetcherFor(web).fetchUrl('https://business.com/', { maxBytes: 1000 }), { code: C.UNSAFE_URL }, location);
      assert.equal(web.requests.length, 1, location);
    }
  });

  it('re-validates DNS for every redirect target', async () => {
    const web = createFakeWeb(
      { 'https://business.com/': redirect('https://cdn-redirect.com/') },
      { dns: { 'cdn-redirect.com': '10.0.0.7' } },
    );
    await assert.rejects(fetcherFor(web).fetchUrl('https://business.com/', { maxBytes: 1000 }), { code: C.UNSAFE_URL });
    assert.deepEqual(web.lookups, ['business.com', 'cdn-redirect.com']);
    assert.equal(web.requests.length, 1);
  });

  it('enforces the redirect limit', async () => {
    const routes = {};
    for (let i = 0; i < 10; i++) routes[`https://hops.com/${i}`] = redirect(`/${i + 1}`);
    const web = createFakeWeb(routes);
    await assert.rejects(fetcherFor(web, 5).fetchUrl('https://hops.com/0', { maxBytes: 1000 }), { code: C.TOO_MANY_REDIRECTS });
    assert.equal(web.requests.length, 6);
  });

  it('detects redirect loops', async () => {
    const web = createFakeWeb({
      'https://loop.com/a': redirect('/b'),
      'https://loop.com/b': redirect('/a'),
    });
    await assert.rejects(fetcherFor(web).fetchUrl('https://loop.com/a', { maxBytes: 1000 }), { code: C.REDIRECT_LOOP });
  });

  it('stores a redirect to a private address as a safe UNSAFE_URL failure', async () => {
    const web = createFakeWeb({ 'https://business.com/': redirect('http://10.0.0.1/') });
    const result = await createTestAnalyzer(web).analyze({ websiteUrl: 'https://business.com' });
    assert.equal(result.status, 'FAILED');
    assert.equal(result.errorCode, C.UNSAFE_URL);
    assert.doesNotMatch(result.errorMessage, /10\.0\.0\.1/);
    assert.equal(result.evidence[0].type, 'UNSAFE_WEBSITE_URL');
  });
});

describe('Website analysis transport pinning', () => {
  let server;
  let port;
  const seen = [];

  before(async () => {
    server = http.createServer((req, res) => {
      seen.push({ host: req.headers.host, ua: req.headers['user-agent'], url: req.url });
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(fixture('minimal.html'));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });
  after(() => new Promise((resolve) => server.close(resolve)));

  it('connects to the pre-validated address without consulting DNS again, keeping the Host header', async () => {
    // "pinned-site.com" is never looked up: the transport must use the address it is given.
    const res = await nodeTransport({
      url: new URL(`http://pinned-site.com:${port}/page?q=1`),
      address: '127.0.0.1',
      family: 4,
      headers: { 'User-Agent': 'VridhioSiteCheck-test' },
      signal: AbortSignal.timeout(2000),
    });
    res.body.resume();
    assert.equal(res.status, 200);
    assert.equal(seen.at(-1).host, `pinned-site.com:${port}`);
    assert.equal(seen.at(-1).url, '/page?q=1');
    assert.equal(seen.at(-1).ua, 'VridhioSiteCheck-test');
  });

  it('the real resolver refuses to hand out the loopback address the test server uses', async () => {
    await assert.rejects(createSafeResolver()('localhost'), { code: C.UNSAFE_URL });
  });
});
