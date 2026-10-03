import { Parser } from 'htmlparser2';

/**
 * Extracts factual signals from one HTML document in a single streaming pass.
 * Nothing here judges quality: counts and presence only. Raw HTML is never returned;
 * `signals` and `links` are internal inputs for technology and social detection.
 */

const MAX_TEXT = 300;
const MAX_JSON_LD_BLOCKS = 20;
const MAX_JSON_LD_BYTES = 100 * 1024;
const MAX_INLINE_SCRIPT_BYTES = 300 * 1024;
const MAX_LIST = 200;
const MAX_LINKS = 1000;
const MAX_CLASS_TOKENS = 4000;

const collapse = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
const clip = (text, max = MAX_TEXT) => (text.length > max ? text.slice(0, max) : text);
const pushCapped = (list, value, max = MAX_LIST) => {
  if (value && list.length < max) list.push(value);
};

const absoluteUrl = (href, base) => {
  if (!href) return null;
  try {
    return new URL(href.trim(), base);
  } catch {
    return null;
  }
};

const siteKey = (host) => host.toLowerCase().replace(/^www\./, '');

const SCHEMA_PREFIX = /^https?:\/\/schema\.org\//i;
const typeName = (value) => (typeof value === 'string' ? clip(value.replace(SCHEMA_PREFIX, '').trim(), 80) : null);

/** Collects @type values of top-level JSON-LD entities and @graph members. */
const jsonLdTypes = (data, out) => {
  const visit = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 2) return;
    if (Array.isArray(node)) {
      node.forEach((item) => visit(item, depth));
      return;
    }
    const types = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
    types.map(typeName).forEach((t) => t && out.add(t));
    if (Array.isArray(node['@graph'])) node['@graph'].forEach((item) => visit(item, depth + 1));
  };
  visit(data, 0);
};

const RESPONSIVE_PREFIX = /^(sm|md|lg|xl|2xl):[a-z]/;
const UTILITY_CLASS =
  /^-?(p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|gap|space-[xy]|w|h|min-w|max-w|min-h|text|bg|border|rounded|shadow|font|leading|tracking|grid-cols|col-span|z|inset|top|left|right|bottom|opacity)-[\w./[\]%-]+$/;

