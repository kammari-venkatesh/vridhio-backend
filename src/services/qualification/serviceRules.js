import { SERVICE_CATALOG } from '../../config/leadWorkspace.js';

/**
 * Evidence types that can support each service. A service is offered to the AI as a
 * candidate only when at least one supporting item is present, and every saved
 * opportunity must cite at least one of them. Services with no entry (Google Ads,
 * Meta Ads, Digital Marketing, Lead Generation, App Development, AI Automation,
 * Video Editing, Graphic Design) cannot be supported by website-analysis evidence
 * alone: the analysis has no advertising, marketing, conversion or media data.
 */
export const SERVICE_EVIDENCE_RULES = Object.freeze({
  'website-development': ['NO_WEBSITE', 'INVALID_WEBSITE_URL', 'WEBSITE_UNREACHABLE', 'HTTP_ERROR', 'NON_HTML_RESPONSE'],
  'website-redesign': ['MISSING_VIEWPORT', 'HTTPS_MISSING', 'MISSING_TITLE', 'MISSING_H1', 'MULTIPLE_H1'],
  seo: [
    'MISSING_TITLE',
    'MISSING_META_DESCRIPTION',
    'MISSING_CANONICAL',
    'MISSING_H1',
    'MULTIPLE_H1',
    'IMAGES_WITHOUT_ALT',
    'SITEMAP_MISSING',
    'ROBOTS_MISSING',
    'ROBOTS_BLOCKS_ALL',
  ],
  // Conservative: only the absence of structured data, which answer engines read.
  aeo: ['NO_STRUCTURED_DATA'],
  'social-media-marketing': ['NO_SOCIAL_LINKS_DETECTED', 'NO_OPEN_GRAPH'],
});

const catalogById = new Map(SERVICE_CATALOG.map((s) => [s.id, s]));

export const serviceById = (id) => catalogById.get(id) ?? null;

// Statuses that mean "access refused to an automated client", not a broken website.
const ACCESS_DENIED_STATUSES = new Set([401, 403, 407, 429]);

/**
 * Services with at least one supporting evidence item, and which items support them.
 * `httpStatus` is the homepage status from the analysis.
 */
export const candidateServices = (evidence, { httpStatus = null } = {}) => {
  const counts = (e) => !(e.type === 'HTTP_ERROR' && ACCESS_DENIED_STATUSES.has(httpStatus));
  const out = [];
  for (const [serviceId, types] of Object.entries(SERVICE_EVIDENCE_RULES)) {
    const service = catalogById.get(serviceId);
    if (!service) continue;
    const supporting = evidence.filter((e) => types.includes(e.type) && counts(e)).map((e) => e.id);
    if (supporting.length > 0) out.push({ serviceId, serviceName: service.name, supportingEvidenceIds: supporting });
  }
  return out;
};