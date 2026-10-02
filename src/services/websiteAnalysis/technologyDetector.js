/**
 * Lightweight technology detection from public evidence only: response headers, meta
 * generator tags, script/stylesheet URLs, inline script markers and HTML attributes.
 * Each result names the evidence that matched. Confidence:
 *   HIGH   — a marker specific to the technology (e.g. /wp-content/ assets, cdn.shopify.com)
 *   MEDIUM — a strong but indirect marker (e.g. React implied by Next.js)
 *   LOW    — a heuristic (e.g. many Tailwind-style utility class names)
 */

export const CONFIDENCE = Object.freeze({ HIGH: 'HIGH', MEDIUM: 'MEDIUM', LOW: 'LOW' });
const RANK = { HIGH: 3, MEDIUM: 2, LOW: 1 };

const header = (headers, name) => {
  const value = headers?.[name];
  return String(Array.isArray(value) ? value.join(', ') : (value ?? ''));
};

const anyMatch = (list, pattern) => list.find((item) => pattern.test(item)) ?? null;

/**
 * Rules: each returns an evidence string or null. Order inside a technology matters
 * only for which evidence string is reported when several match at the same confidence.
 */
const RULES = [
  {
    name: 'WordPress',
    category: 'CMS',
    checks: [
      [CONFIDENCE.HIGH, (s) => (anyMatch(s.generators, /wordpress/i) ? 'meta generator names WordPress' : null)],
      [CONFIDENCE.HIGH, (s) => (anyMatch(s.assets, /\/wp-(content|includes)\//i) ? 'wp-content / wp-includes asset path detected' : null)],
      [CONFIDENCE.MEDIUM, (s) => (/\/wp-json\//i.test(s.linkText) ? 'wp-json REST API link detected' : null)],
    ],
  },
  {
    name: 'Shopify',
    category: 'E-commerce',
    checks: [
      [CONFIDENCE.HIGH, (s) => (anyMatch(s.assets, /cdn\.shopify\.com|\/cdn\/shop\//i) ? 'Shopify CDN asset detected' : null)],
      [CONFIDENCE.HIGH, (s) => (header(s.headers, 'x-shopify-stage') || header(s.headers, 'x-shopid') ? 'Shopify response header present' : null)],
      [CONFIDENCE.MEDIUM, (s) => (/\bShopify\.(theme|shop|routes)\b/.test(s.inlineScript) ? 'Shopify storefront script object detected' : null)],
    ],
  },
  {
    name: 'Wix',
    category: 'Website builder',
    checks: [
      [CONFIDENCE.HIGH, (s) => (anyMatch(s.generators, /wix\.com/i) ? 'meta generator names Wix' : null)],
      [CONFIDENCE.HIGH, (s) => (header(s.headers, 'x-wix-request-id') ? 'Wix response header present' : null)],
      [CONFIDENCE.HIGH, (s) => (anyMatch(s.assets, /static\.wixstatic\.com|static\.parastorage\.com/i) ? 'Wix static asset host detected' : null)],
    ],
  },
  {
    name: 'Webflow',
    category: 'Website builder',
    checks: [
      [CONFIDENCE.HIGH, (s) => (s.htmlAttributes.some((a) => a === 'data-wf-site' || a === 'data-wf-page') ? 'data-wf-site / data-wf-page attribute present' : null)],
      [CONFIDENCE.HIGH, (s) => (anyMatch(s.generators, /webflow/i) ? 'meta generator names Webflow' : null)],
      [CONFIDENCE.MEDIUM, (s) => (anyMatch(s.assets, /website-files\.com|assets\.webflow\.com/i) ? 'Webflow asset host detected' : null)],
    ],
  },
  {
    name: 'Squarespace',
    category: 'Website builder',
    checks: [
      [CONFIDENCE.HIGH, (s) => (anyMatch(s.assets, /static1\.squarespace\.com|assets\.squarespace\.com/i) ? 'Squarespace asset host detected' : null)],
      [CONFIDENCE.HIGH, (s) => (anyMatch(s.generators, /squarespace/i) ? 'meta generator names Squarespace' : null)],
    ],
  },
  {
    name: 'Next.js',
    category: 'JavaScript framework',
    checks: [
      [CONFIDENCE.HIGH, (s) => (s.ids.includes('__NEXT_DATA__') ? '__NEXT_DATA__ script present' : null)],
      [CONFIDENCE.HIGH, (s) => (anyMatch(s.assets, /\/_next\/static\//) ? '/_next/static/ asset path detected' : null)],
      [CONFIDENCE.HIGH, (s) => (/next\.js/i.test(header(s.headers, 'x-powered-by')) ? 'X-Powered-By header names Next.js' : null)],
    ],
  },
  {
    name: 'React',
    category: 'JavaScript library',
    checks: [
      [CONFIDENCE.HIGH, (s) => (anyMatch(s.scriptSrcs, /\breact(-dom)?([.-]\d[\w.]*)?(\.production|\.development)?(\.min)?\.js\b/i) ? 'React library script detected' : null)],
      [CONFIDENCE.MEDIUM, (s) => (s.htmlAttributes.includes('data-reactroot') ? 'data-reactroot attribute present' : null)],
      [CONFIDENCE.MEDIUM, (s) => (s.ids.includes('__NEXT_DATA__') || anyMatch(s.assets, /\/_next\/static\//) ? 'implied by Next.js' : null)],
      [CONFIDENCE.MEDIUM, (s) => (s.ids.includes('___gatsby') ? 'implied by Gatsby root element' : null)],
      [CONFIDENCE.LOW, (s) => (/__REACT_DEVTOOLS_GLOBAL_HOOK__|react-dom/.test(s.inlineScript) ? 'React marker in inline script' : null)],
      [CONFIDENCE.LOW, (s) => (s.ids.includes('root') && /enable javascript to run this app/i.test(s.noscriptText) ? 'single-page app root element with React-style noscript text' : null)],
    ],
  },
  {
    name: 'Vite',
    category: 'Build tool',
    checks: [
      [CONFIDENCE.HIGH, (s) => (anyMatch(s.scriptSrcs, /\/@vite\/client/) ? '/@vite/client script detected' : null)],
      [CONFIDENCE.LOW, (s) => (anyMatch(s.scriptSrcs, /\/assets\/index-[\w-]{8,}\.js$/) ? 'Vite-style hashed /assets/index-*.js bundle' : null)],
    ],
  },
  {
    name: 'Bootstrap',
    category: 'CSS framework',
    checks: [
      [CONFIDENCE.HIGH, (s) => (anyMatch(s.assets, /bootstrap(\.bundle)?(\.min)?\.(css|js)\b/i) ? 'Bootstrap stylesheet or script detected' : null)],
      [CONFIDENCE.LOW, (s) => (s.classTokens.includes('container') && s.classTokens.includes('row') && s.classTokens.some((t) => /^col-(sm|md|lg|xl)-\d+$/.test(t)) ? 'Bootstrap-style grid class names' : null)],
    ],
  },
  {
    name: 'Tailwind CSS',
    category: 'CSS framework',
    checks: [
      [CONFIDENCE.HIGH, (s) => (anyMatch(s.assets, /cdn\.tailwindcss\.com|tailwind(\.min)?\.css/i) ? 'Tailwind CSS stylesheet or CDN script detected' : null)],
      [CONFIDENCE.LOW, (s) => (s.utilityClassCount >= 15 && s.responsiveClassCount >= 3 ? 'many Tailwind-style utility class names' : null)],
    ],
  },
  {
    name: 'jQuery',
    category: 'JavaScript library',
    checks: [[CONFIDENCE.HIGH, (s) => (anyMatch(s.scriptSrcs, /jquery([.-]\d[\w.]*)?(\.min)?\.js\b/i) ? 'jQuery script detected' : null)]],
  },
  {
    name: 'Google Analytics',
    category: 'Analytics',
    checks: [
      [CONFIDENCE.HIGH, (s) => (anyMatch(s.scriptSrcs, /googletagmanager\.com\/gtag\/js\?id=(G|UA)-/i) ? 'gtag.js loaded with an Analytics ID' : null)],
      [CONFIDENCE.HIGH, (s) => (anyMatch(s.scriptSrcs, /google-analytics\.com\/(analytics|ga)\.js/i) ? 'analytics.js script detected' : null)],
      [CONFIDENCE.HIGH, (s) => (/gtag\(\s*['"]config['"]\s*,\s*['"](G|UA)-/i.test(s.inlineScript) ? 'gtag config call with an Analytics ID' : null)],
    ],
  },
  {
    name: 'Google Tag Manager',
    category: 'Tag manager',
    checks: [
      [CONFIDENCE.HIGH, (s) => (anyMatch(s.scriptSrcs, /googletagmanager\.com\/gtm\.js/i) ? 'gtm.js script detected' : null)],
      [CONFIDENCE.HIGH, (s) => (/googletagmanager\.com\/gtm\.js|['"]GTM-[A-Z0-9]{4,}['"]/.test(s.inlineScript) ? 'GTM container snippet detected' : null)],
    ],
  },
  {
    name: 'Meta Pixel',
    category: 'Advertising',
    checks: [
      [CONFIDENCE.HIGH, (s) => (anyMatch(s.scriptSrcs, /connect\.facebook\.net\/[\w_]+\/fbevents\.js/i) ? 'fbevents.js script detected' : null)],
      [CONFIDENCE.HIGH, (s) => (/fbq\(\s*['"]init['"]/.test(s.inlineScript) || /connect\.facebook\.net\/[\w_]+\/fbevents\.js/.test(s.inlineScript) ? 'Meta Pixel init snippet detected' : null)],
    ],
  },
  {
    name: 'Cloudflare',
    category: 'CDN',
    checks: [[CONFIDENCE.HIGH, (s) => (/cloudflare/i.test(header(s.headers, 'server')) || header(s.headers, 'cf-ray') ? 'Cloudflare response header present' : null)]],
  },
];

/**
 * @param {object} input { headers, signals } where signals come from analyzeHtml (may be
 *   absent when no HTML was retrieved; header-only detection still runs).
 * @returns {{ name, category, confidence, evidence }[]} highest-confidence evidence per technology
 */
export const detectTechnologies = ({ headers = {}, signals = null } = {}) => {
  const s = {
    headers,
    generators: signals?.generators ?? [],
    scriptSrcs: signals?.scriptSrcs ?? [],
    linkHrefs: signals?.linkHrefs ?? [],
    inlineScript: signals?.inlineScript ?? '',
    htmlAttributes: signals?.htmlAttributes ?? [],
    ids: signals?.ids ?? [],
    classTokens: signals?.classTokens ?? [],
    noscriptText: signals?.noscriptText ?? '',
    utilityClassCount: signals?.utilityClassCount ?? 0,
    responsiveClassCount: signals?.responsiveClassCount ?? 0,
  };
  s.assets = [...s.scriptSrcs, ...s.linkHrefs];
  s.linkText = s.linkHrefs.join('\n');

  const found = [];
  for (const rule of RULES) {
    let best = null;
    for (const [confidence, check] of rule.checks) {
      const evidence = check(s);
      if (evidence && (!best || RANK[confidence] > RANK[best.confidence])) best = { confidence, evidence };
    }
    if (best) found.push({ name: rule.name, category: rule.category, ...best });
  }
  return found;
};
