/**
 * Sitemap discovery without crawling: candidates come from robots.txt Sitemap lines,
 * <link rel="sitemap"> in the homepage, then the conventional /sitemap.xml and
 * /sitemap_index.xml. Only the first few kilobytes of a candidate are read to recognise it.
 */

export const SITEMAP_SOURCES = Object.freeze({ ROBOTS: 'ROBOTS', HTML_LINK: 'HTML_LINK', DEFAULT_PATH: 'DEFAULT_PATH' });

const DEFAULT_PATHS = ['/sitemap.xml', '/sitemap_index.xml'];

/** Ordered, de-duplicated http(s) candidates: [{ url, source }]. */
export const sitemapCandidates = ({ origin, robotsSitemaps = [], htmlSitemaps = [], max = 3 }) => {
  const seen = new Set();
  const out = [];
  const add = (raw, source) => {
    let url;
    try {
      url = new URL(raw, origin);
    } catch {
      return;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
    url.hash = '';
    if (seen.has(url.href)) return;
    seen.add(url.href);
    out.push({ url: url.href, source });
  };
  robotsSitemaps.forEach((u) => add(u, SITEMAP_SOURCES.ROBOTS));
  htmlSitemaps.forEach((u) => add(u, SITEMAP_SOURCES.HTML_LINK));
  DEFAULT_PATHS.forEach((p) => add(p, SITEMAP_SOURCES.DEFAULT_PATH));
  return out.slice(0, max);
};

const XML_TYPES = /(xml|text\/plain|gzip|octet-stream)/;

/**
 * Classifies a fetched candidate. A sitemap must answer 2xx and look like a sitemap
 * (<urlset> / <sitemapindex>, or a gzip file whose name says sitemap); an HTML page at
 * /sitemap.xml is a soft 404, not a sitemap.
 */
export const classifySitemapResponse = (response) => {
  if (!response || response.status < 200 || response.status >= 300) return { exists: false, kind: null };
  const type = response.contentType ?? '';
  if (/gzip/.test(type) || /\.xml\.gz$/i.test(response.finalUrl ?? '')) {
    return { exists: true, kind: 'gzip' };
  }
  const head = String(response.body ?? '').slice(0, 4096);
  if (/<sitemapindex[\s>]/i.test(head)) return { exists: true, kind: 'sitemapindex' };
  if (/<urlset[\s>]/i.test(head)) return { exists: true, kind: 'urlset' };
  if (type && !XML_TYPES.test(type)) return { exists: false, kind: null };
  return { exists: false, kind: null };
};

export const isSitemapContentType = (mime) => !mime || XML_TYPES.test(mime);
