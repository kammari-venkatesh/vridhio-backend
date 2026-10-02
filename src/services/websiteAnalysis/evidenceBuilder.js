/**
 * Turns analysis facts into a list of evidence items: { type, severity, evidence, source }.
 * Evidence states what was observed, never what the business needs. There is no score.
 *
 * Severity describes the observation, not a recommendation:
 *   INFO    — something present or neutral
 *   NOTICE  — something commonly expected that was not found
 *   WARNING — the website could not be retrieved as requested
 */

export const EVIDENCE_TYPES = Object.freeze([
  'NO_WEBSITE',
  'INVALID_WEBSITE_URL',
  'UNSAFE_WEBSITE_URL',
  'WEBSITE_UNREACHABLE',
  'HTTP_ERROR',
  'ACCESS_BLOCKED',
  'NON_HTML_RESPONSE',
  'HTTPS_PRESENT',
  'HTTPS_MISSING',
  'REDIRECTED',
  'MISSING_TITLE',
  'MISSING_META_DESCRIPTION',
  'VIEWPORT_PRESENT',
  'MISSING_VIEWPORT',
  'CANONICAL_PRESENT',
  'MISSING_CANONICAL',
  'MISSING_H1',
  'MULTIPLE_H1',
  'IMAGES_WITHOUT_ALT',
  'ROBOTS_PRESENT',
  'ROBOTS_MISSING',
  'SITEMAP_PRESENT',
  'SITEMAP_MISSING',
  'JSON_LD_PRESENT',
  'OPEN_GRAPH_PRESENT',
  'TWITTER_CARD_PRESENT',
  'SOCIAL_LINK_FOUND',
  'TECHNOLOGY_DETECTED',
]);
export const EVIDENCE_SEVERITIES = Object.freeze(['INFO', 'NOTICE', 'WARNING']);
export const EVIDENCE_SOURCES = Object.freeze(['RECORD', 'HTTP', 'HTML', 'ROBOTS', 'SITEMAP']);

const item = (type, severity, evidence, source) => ({ type, severity, evidence, source });
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const UNREACHABLE_WORDING = {
  DNS_ERROR: 'The domain name could not be resolved.',
  TIMEOUT: 'The website did not respond within the time limit.',
  CONNECTION_ERROR: 'A connection could not be established or was interrupted.',
  TLS_ERROR: 'The HTTPS certificate or TLS connection could not be verified.',
  TOO_MANY_REDIRECTS: 'The website redirected more times than allowed.',
  REDIRECT_LOOP: 'The website redirects in a loop.',
  RESPONSE_TOO_LARGE: 'The homepage was larger than the analysis size limit.',
  INVALID_RESPONSE: 'The response could not be read.',
};

/** Evidence for an analysis that stopped before HTML could be inspected. */
export const buildFailureEvidence = ({ errorCode, availability = {}, attempts = 1 }) => {
  const tried = attempts > 1 ? ` (${attempts} attempts)` : '';
  switch (errorCode) {
    case 'NO_WEBSITE':
      return [item('NO_WEBSITE', 'NOTICE', 'No website is recorded for this business.', 'RECORD')];
    case 'INVALID_URL':
      return [item('INVALID_WEBSITE_URL', 'NOTICE', 'The recorded website is not a valid http(s) address.', 'RECORD')];
    case 'UNSAFE_URL':
      return [
        item(
          'UNSAFE_WEBSITE_URL',
          'WARNING',
          'The website address points to a private, local or reserved network address, so it was not requested.',
          'RECORD',
        ),
      ];
    case 'HTTP_ERROR':
      return [item('HTTP_ERROR', 'WARNING', `The homepage responded with HTTP ${availability.httpStatus}${tried}.`, 'HTTP')];
    case 'BLOCKED':
      return [
        item(
          'ACCESS_BLOCKED',
          'WARNING',
          `The website refused automated access${availability.httpStatus ? ` (HTTP ${availability.httpStatus})` : ''}; its content was not inspected.`,
          'HTTP',
        ),
      ];
    case 'NON_HTML':
      return [
        item(
          'NON_HTML_RESPONSE',
          'NOTICE',
          `The website address returned ${availability.contentType ?? 'a non-HTML response'} instead of an HTML page.`,
          'HTTP',
        ),
      ];
    default:
      return [
        item(
          'WEBSITE_UNREACHABLE',
          'WARNING',
          `${UNREACHABLE_WORDING[errorCode] ?? 'The website could not be retrieved.'}${tried} This was observed at the time of analysis and may be temporary.`,
          'HTTP',
        ),
      ];
  }
};

