/**
 * Social profile links that actually appear on the website (anchor hrefs). No searching:
 * a platform is listed only when the page links to a specific profile on it. Share and
 * intent links, bare platform homepages and platform-owned pages are ignored.
 */

export const SOCIAL_PLATFORMS = ['Instagram', 'Facebook', 'LinkedIn', 'YouTube', 'X', 'TikTok', 'WhatsApp'];
const MAX_LINKS = 20;

const PLATFORM_HOSTS = [
  ['Instagram', /(^|\.)instagram\.com$/],
  ['Facebook', /(^|\.)(facebook\.com|fb\.com|fb\.me)$/],
  ['LinkedIn', /(^|\.)linkedin\.com$/],
  ['YouTube', /(^|\.)(youtube\.com|youtu\.be)$/],
  ['X', /(^|\.)(twitter\.com|x\.com)$/],
  ['TikTok', /(^|\.)tiktok\.com$/],
  ['WhatsApp', /(^|\.)(wa\.me|whatsapp\.com|api\.whatsapp\.com|chat\.whatsapp\.com|wa\.link)$/],
];

// Paths that are not a business profile: sharing widgets, logins, policies, embeds.
const IGNORED_PATH = {
  Instagram: /^\/(accounts|explore|about|legal|developer|p\/?$)/i,
  Facebook: /^\/(sharer|share|dialog|plugins|login|policies|privacy|help|tr\b|v\d)/i,
  LinkedIn: /^\/(share|sharing|shareArticle|feed|login|legal|help|signup)/i,
  YouTube: /^\/(embed|watch\?.*list=|results|t\/|about|premium|redirect|iframe_api)/i,
  X: /^\/(intent|share|home|i\/|search|login|privacy|tos)/i,
  TikTok: /^\/(embed|share|legal|login|about)/i,
  WhatsApp: /^\/(legal|privacy|download|business\/?$|features)/i,
};

const platformFor = (host) => PLATFORM_HOSTS.find(([, pattern]) => pattern.test(host))?.[0] ?? null;

const normalise = (url) => {
  const copy = new URL(url.href);
  copy.hash = '';
  if (copy.hostname.startsWith('m.') || copy.hostname.startsWith('mobile.')) {
    copy.hostname = copy.hostname.replace(/^(m|mobile)\./, 'www.');
  }
  // Tracking parameters are noise; profile identity is in the path (or WhatsApp's phone/text).
  for (const key of [...copy.searchParams.keys()]) {
    if (/^(utm_|fbclid|igshid|si$|ref$|hl$)/i.test(key)) copy.searchParams.delete(key);
  }
  return copy.href.replace(/\/$/, '');
};

/**
 * @param {string[]} hrefs absolute URLs found on the page
 * @param {string} [source] where the links were found
 * @returns {{ platform, url, source }[]}
 */
export const detectSocialLinks = (hrefs = [], source = 'WEBSITE') => {
  const seen = new Set();
  const out = [];
  for (const href of hrefs) {
    if (out.length >= MAX_LINKS) break;
    let url;
    try {
      url = new URL(href);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
    const platform = platformFor(url.hostname.toLowerCase());
    if (!platform) continue;
    const pathAndQuery = `${url.pathname}${url.search}`;
    const hasProfile = platform === 'WhatsApp' ? url.pathname.length > 1 || url.search.length > 1 : url.pathname.replace(/\/+$/, '').length > 1;
    if (!hasProfile || IGNORED_PATH[platform]?.test(pathAndQuery)) continue;
    const key = normalise(url).toLowerCase().replace(/^https?:\/\/(www\.)?/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ platform, url: normalise(url).slice(0, 500), source });
  }
  return out;
};
