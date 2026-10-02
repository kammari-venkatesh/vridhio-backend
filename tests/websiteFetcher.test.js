import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ANALYSIS_ERROR_CODES as C } from '../src/services/websiteAnalysis/analysisErrors.js';
import { classifyNetworkError, createWebsiteFetcher } from '../src/services/websiteAnalysis/websiteFetcher.js';
import { createFakeWeb, createTestAnalyzer, fixture, html, redirect, text } from './helpers/fakeWeb.js';

const SITE = 'https://abc-dental.com/';
const fetcherFor = (web, timeoutMs = 300) => createWebsiteFetcher({ resolve: web.resolve, transport: web.transport, timeoutMs });
const htmlOnly = (mime) => !mime || /html/.test(mime);

describe('Website fetcher', () => {
  it('returns status, content type, timing and decoded body for HTTP 200', async () => {
    const web = createFakeWeb({ [SITE]: html(fixture('complete.html')) });
    const res = await fetcherFor(web).fetchUrl(SITE, { maxBytes: 1_000_000, isWantedType: htmlOnly });
    assert.equal(res.status, 200);
    assert.equal(res.contentType, 'text/html');
    assert.equal(res.redirectCount, 0);
    assert.ok(res.responseTimeMs >= 0);
    assert.match(res.body, /ABC Dental Clinic/);
    assert.equal(web.requests[0].headers['User-Agent'].includes('VridhioSiteCheck'), true);
  });

  it('returns 404, 403 and 500 responses instead of throwing', async () => {
    for (const status of [404, 403, 500]) {
      const web = createFakeWeb({ [SITE]: html('<h1>error</h1>', { status }) });
      const res = await fetcherFor(web).fetchUrl(SITE, { maxBytes: 10_000 });
      assert.equal(res.status, status);
    }
  });

  it('times out a server that never responds', async () => {
    const web = createFakeWeb({ [SITE]: { hang: true } });
    const started = Date.now();
    await assert.rejects(fetcherFor(web, 150).fetchUrl(SITE, { maxBytes: 1000 }), { code: C.TIMEOUT });
    assert.ok(Date.now() - started < 2000);
  });

  it('times out a body that never finishes', async () => {
    const web = createFakeWeb({ [SITE]: { status: 200, headers: { 'content-type': 'text/html' }, endlessBody: true } });
    await assert.rejects(fetcherFor(web, 150).fetchUrl(SITE, { maxBytes: 1000 }), { code: C.TIMEOUT });
  });

  it('classifies TLS, connection and DNS failures precisely', async () => {
    const cases = [
      ['CERT_HAS_EXPIRED', C.TLS_ERROR],
      ['DEPTH_ZERO_SELF_SIGNED_CERT', C.TLS_ERROR],
      ['ERR_TLS_CERT_ALTNAME_INVALID', C.TLS_ERROR],
      ['ECONNREFUSED', C.CONNECTION_ERROR],
      ['ECONNRESET', C.CONNECTION_ERROR],
      ['HPE_INVALID_CONSTANT', C.INVALID_RESPONSE],
    ];
    for (const [code, expected] of cases) {
      const web = createFakeWeb({ [SITE]: { error: code } });
      await assert.rejects(fetcherFor(web).fetchUrl(SITE, { maxBytes: 1000 }), { code: expected }, code);
    }
    const dns = createFakeWeb({}, { dnsErrors: { 'abc-dental.com': 'ENOTFOUND' } });
    await assert.rejects(fetcherFor(dns).fetchUrl(SITE, { maxBytes: 1000 }), { code: C.DNS_ERROR });
    assert.equal(classifyNetworkError(Object.assign(new Error('x'), { code: 'ETIMEDOUT' })).code, C.TIMEOUT);
  });

  it('does not download a body of an unwanted type', async () => {
    const web = createFakeWeb({ [SITE]: { status: 200, headers: { 'content-type': 'application/pdf' }, body: Buffer.alloc(50_000) } });
    const res = await fetcherFor(web).fetchUrl(SITE, { maxBytes: 1000, isWantedType: htmlOnly });
    assert.equal(res.skippedBody, true);
    assert.equal(res.body, null);
    assert.equal(res.contentType, 'application/pdf');
  });

  it('rejects oversized responses, by declared length and while streaming', async () => {
    const declared = createFakeWeb({ [SITE]: { status: 200, headers: { 'content-type': 'text/html', 'content-length': '999999999' }, body: 'x' } });
    await assert.rejects(fetcherFor(declared).fetchUrl(SITE, { maxBytes: 1000 }), { code: C.RESPONSE_TOO_LARGE });
    const streamed = createFakeWeb({ [SITE]: html('x'.repeat(300_000)) });
    await assert.rejects(fetcherFor(streamed).fetchUrl(SITE, { maxBytes: 100_000 }), { code: C.RESPONSE_TOO_LARGE });
  });

  it('truncates instead of failing when asked to read only the start', async () => {
    const web = createFakeWeb({ [SITE]: text('a'.repeat(200_000)) });
    const res = await fetcherFor(web).fetchUrl(SITE, { maxBytes: 1000, truncate: true });
    assert.equal(res.truncated, true);
    assert.equal(res.body.length, 1000);
  });

  it('decompresses gzip and caps the decompressed size (gzip bomb)', async () => {
    const ok = createFakeWeb({ [SITE]: { ...html('<title>Zipped</title>'), gzip: true } });
    assert.match((await fetcherFor(ok).fetchUrl(SITE, { maxBytes: 10_000 })).body, /Zipped/);
    const bomb = createFakeWeb({ [SITE]: { ...html('0'.repeat(5_000_000)), gzip: true } });
    await assert.rejects(fetcherFor(bomb).fetchUrl(SITE, { maxBytes: 100_000 }), { code: C.RESPONSE_TOO_LARGE });
  });

  it('decodes the declared charset', async () => {
    const latin1 = Buffer.from('<title>Caf\xe9 Ol\xe9</title>', 'latin1');
    const web = createFakeWeb({ [SITE]: { status: 200, headers: { 'content-type': 'text/html; charset=ISO-8859-1' }, body: latin1 } });
    assert.match((await fetcherFor(web).fetchUrl(SITE, { maxBytes: 10_000 })).body, /Café Olé/);
  });
});

