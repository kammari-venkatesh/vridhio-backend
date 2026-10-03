import { candidateServices } from './serviceRules.js';

const MAX_TEXT = { name: 120, title: 200, description: 300, evidence: 300, url: 200, short: 60 };

/**
 * Website-derived strings are untrusted: control and zero-width characters are removed,
 * whitespace collapsed and length capped before anything reaches the provider.
 */
export const cleanText = (value, max) => {
  if (value === null || value === undefined) return null;
  const text = String(value)
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
};

/**
 * Facts the stored evidence implies but does not list as an item (absences). Wording
 * keeps the uncertainty: "not detected on the analysed page", never "does not exist".
 */
const derivedEvidence = (analysis) => {
  const reached = analysis.status === 'COMPLETED' && analysis.availability?.reachable === true;
  const out = [];
  if (analysis.robots?.robotsDisallowsAll === true) {
    out.push({ type: 'ROBOTS_BLOCKS_ALL', severity: 'WARNING', evidence: 'robots.txt disallows all crawlers from the whole site.', source: 'ROBOTS' });
  }
  if (!reached) return out;
  if (analysis.structuredData?.hasJsonLd === false) {
    out.push({ type: 'NO_STRUCTURED_DATA', severity: 'NOTICE', evidence: 'No JSON-LD structured data was found on the homepage.', source: 'DERIVED' });
  }
  if (analysis.structuredData?.openGraph?.present === false) {
    out.push({ type: 'NO_OPEN_GRAPH', severity: 'INFO', evidence: 'No Open Graph tags were found on the homepage.', source: 'DERIVED' });
  }
  if ((analysis.socialLinks ?? []).length === 0) {
    out.push({
      type: 'NO_SOCIAL_LINKS_DETECTED',
      severity: 'INFO',
      evidence: 'No social media profile links were detected on the homepage. This does not show whether the business has social media accounts.',
      source: 'DERIVED',
    });
  }
  return out;
};

/**
 * Builds the evidence-only input for qualification from stored facts. No raw HTML,
 * robots.txt or sitemap content exists in the analysis, and none is added here.
 * Returns { payload, evidence, candidates }; evidence IDs (E1.., D1..) are what the
 * provider must cite.
 */
export const buildEvidencePayload = ({ business, analysis }) => {
  const stored = (analysis.evidence ?? []).map((e, i) => ({
    id: `E${i + 1}`,
    type: e.type,
    severity: e.severity ?? null,
    evidence: cleanText(e.evidence, MAX_TEXT.evidence) ?? '',
    source: e.source ?? null,
  }));
  const derived = derivedEvidence(analysis).map((e, i) => ({ id: `D${i + 1}`, ...e }));
  const evidence = [...stored, ...derived];
  const candidates = candidateServices(evidence, { httpStatus: analysis.availability?.httpStatus ?? null });

  const av = analysis.availability ?? {};
  const sd = analysis.structuredData ?? {};
  const socialPlatformsLinked = [...new Set((analysis.socialLinks ?? []).map((s) => s.platform))];
  const payload = {
    prospect: {
      businessName: cleanText(business.businessName, MAX_TEXT.name),
      category: cleanText(business.category, MAX_TEXT.short),
      city: cleanText(business.city, MAX_TEXT.short),
      state: cleanText(business.state, MAX_TEXT.short),
      country: cleanText(business.country, MAX_TEXT.short),
      website: cleanText(analysis.website?.websiteUrl ?? business.website, MAX_TEXT.url),
    },
    websiteAnalysis: {
      status: analysis.status,
      errorCode: analysis.errorCode ?? null,
      hasWebsite: analysis.website?.hasWebsite ?? Boolean(business.website),
      reachable: av.reachable ?? false,
      httpStatus: av.httpStatus ?? null,
      https: av.https ?? null,
      finalHost: av.finalUrl ? hostOf(av.finalUrl) : null,
      redirectCount: av.redirectCount ?? 0,
      title: cleanText(analysis.page?.title, MAX_TEXT.title),
      metaDescription: cleanText(analysis.page?.metaDescription, MAX_TEXT.description),
      viewport: analysis.mobile?.viewportStatus ?? 'unknown',
      h1Count: analysis.content?.h1Count ?? null,
      imageCount: analysis.content?.imageCount ?? null,
      imagesWithoutAlt: analysis.content?.imagesWithoutAltCount ?? null,
      robotsTxtExists: analysis.robots?.robotsTxtExists ?? null,
      sitemapExists: analysis.sitemap?.sitemapExists ?? null,
      jsonLdTypes: (sd.jsonLdTypes ?? []).slice(0, 10).map((t) => cleanText(t, MAX_TEXT.short)).filter(Boolean),
      openGraph: sd.openGraph?.present ?? null,
      twitterCard: sd.twitterCard?.present ?? null,
      technologies: (analysis.technologies ?? []).slice(0, 15).map((t) => ({ name: cleanText(t.name, MAX_TEXT.short), confidence: t.confidence })),
      socialPlatformsLinked,
    },
    evidence: evidence.map(({ id, type, severity, evidence: text }) => ({ id, type, severity, evidence: text })),
    candidateServices: candidates,
    notCollected: [
      'search rankings or search visibility',
      'website traffic or analytics',
      'conversion rates, leads or sales',
      'advertising activity or performance',
      socialPlatformsLinked.length ? 'social media activity or engagement' : 'social media accounts, activity or engagement',
      'reviews or reputation',
      'revenue, customers or business size',
      'page speed or performance scores',
    ],
  };
  return { payload, evidence, candidates };
};
