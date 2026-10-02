import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isPathAllowed, looksLikeHtml, parseRobotsTxt } from '../src/services/websiteAnalysis/robotsAnalyzer.js';
import { classifySitemapResponse, sitemapCandidates } from '../src/services/websiteAnalysis/sitemapAnalyzer.js';
import { createFakeWeb, createTestAnalyzer, fixture, html, text, xml } from './helpers/fakeWeb.js';

const SITE = 'https://abc-dental.com/';
const ROBOTS = 'https://abc-dental.com/robots.txt';
const SITEMAP = 'https://abc-dental.com/sitemap.xml';
const URLSET = '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://abc-dental.com/</loc></url></urlset>';

const analyze = (routes) => {
  const web = createFakeWeb({ [SITE]: html(fixture('complete.html')), ...routes });
  return createTestAnalyzer(web).analyze({ websiteUrl: SITE }).then((result) => ({ result, web }));
};

describe('robots.txt parsing', () => {
  const robots = parseRobotsTxt(`
    # comment
    User-agent: *
    Disallow: /private/
    Allow: /private/public-page
    Disallow: /*.pdf$

    User-agent: VridhioSiteCheck
    Disallow: /no-bots/

    Sitemap: https://abc-dental.com/sitemap.xml
    Sitemap: https://cdn.abc-dental.com/sitemap-2.xml
  `);

  it('reads groups, rules and sitemap lines', () => {
    assert.equal(robots.groups.length, 2);
    assert.deepEqual(robots.sitemaps, ['https://abc-dental.com/sitemap.xml', 'https://cdn.abc-dental.com/sitemap-2.xml']);
  });

  it('applies the most specific matching group and the longest matching rule', () => {
    assert.equal(isPathAllowed(robots, 'vridhiositecheck', '/no-bots/x'), false);
    assert.equal(isPathAllowed(robots, 'vridhiositecheck', '/private/x'), true, 'the specific group replaces *');
    assert.equal(isPathAllowed(robots, 'otherbot', '/private/x'), false);
    assert.equal(isPathAllowed(robots, 'otherbot', '/private/public-page'), true);
    assert.equal(isPathAllowed(robots, 'otherbot', '/files/menu.pdf'), false);
    assert.equal(isPathAllowed(robots, 'otherbot', '/files/menu.pdf?x=1'), true);
    assert.equal(isPathAllowed(parseRobotsTxt(''), 'any', '/'), true);
  });

  it('recognises an HTML page served as robots.txt', () => {
    assert.equal(looksLikeHtml('<!DOCTYPE html><html>'), true);
    assert.equal(looksLikeHtml('User-agent: *'), false);
  });
});

describe('sitemap candidates', () => {
  it('orders robots.txt sitemaps, then HTML links, then default paths, without duplicates', () => {
    const list = sitemapCandidates({
      origin: 'https://abc-dental.com',
      robotsSitemaps: ['https://abc-dental.com/sitemap.xml'],
      htmlSitemaps: ['https://abc-dental.com/site-map.xml'],
      max: 5,
    });
    assert.deepEqual(list, [
      { url: 'https://abc-dental.com/sitemap.xml', source: 'ROBOTS' },
      { url: 'https://abc-dental.com/site-map.xml', source: 'HTML_LINK' },
      { url: 'https://abc-dental.com/sitemap_index.xml', source: 'DEFAULT_PATH' },
    ]);
  });

  it('does not treat an HTML page at /sitemap.xml as a sitemap', () => {
    assert.equal(classifySitemapResponse({ status: 200, contentType: 'text/html', body: '<html>Home</html>' }).exists, false);
    assert.equal(classifySitemapResponse({ status: 200, contentType: 'application/xml', body: URLSET }).kind, 'urlset');
    assert.equal(classifySitemapResponse({ status: 404, contentType: 'text/html', body: '' }).exists, false);
  });
});

