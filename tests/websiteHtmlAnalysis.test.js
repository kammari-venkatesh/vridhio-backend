import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildEvidence, EVIDENCE_TYPES } from '../src/services/websiteAnalysis/evidenceBuilder.js';
import { analyzeHtml } from '../src/services/websiteAnalysis/htmlAnalyzer.js';
import { detectSocialLinks } from '../src/services/websiteAnalysis/socialDetector.js';
import { detectTechnologies } from '../src/services/websiteAnalysis/technologyDetector.js';
import { createFakeWeb, createTestAnalyzer, fixture, html, text } from './helpers/fakeWeb.js';

const parse = (name, pageUrl = 'https://abc-dental.com/') => analyzeHtml(fixture(name), { pageUrl });
const techOf = (name, headers = {}) => detectTechnologies({ headers, signals: parse(name).signals });
const tech = (list, name) => list.find((t) => t.name === name);

describe('HTML analysis', () => {
  it('extracts page metadata from a complete website', () => {
    const { page } = parse('complete.html');
    assert.equal(page.title, 'ABC Dental Clinic | Family Dentist in Pune');
    assert.equal(page.titleLength, page.title.length);
    assert.match(page.metaDescription, /^ABC Dental Clinic offers/);
    assert.equal(page.metaDescriptionLength, page.metaDescription.length);
    assert.equal(page.canonicalUrl, 'https://abc-dental.com/');
    assert.equal(page.lang, 'en-IN');
    assert.equal(page.charset, 'utf-8');
    assert.equal(page.viewport, 'width=device-width, initial-scale=1');
  });

  it('reports missing title, description, viewport and canonical as absent', () => {
    const { page, mobile } = parse('minimal.html');
    assert.equal(page.title, null);
    assert.equal(page.titleLength, 0);
    assert.equal(page.metaDescription, null);
    assert.equal(page.canonicalUrl, null);
    assert.equal(mobile.hasViewport, false);
    assert.equal(mobile.viewportStatus, 'viewport_missing');
    assert.equal(parse('seo-poor.html').page.title, null, 'an empty <title> counts as missing');
  });

  it('counts headings and H1s', () => {
    const complete = parse('complete.html').content;
    assert.equal(complete.hasH1, true);
    assert.equal(complete.h1Count, 1);
    assert.deepEqual(complete.h1Text, ['Gentle dental care for the whole family']);
    assert.equal(complete.headingCount, 3);
    assert.equal(parse('minimal.html').content.hasH1, false);
    const poor = parse('seo-poor.html').content;
    assert.equal(poor.h1Count, 2);
    assert.equal(poor.headingCounts.h2, 1);
  });

  it('keeps words apart when an H1 contains line breaks or nested blocks', () => {
    const { content } = analyzeHtml(
      '<h1>Buy. Sell. <span>Invest.</span><br>With confidence.</h1><h1>Plots<div>and farm lands</div></h1>',
      { pageUrl: 'https://example.com/' },
    );
    assert.deepEqual(content.h1Text, ['Buy. Sell. Invest. With confidence.', 'Plots and farm lands']);
  });

  it('counts images without alt attributes separately from decorative empty alts', () => {
    const { content } = parse('seo-poor.html');
    assert.equal(content.imageCount, 4);
    assert.equal(content.imagesWithoutAltCount, 2);
    assert.equal(content.imagesWithEmptyAltCount, 1);
    assert.equal(parse('complete.html').content.imagesWithoutAltCount, 0);
  });

  it('classifies internal, external, tel and mailto links', () => {
    const { content } = parse('complete.html');
    assert.equal(content.internalLinkCount, 3);
    assert.equal(content.externalLinkCount, 1);
    assert.equal(content.telLinkCount, 1);
    assert.equal(content.mailtoLinkCount, 1);
  });

  it('detects Open Graph and Twitter/X card metadata', () => {
    const { structuredData } = parse('complete.html');
    assert.equal(structuredData.openGraph.present, true);
    assert.deepEqual(Object.keys(structuredData.openGraph.tags).sort(), ['image', 'title', 'type']);
    assert.equal(structuredData.twitterCard.present, true);
    assert.equal(structuredData.twitterCard.card, 'summary_large_image');
    assert.equal(parse('minimal.html').structuredData.openGraph.present, false);
  });

  it('detects JSON-LD blocks and their types, without judging correctness', () => {
    const { structuredData } = parse('structured-data.html');
    assert.equal(structuredData.hasJsonLd, true);
    assert.equal(structuredData.jsonLdBlockCount, 2);
    assert.equal(structuredData.jsonLdInvalidBlockCount, 1);
    assert.deepEqual(structuredData.jsonLdTypes.sort(), ['BreadcrumbList', 'LocalBusiness', 'Product', 'Restaurant', 'WebSite']);
    assert.deepEqual(parse('complete.html').structuredData.jsonLdTypes, ['Dentist']);
    assert.equal(parse('minimal.html').structuredData.hasJsonLd, false);
  });

  it('records mobile signals without claiming the site is mobile-friendly', () => {
    const { mobile } = parse('complete.html');
    assert.equal(mobile.viewportStatus, 'viewport_present');
    assert.deepEqual(mobile.mobileSignals, [
      'viewport_present',
      'viewport_device_width',
      'inline_css_width_media_queries',
      'stylesheet_width_media_queries',
      'responsive_images',
    ]);
    assert.equal('mobileFriendly' in mobile, false);
  });

  it('never returns raw HTML', () => {
    const result = parse('wordpress.html');
    const exposed = JSON.stringify({ page: result.page, content: result.content, structuredData: result.structuredData, mobile: result.mobile });
    assert.doesNotMatch(exposed, /<script|<html|<body/i);
  });
});