export const analyzeHtml = (html, { pageUrl }) => {
  let base = absoluteUrl(pageUrl, undefined);
  const pageHost = base ? siteKey(base.hostname) : null;

  const page = {
    title: null,
    metaDescription: null,
    canonicalUrl: null,
    lang: null,
    charset: null,
    viewport: null,
    metaRobots: null,
  };
  const headingCounts = { h1: 0, h2: 0, h3: 0, h4: 0, h5: 0, h6: 0 };
  const h1Text = [];
  const content = {
    imageCount: 0,
    imagesWithoutAltCount: 0,
    imagesWithEmptyAltCount: 0,
    internalLinkCount: 0,
    externalLinkCount: 0,
    telLinkCount: 0,
    mailtoLinkCount: 0,
  };
  const openGraph = {};
  const twitter = {};
  const jsonLd = { blocks: 0, invalid: 0, types: new Set() };
  const mobile = { deviceWidth: false, zoomDisabled: false, inlineMediaQueries: false, stylesheetMediaQueries: false, responsiveImages: false };
  const signals = {
    generators: [],
    scriptSrcs: [],
    linkHrefs: [],
    inlineScript: '',
    htmlAttributes: [],
    ids: [],
    classTokens: [],
    noscriptText: '',
  };
  const links = [];
  const sitemapLinks = [];

  let titleDone = false;
  let capture = null; // { kind, text }
  let inlineScriptBytes = 0;

  const startCapture = (kind) => {
    capture = { kind, text: '' };
  };
  // Line breaks and block elements separate words visually but contribute no text node.
  const WORD_BREAK_TAGS = new Set(['br', 'p', 'div', 'li', 'tr', 'td', 'th']);

  const parser = new Parser(
    {
      onopentag(name, attrs) {
        if (capture?.kind === 'h1' && WORD_BREAK_TAGS.has(name)) capture.text += ' ';
        const cls = attrs.class;
        if (cls && signals.classTokens.length < MAX_CLASS_TOKENS) {
          for (const token of cls.split(/\s+/)) if (token) pushCapped(signals.classTokens, token, MAX_CLASS_TOKENS);
        }
        if (attrs.id) pushCapped(signals.ids, attrs.id.slice(0, 60));
        for (const attr of Object.keys(attrs)) {
          if (attr.startsWith('data-wf-') || attr === 'data-reactroot' || attr.startsWith('ng-') || attr === 'data-n-head') {
            if (!signals.htmlAttributes.includes(attr)) pushCapped(signals.htmlAttributes, attr, 50);
          }
        }

        switch (name) {
          case 'html':
            if (attrs.lang) page.lang = clip(attrs.lang.trim(), 35);
            break;
          case 'base':
            if (attrs.href) base = absoluteUrl(attrs.href, base) ?? base;
            break;
          case 'title':
            if (!titleDone) startCapture('title');
            break;
          case 'meta': {
            const key = (attrs.name ?? attrs.property ?? '').trim().toLowerCase();
            const value = collapse(attrs.content);
            if (attrs.charset) page.charset = clip(attrs.charset.trim().toLowerCase(), 40);
            if ((attrs['http-equiv'] ?? '').toLowerCase() === 'content-type' && !page.charset) {
              page.charset = value.match(/charset\s*=\s*([\w.:-]+)/i)?.[1]?.toLowerCase() ?? null;
            }
            if (key === 'description' && page.metaDescription === null) page.metaDescription = clip(value, 1000);
            else if (key === 'viewport' && page.viewport === null) page.viewport = clip(value, 200);
            else if (key === 'robots' && page.metaRobots === null) page.metaRobots = clip(value, 200);
            else if (key === 'generator' && value) pushCapped(signals.generators, clip(value, 100), 10);
            else if (key.startsWith('og:') && value && Object.keys(openGraph).length < 30) {
              openGraph[key.slice(3, 40)] ??= clip(value, 500);
            } else if (key.startsWith('twitter:') && value && Object.keys(twitter).length < 30) {
              twitter[key.slice(8, 40)] ??= clip(value, 500);
            }
            break;
          }
          case 'link': {
            const rel = (attrs.rel ?? '').toLowerCase().split(/\s+/);
            const href = absoluteUrl(attrs.href, base);
            if (href) pushCapped(signals.linkHrefs, href.href.slice(0, 500));
            if (rel.includes('canonical') && href && page.canonicalUrl === null) page.canonicalUrl = href.href.slice(0, 2048);
            if (rel.includes('sitemap') && href) pushCapped(sitemapLinks, href.href, 5);
            if (rel.includes('stylesheet') && /\((min|max)-width/i.test(attrs.media ?? '')) mobile.stylesheetMediaQueries = true;
            break;
          }
          case 'h1':
          case 'h2':
          case 'h3':
          case 'h4':
          case 'h5':
          case 'h6':
            headingCounts[name] += 1;
            if (name === 'h1') startCapture('h1');
            break;
          case 'img':
            content.imageCount += 1;
            if (!('alt' in attrs)) content.imagesWithoutAltCount += 1;
            else if (attrs.alt.trim() === '') content.imagesWithEmptyAltCount += 1;
            if (attrs.srcset) mobile.responsiveImages = true;
            break;
          case 'picture':
            mobile.responsiveImages = true;
            break;
          case 'source':
            if (attrs.srcset && attrs.media) mobile.responsiveImages = true;
            break;
          case 'a': {
            const raw = (attrs.href ?? '').trim();
            if (!raw || raw.startsWith('#') || /^javascript:/i.test(raw)) break;
            if (/^tel:/i.test(raw)) {
              content.telLinkCount += 1;
              break;
            }
            if (/^mailto:/i.test(raw)) {
              content.mailtoLinkCount += 1;
              break;
            }
            const href = absoluteUrl(raw, base);
            if (!href || (href.protocol !== 'http:' && href.protocol !== 'https:')) break;
            if (pageHost && siteKey(href.hostname) === pageHost) content.internalLinkCount += 1;
            else content.externalLinkCount += 1;
            pushCapped(links, href.href.slice(0, 2048), MAX_LINKS);
            break;
          }
          case 'script': {
            const type = (attrs.type ?? '').toLowerCase();
            if (attrs.src) {
              const src = absoluteUrl(attrs.src, base);
              if (src) pushCapped(signals.scriptSrcs, src.href.slice(0, 500));
            } else if (type === 'application/ld+json') {
              startCapture('jsonld');
            } else if (!type || /javascript|module/.test(type)) {
              startCapture('script');
            }
            break;
          }
          case 'style':
            startCapture('style');
            break;
          case 'noscript':
            startCapture('noscript');
            break;
          default:
        }
      },
      ontext(text) {
        if (!capture) return;
        const limit = capture.kind === 'jsonld' ? MAX_JSON_LD_BYTES : capture.kind === 'script' ? 64 * 1024 : 4096;
        if (capture.text.length < limit) capture.text += text.slice(0, limit - capture.text.length);
      },
      onclosetag(name) {
        if (!capture) return;
        const { kind, text } = capture;
        const closes =
          (kind === 'title' && name === 'title') ||
          (kind === 'h1' && name === 'h1') ||
          ((kind === 'jsonld' || kind === 'script') && name === 'script') ||
          (kind === 'style' && name === 'style') ||
          (kind === 'noscript' && name === 'noscript');
        if (!closes) return;
        capture = null;
        if (kind === 'title') {
          page.title = clip(collapse(text)) || null;
          titleDone = true;
        } else if (kind === 'h1') {
          const value = clip(collapse(text), 200);
          if (value && h1Text.length < 3) h1Text.push(value);
        } else if (kind === 'jsonld') {
          if (jsonLd.blocks + jsonLd.invalid >= MAX_JSON_LD_BLOCKS) return;
          try {
            jsonLdTypes(JSON.parse(text), jsonLd.types);
            jsonLd.blocks += 1;
          } catch {
            jsonLd.invalid += 1;
          }
        } else if (kind === 'script') {
          if (inlineScriptBytes < MAX_INLINE_SCRIPT_BYTES) {
            const piece = text.slice(0, MAX_INLINE_SCRIPT_BYTES - inlineScriptBytes);
            signals.inlineScript += `${piece}\n`;
            inlineScriptBytes += piece.length;
          }
        } else if (kind === 'style') {
          if (/@media[^{]*\((min|max)-width/i.test(text)) mobile.inlineMediaQueries = true;
        } else if (kind === 'noscript') {
          signals.noscriptText = clip(collapse(text), 300);
        }
      },
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true, recognizeSelfClosing: true },
  );
  parser.write(String(html ?? ''));
  parser.end();

  if (page.viewport) {
    const v = page.viewport.toLowerCase().replace(/\s+/g, '');
    mobile.deviceWidth = v.includes('width=device-width');
    mobile.zoomDisabled = v.includes('user-scalable=no') || v.includes('user-scalable=0') || /maximum-scale=1(\.0)?(,|$)/.test(v);
  }

  const headingCount = Object.values(headingCounts).reduce((a, b) => a + b, 0);
  const mobileSignals = [
    page.viewport ? 'viewport_present' : 'viewport_missing',
    mobile.deviceWidth && 'viewport_device_width',
    mobile.zoomDisabled && 'viewport_zoom_disabled',
    mobile.inlineMediaQueries && 'inline_css_width_media_queries',
    mobile.stylesheetMediaQueries && 'stylesheet_width_media_queries',
    mobile.responsiveImages && 'responsive_images',
  ].filter(Boolean);

  const utilityTokens = signals.classTokens.filter((t) => UTILITY_CLASS.test(t)).length;
  const responsiveTokens = signals.classTokens.filter((t) => RESPONSIVE_PREFIX.test(t)).length;

  return {
    page: {
      ...page,
      titleLength: page.title ? page.title.length : 0,
      metaDescriptionLength: page.metaDescription ? page.metaDescription.length : 0,
    },
    content: {
      hasH1: headingCounts.h1 > 0,
      h1Count: headingCounts.h1,
      h1Text,
      headingCount,
      headingCounts,
      ...content,
    },
    structuredData: {
      hasJsonLd: jsonLd.blocks > 0,
      jsonLdBlockCount: jsonLd.blocks,
      jsonLdInvalidBlockCount: jsonLd.invalid,
      jsonLdTypes: [...jsonLd.types].slice(0, 30),
      openGraph: { present: Object.keys(openGraph).length > 0, tags: openGraph },
      twitterCard: { present: Object.keys(twitter).length > 0, card: twitter.card ?? null, tags: twitter },
    },
    mobile: {
      hasViewport: Boolean(page.viewport),
      viewportStatus: page.viewport ? 'viewport_present' : 'viewport_missing',
      viewportContent: page.viewport,
      mobileSignals,
    },
    sitemapLinks,
    links,
    signals: { ...signals, utilityClassCount: utilityTokens, responsiveClassCount: responsiveTokens },
  };
};