describe('Website analysis failure handling', () => {
  const analyze = (routes, url = SITE, options) => createTestAnalyzer(createFakeWeb(routes, options)).analyze({ websiteUrl: url });

  it('records a 404 homepage as FAILED/HTTP_ERROR while noting the server was reachable', async () => {
    const result = await analyze({ [SITE]: html('<h1>Not found</h1>', { status: 404 }) });
    assert.equal(result.status, 'FAILED');
    assert.equal(result.errorCode, C.HTTP_ERROR);
    assert.equal(result.availability.reachable, true);
    assert.equal(result.availability.httpStatus, 404);
    assert.match(result.errorMessage, /HTTP 404/);
    assert.equal(result.evidence[0].type, 'HTTP_ERROR');
  });

  it('records 500 as HTTP_ERROR and a plain 403 as HTTP_ERROR', async () => {
    assert.equal((await analyze({ [SITE]: html('oops', { status: 500 }) })).errorCode, C.HTTP_ERROR);
    assert.equal((await analyze({ [SITE]: html('<h1>Forbidden</h1>', { status: 403 }) })).errorCode, C.HTTP_ERROR);
  });

  it('records bot protection and rate limiting as BLOCKED', async () => {
    const challenge = html('<title>Just a moment...</title><div id="cf-chl-widget"></div>', { status: 403, headers: { 'content-type': 'text/html', server: 'cloudflare' } });
    const blocked = await analyze({ [SITE]: challenge });
    assert.equal(blocked.errorCode, C.BLOCKED);
    assert.equal(blocked.evidence[0].type, 'ACCESS_BLOCKED');
    assert.equal((await analyze({ [SITE]: html('slow down', { status: 429 }) })).errorCode, C.BLOCKED);
  });

  it('retries a timeout once, then fails with TIMEOUT without calling the site broken', async () => {
    const web = createFakeWeb({ [SITE]: { hang: true } });
    const result = await createTestAnalyzer(web, { timeoutMs: 100 }).analyze({ websiteUrl: SITE });
    assert.equal(result.status, 'FAILED');
    assert.equal(result.errorCode, C.TIMEOUT);
    assert.equal(result.availability.attempts, 2);
    assert.equal(web.requests.length, 2);
    assert.match(result.evidence[0].evidence, /may be temporary/);
    assert.doesNotMatch(JSON.stringify(result), /broken/i);
  });

  it('succeeds when the retry after a transient failure works', async () => {
    const web = createFakeWeb({ [SITE]: ({ attempt }) => (attempt === 1 ? { error: 'ECONNRESET' } : html(fixture('minimal.html'))) });
    const result = await createTestAnalyzer(web).analyze({ websiteUrl: SITE });
    assert.equal(result.status, 'COMPLETED');
    assert.equal(result.availability.attempts, 2);
  });

  it('does not retry TLS failures, but tries plain HTTP once when no scheme was recorded', async () => {
    const tls = createFakeWeb({ [SITE]: { error: 'CERT_HAS_EXPIRED' } });
    const explicit = await createTestAnalyzer(tls).analyze({ websiteUrl: SITE });
    assert.equal(explicit.errorCode, C.TLS_ERROR);
    assert.equal(tls.requests.length, 1);

    const fallback = createFakeWeb({ [SITE]: { error: 'CERT_HAS_EXPIRED' }, 'http://abc-dental.com/': html(fixture('minimal.html')) });
    const result = await createTestAnalyzer(fallback).analyze({ websiteUrl: 'abc-dental.com' });
    assert.equal(result.status, 'COMPLETED');
    assert.equal(result.availability.https, false);
    assert.ok(result.evidence.some((e) => e.type === 'HTTPS_MISSING'));
  });

  it('records DNS failures and non-HTML responses precisely', async () => {
    const dns = await analyze({}, SITE, { dnsErrors: { 'abc-dental.com': 'ENOTFOUND' } });
    assert.equal(dns.errorCode, C.DNS_ERROR);
    assert.equal(dns.availability.reachable, false);
    const pdf = await analyze({ [SITE]: { status: 200, headers: { 'content-type': 'application/pdf' }, body: 'x' } });
    assert.equal(pdf.errorCode, C.NON_HTML);
    assert.equal(pdf.availability.contentType, 'application/pdf');
  });

  it('records an oversized homepage as RESPONSE_TOO_LARGE', async () => {
    const result = await createTestAnalyzer(createFakeWeb({ [SITE]: html('x'.repeat(200_000)) }), { maxHtmlBytes: 50_000 }).analyze({ websiteUrl: SITE });
    assert.equal(result.errorCode, C.RESPONSE_TOO_LARGE);
  });

  it('analyses malformed HTML without failing', async () => {
    const result = await analyze({ [SITE]: html(fixture('malformed.html')) });
    assert.equal(result.status, 'COMPLETED');
    assert.match(result.page.title, /Broken/);
    assert.ok(result.content.h1Count >= 1);
  });

  it('keeps the recorded URL and the final URL separate after redirects', async () => {
    const result = await analyze({
      'https://abc-dental.com/': redirect('https://www.abc-dental.com/'),
      'https://www.abc-dental.com/': html(fixture('complete.html')),
    }, 'abc-dental.com');
    assert.equal(result.website.websiteUrl, 'abc-dental.com');
    assert.equal(result.website.normalizedWebsiteUrl, 'https://abc-dental.com/');
    assert.equal(result.availability.finalUrl, 'https://www.abc-dental.com/');
    assert.equal(result.availability.redirectCount, 1);
    assert.ok(result.evidence.some((e) => e.type === 'REDIRECTED'));
  });

  it('skips a business with no website without any request', async () => {
    const web = createFakeWeb({});
    const result = await createTestAnalyzer(web).analyze({ websiteUrl: null });
    assert.equal(result.status, 'SKIPPED');
    assert.equal(result.errorCode, C.NO_WEBSITE);
    assert.equal(result.website.hasWebsite, false);
    assert.equal(result.evidence[0].type, 'NO_WEBSITE');
    assert.equal(web.requests.length + web.lookups.length, 0);
  });
});