describe('Technology detection', () => {
  it('detects WordPress, jQuery, Google Analytics and Meta Pixel with evidence', () => {
    const found = techOf('wordpress.html');
    assert.deepEqual(tech(found, 'WordPress'), {
      name: 'WordPress',
      category: 'CMS',
      confidence: 'HIGH',
      evidence: 'meta generator names WordPress',
    });
    assert.equal(tech(found, 'jQuery').confidence, 'HIGH');
    assert.equal(tech(found, 'Google Analytics').confidence, 'HIGH');
    assert.equal(tech(found, 'Meta Pixel').confidence, 'HIGH');
    assert.equal(tech(found, 'Shopify'), undefined);
  });

  it('detects Shopify from its CDN and response headers', () => {
    const found = techOf('shopify.html', { 'x-shopify-stage': 'production' });
    assert.equal(tech(found, 'Shopify').confidence, 'HIGH');
    assert.equal(tech(found, 'WordPress'), undefined);
  });

  it('detects React and a Vite-style bundle with appropriate confidence', () => {
    const found = techOf('react.html');
    assert.equal(tech(found, 'React').confidence, 'HIGH');
    assert.equal(tech(found, 'React').evidence, 'React library script detected');
    assert.equal(tech(found, 'Vite').confidence, 'LOW');
  });

  it('detects Next.js and infers React only at MEDIUM confidence', () => {
    const signals = analyzeHtml('<html><body><script id="__NEXT_DATA__" type="application/json">{}</script><script src="/_next/static/chunks/main.js"></script></body></html>', { pageUrl: 'https://n.com/' }).signals;
    const found = detectTechnologies({ signals });
    assert.equal(tech(found, 'Next.js').confidence, 'HIGH');
    assert.deepEqual(tech(found, 'React'), { name: 'React', category: 'JavaScript library', confidence: 'MEDIUM', evidence: 'implied by Next.js' });
  });

  it('detects Wix, Webflow, Squarespace, Bootstrap, Tailwind, GTM and Cloudflare markers', () => {
    const page = `<html data-wf-site="1" data-wf-page="2"><head>
      <meta name="generator" content="Wix.com Website Builder">
      <link rel="stylesheet" href="https://static1.squarespace.com/site.css">
      <link rel="stylesheet" href="https://cdn.example-cdn.net/bootstrap.min.css">
      <script src="https://cdn.tailwindcss.com"></script>
      <script>(function(w,d,s,l,i){})(window,document,'script','dataLayer','GTM-AB12CD');</script>
    </head><body></body></html>`;
    const found = detectTechnologies({ headers: { server: 'cloudflare' }, signals: analyzeHtml(page, { pageUrl: 'https://x.com/' }).signals });
    for (const name of ['Wix', 'Webflow', 'Squarespace', 'Bootstrap', 'Tailwind CSS', 'Google Tag Manager', 'Cloudflare']) {
      assert.equal(tech(found, name)?.confidence, 'HIGH', name);
    }
  });

  it('marks utility-class heuristics as LOW confidence', () => {
    const classes = 'px-4 py-2 mt-4 mb-2 text-sm bg-white rounded-lg shadow-md font-bold gap-4 w-full h-10 md:flex lg:grid sm:px-2 p-4 m-2 border-gray-200';
    const signals = analyzeHtml(`<div class="${classes}"></div>`, { pageUrl: 'https://x.com/' }).signals;
    assert.deepEqual(tech(detectTechnologies({ signals }), 'Tailwind CSS'), {
      name: 'Tailwind CSS',
      category: 'CSS framework',
      confidence: 'LOW',
      evidence: 'many Tailwind-style utility class names',
    });
  });

  it('reports nothing for an unknown website', () => {
    assert.deepEqual(techOf('minimal.html'), []);
    assert.deepEqual(techOf('complete.html'), []);
  });
});