describe('robots.txt and sitemap analysis', () => {
  it('records an existing robots.txt and a sitemap discovered from it', async () => {
    const { result, web } = await analyze({
      [ROBOTS]: text('User-agent: *\nDisallow:\nSitemap: https://abc-dental.com/sitemaps/main.xml'),
      'https://abc-dental.com/sitemaps/main.xml': xml(URLSET),
    });
    assert.equal(result.robots.robotsTxtExists, true);
    assert.equal(result.robots.robotsTxtStatus, 200);
    assert.equal(result.robots.robotsTxtAccessible, true);
    assert.deepEqual(result.robots.robotsTxtSitemaps, ['https://abc-dental.com/sitemaps/main.xml']);
    assert.equal(result.sitemap.sitemapExists, true);
    assert.equal(result.sitemap.sitemapUrl, 'https://abc-dental.com/sitemaps/main.xml');
    assert.equal(result.sitemap.sitemapSource, 'ROBOTS');
    assert.equal(result.sitemap.sitemapStatus, 200);
    // Homepage, robots.txt and one sitemap: no crawling.
    assert.equal(web.requests.length, 3);
  });

  it('records a missing robots.txt and finds /sitemap.xml directly', async () => {
    const { result } = await analyze({ [ROBOTS]: html('<h1>Not found</h1>', { status: 404 }), [SITEMAP]: xml(URLSET) });
    assert.equal(result.robots.robotsTxtExists, false);
    assert.equal(result.robots.robotsTxtStatus, 404);
    assert.equal(result.sitemap.sitemapExists, true);
    assert.equal(result.sitemap.sitemapSource, 'DEFAULT_PATH');
    assert.ok(result.evidence.some((e) => e.type === 'ROBOTS_MISSING'));
  });

  it('treats an HTML soft-404 robots.txt as missing', async () => {
    const { result } = await analyze({ [ROBOTS]: html('<!doctype html><html><body>Home</body></html>') });
    assert.equal(result.robots.robotsTxtExists, false);
    assert.equal(result.robots.robotsTxtStatus, 200);
  });

  it('records an unavailable sitemap after checking only a few locations', async () => {
    const { result, web } = await analyze({ [ROBOTS]: text('User-agent: *\nDisallow:') });
    assert.equal(result.sitemap.sitemapExists, false);
    assert.equal(result.sitemap.sitemapUrl, null);
    assert.equal(result.sitemap.checkedUrls.length, 2);
    assert.ok(result.evidence.some((e) => e.type === 'SITEMAP_MISSING'));
    assert.ok(web.requests.length <= 2 + 3, 'homepage + robots.txt + at most three sitemap candidates');
  });

  it('does not request sitemap locations disallowed by robots.txt', async () => {
    const { result, web } = await analyze({ [ROBOTS]: text('User-agent: *\nDisallow: /sitemap'), [SITEMAP]: xml(URLSET) });
    assert.equal(result.sitemap.sitemapExists, null);
    assert.ok(result.sitemap.checkedUrls.every((c) => c.outcome === 'DISALLOWED_BY_ROBOTS'));
    assert.ok(!web.requests.some((r) => r.url.includes('sitemap')));
  });

  it('keeps going when robots.txt cannot be fetched', async () => {
    const { result } = await analyze({ [ROBOTS]: { error: 'ECONNRESET' }, [SITEMAP]: xml(URLSET) });
    assert.equal(result.status, 'COMPLETED');
    assert.equal(result.robots.robotsTxtExists, null);
    assert.equal(result.robots.robotsErrorCode, 'CONNECTION_ERROR');
    assert.equal(result.sitemap.sitemapExists, true);
  });

  it('uses a <link rel="sitemap"> from the homepage', async () => {
    const web = createFakeWeb({
      [SITE]: html('<html><head><title>x</title><link rel="sitemap" type="application/xml" href="/custom-map.xml"></head></html>'),
      'https://abc-dental.com/custom-map.xml': xml(URLSET),
    });
    const result = await createTestAnalyzer(web).analyze({ websiteUrl: SITE });
    assert.equal(result.sitemap.sitemapSource, 'HTML_LINK');
    assert.equal(result.sitemap.sitemapUrl, 'https://abc-dental.com/custom-map.xml');
  });
});