/** Evidence for a homepage that was retrieved and parsed. */
export const buildEvidence = ({ availability, page, content, structuredData, mobile, robots, sitemap, technologies, socialLinks }) => {
  const out = [];

  if (availability.redirectCount > 0) {
    out.push(item('REDIRECTED', 'INFO', `The website redirected ${plural(availability.redirectCount, 'time')} to ${availability.finalUrl}.`, 'HTTP'));
  }
  out.push(
    availability.https
      ? item('HTTPS_PRESENT', 'INFO', 'The final page was served over HTTPS.', 'HTTP')
      : item('HTTPS_MISSING', 'NOTICE', 'The final page was served over plain HTTP, not HTTPS.', 'HTTP'),
  );

  if (!page.title) out.push(item('MISSING_TITLE', 'NOTICE', 'No <title> text was found.', 'HTML'));
  if (!page.metaDescription) out.push(item('MISSING_META_DESCRIPTION', 'NOTICE', 'No meta description tag was found.', 'HTML'));
  out.push(
    mobile.hasViewport
      ? item('VIEWPORT_PRESENT', 'INFO', `A viewport meta tag is present ("${mobile.viewportContent}").`, 'HTML')
      : item('MISSING_VIEWPORT', 'NOTICE', 'No viewport meta tag was found.', 'HTML'),
  );
  out.push(
    page.canonicalUrl
      ? item('CANONICAL_PRESENT', 'INFO', `A canonical link is declared: ${page.canonicalUrl}`, 'HTML')
      : item('MISSING_CANONICAL', 'NOTICE', 'No canonical link was found.', 'HTML'),
  );
  if (!content.hasH1) out.push(item('MISSING_H1', 'NOTICE', 'No <h1> heading was found.', 'HTML'));
  else if (content.h1Count > 1) out.push(item('MULTIPLE_H1', 'INFO', `${plural(content.h1Count, '<h1> heading')} were found.`, 'HTML'));
  if (content.imagesWithoutAltCount > 0) {
    out.push(
      item(
        'IMAGES_WITHOUT_ALT',
        'NOTICE',
        `${content.imagesWithoutAltCount} of ${plural(content.imageCount, 'image')} have no alt attribute.`,
        'HTML',
      ),
    );
  }

  if (robots.robotsTxtExists === true) out.push(item('ROBOTS_PRESENT', 'INFO', 'robots.txt exists.', 'ROBOTS'));
  else if (robots.robotsTxtExists === false) {
    const status = robots.robotsTxtStatus ? ` (HTTP ${robots.robotsTxtStatus})` : '';
    out.push(item('ROBOTS_MISSING', 'NOTICE', `No robots.txt file was found${status}.`, 'ROBOTS'));
  }
  if (sitemap.sitemapExists === true) {
    out.push(item('SITEMAP_PRESENT', 'INFO', `An XML sitemap was found at ${sitemap.sitemapUrl}.`, 'SITEMAP'));
  } else if (sitemap.sitemapExists === false) {
    out.push(item('SITEMAP_MISSING', 'NOTICE', `No XML sitemap was found at ${plural(sitemap.checkedUrls.length, 'checked location')}.`, 'SITEMAP'));
  }

  if (structuredData.hasJsonLd) {
    const types = structuredData.jsonLdTypes.length ? `: ${structuredData.jsonLdTypes.join(', ')}` : '';
    out.push(item('JSON_LD_PRESENT', 'INFO', `${plural(structuredData.jsonLdBlockCount, 'JSON-LD block')} found${types}.`, 'HTML'));
  }
  if (structuredData.openGraph.present) {
    out.push(item('OPEN_GRAPH_PRESENT', 'INFO', `Open Graph tags found: ${Object.keys(structuredData.openGraph.tags).map((k) => `og:${k}`).join(', ')}.`, 'HTML'));
  }
  if (structuredData.twitterCard.present) {
    out.push(item('TWITTER_CARD_PRESENT', 'INFO', `Twitter/X card tags found${structuredData.twitterCard.card ? ` (card: ${structuredData.twitterCard.card})` : ''}.`, 'HTML'));
  }

  for (const link of socialLinks) out.push(item('SOCIAL_LINK_FOUND', 'INFO', `${link.platform} link on the website: ${link.url}`, 'HTML'));
  for (const tech of technologies) {
    out.push(item('TECHNOLOGY_DETECTED', 'INFO', `${tech.name} (${tech.confidence} confidence): ${tech.evidence}.`, tech.evidence.includes('header') ? 'HTTP' : 'HTML'));
  }
  return out;
};