describe('Social link detection', () => {
  const links = parse('social-links.html', 'https://urbanbites.com/').links;

  it('finds profile links for every supported platform once each', () => {
    const found = detectSocialLinks(links);
    assert.deepEqual(
      found.map((l) => l.platform),
      ['Instagram', 'Facebook', 'LinkedIn', 'YouTube', 'X', 'TikTok', 'WhatsApp'],
    );
    assert.deepEqual(found[0], { platform: 'Instagram', url: 'https://www.instagram.com/urbanbites.cafe', source: 'WEBSITE' });
    assert.equal(found[1].url, 'https://www.facebook.com/UrbanBitesCafe');
    assert.equal(found[2].url, 'https://www.linkedin.com/company/urban-bites');
  });

  it('ignores share widgets, intent links and bare platform homepages', () => {
    const urls = detectSocialLinks(links).map((l) => l.url).join(' ');
    assert.doesNotMatch(urls, /sharer|intent/);
    assert.equal(detectSocialLinks(['https://www.instagram.com/', 'https://facebook.com']).length, 0);
  });

  it('lists a WhatsApp number once, whatever message text each link pre-fills', () => {
    const found = detectSocialLinks([
      'https://wa.me/919800000000?text=Hello',
      'https://wa.me/919800000000?text=Office+space+for+rent',
      'https://api.whatsapp.com/send?phone=919800000000&text=Hi',
      'https://www.instagram.com/realty.co',
    ]);
    assert.deepEqual(
      found.map((l) => l.url),
      ['https://wa.me/919800000000', 'https://www.instagram.com/realty.co'],
    );
  });

  it('returns no social links when the page has none', () => {
    assert.deepEqual(detectSocialLinks(parse('complete.html').links), []);
    assert.deepEqual(detectSocialLinks([]), []);
  });
});

describe('Evidence', () => {
  const SITE = 'https://abc-dental.com/';
  const run = (routes) => createTestAnalyzer(createFakeWeb(routes)).analyze({ websiteUrl: SITE });

  it('builds factual evidence for an SEO-poor website, with no score or recommendation', async () => {
    const result = await run({ [SITE]: html(fixture('seo-poor.html')) });
    const types = result.evidence.map((e) => e.type);
    for (const type of ['MISSING_TITLE', 'MISSING_META_DESCRIPTION', 'MISSING_VIEWPORT', 'MISSING_CANONICAL', 'IMAGES_WITHOUT_ALT', 'HTTPS_PRESENT', 'MULTIPLE_H1']) {
      assert.ok(types.includes(type), type);
    }
    assert.equal(result.evidence.find((e) => e.type === 'IMAGES_WITHOUT_ALT').evidence, '2 of 4 images have no alt attribute.');
    assert.ok(result.evidence.every((e) => EVIDENCE_TYPES.includes(e.type)));
    const serialized = JSON.stringify(result).toLowerCase();
    for (const banned of ['score', 'recommend', 'needs seo', 'should ', 'qualif']) assert.ok(!serialized.includes(banned), banned);
  });

  it('builds presence evidence for a complete website', async () => {
    const result = await run({
      [SITE]: html(fixture('complete.html')),
      'https://abc-dental.com/robots.txt': text('User-agent: *\nAllow: /\nSitemap: https://abc-dental.com/sitemap.xml'),
      'https://abc-dental.com/sitemap.xml': { status: 200, headers: { 'content-type': 'application/xml' }, body: '<?xml version="1.0"?><urlset></urlset>' },
    });
    const types = result.evidence.map((e) => e.type);
    for (const type of ['HTTPS_PRESENT', 'VIEWPORT_PRESENT', 'CANONICAL_PRESENT', 'ROBOTS_PRESENT', 'SITEMAP_PRESENT', 'JSON_LD_PRESENT', 'OPEN_GRAPH_PRESENT', 'TWITTER_CARD_PRESENT']) {
      assert.ok(types.includes(type), type);
    }
    assert.ok(!types.includes('MISSING_TITLE'));
    assert.ok(!types.includes('MISSING_H1'));
  });

  it('adds technology and social evidence items', () => {
    const evidence = buildEvidence({
      availability: { redirectCount: 0, https: true },
      page: { title: 't', metaDescription: 'd', canonicalUrl: 'c' },
      content: { hasH1: true, h1Count: 1, imagesWithoutAltCount: 0, imageCount: 0 },
      structuredData: { hasJsonLd: false, jsonLdTypes: [], openGraph: { present: false, tags: {} }, twitterCard: { present: false } },
      mobile: { hasViewport: true, viewportContent: 'width=device-width' },
      robots: { robotsTxtExists: null },
      sitemap: { sitemapExists: null, checkedUrls: [] },
      technologies: [{ name: 'WordPress', confidence: 'HIGH', evidence: 'wp-content / wp-includes asset path detected' }],
      socialLinks: [{ platform: 'Instagram', url: 'https://www.instagram.com/x', source: 'WEBSITE' }],
    });
    assert.deepEqual(evidence.find((e) => e.type === 'TECHNOLOGY_DETECTED'), {
      type: 'TECHNOLOGY_DETECTED',
      severity: 'INFO',
      evidence: 'WordPress (HIGH confidence): wp-content / wp-includes asset path detected.',
      source: 'HTML',
    });
    assert.equal(evidence.find((e) => e.type === 'SOCIAL_LINK_FOUND').evidence, 'Instagram link on the website: https://www.instagram.com/x');
  });
});
