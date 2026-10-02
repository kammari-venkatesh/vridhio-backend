/**
 * Contract every Lead Finder data provider must satisfy. The worker and the rest of
 * the system depend only on this module, never on a specific provider.
 *
 * @typedef {Object} DiscoveryParams
 * @property {string} location
 * @property {number} radius          Search radius in kilometres.
 * @property {string[]} categories
 * @property {number} maxBusinesses   Upper bound on records to return.
 *
 * @typedef {Object} NormalizedBusiness
 * @property {string} sourceId        Stable ID of the business within this provider.
 * @property {string} businessName
 * @property {string|null} category   Category the business matched.
 * @property {string[]} categories
 * @property {string|null} address
 * @property {string|null} phone
 * @property {string|null} website
 * @property {string|null} googleMapsUrl
 * @property {string|null} city
 * @property {string|null} state
 * @property {string|null} country
 * @property {number|null} latitude
 * @property {number|null} longitude
 * @property {boolean|null} permanentlyClosed  null when the provider does not know.
 *
 * DiscoveryParams may also carry `center: { latitude, longitude }` when the job has a
 * resolved search centre (providers with `supportsRadius`).
 *
 * @typedef {Object} DiscoveryContext
 * @property {AbortSignal} [signal]   Aborted when the job is cancelled or exceeds its time budget.
 * @property {(run: { runId?: string, datasetId?: string }) => Promise<void>} [reportRun]
 *   Lets remote providers record internal run identifiers on the job (never shown to admins).
 * @property {(usage: { totalUsd: number | null }) => Promise<void>} [reportUsage]
 *   Records the provider-reported cost of the run (null when it could not be retrieved).
 *
 * Optional provider capabilities:
 * @property {boolean} [supportsRadius]   Jobs get a resolved search centre and results are filtered by distance.
 * @property {() => number} [maxRunCostUsd]  Spending cap of one run; marks the provider as paid.
 *
 * @typedef {Object} LeadFinderProvider
 * @property {string} name
 * @property {(params: DiscoveryParams, context?: DiscoveryContext) => Promise<Object[]>} discoverBusinesses
 *   Resolves to raw business records shaped like NormalizedBusiness; the worker
 *   re-validates every record with normalizeBusiness() before storing it.
 * @property {() => { configured: boolean, actorConfigured?: boolean }} [getStatus]
 *   Configuration summary for the admin UI. Must not include secrets.
 * @property {(params: DiscoveryParams) => void} [validateRequest]
 *   Throws a ProviderError before a job is queued when it cannot run (missing
 *   configuration, limits exceeded).
 */

export const PROVIDER_ERROR_CODES = Object.freeze({
  CONFIGURATION_ERROR: 'CONFIGURATION_ERROR',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  PROVIDER_AUTH_ERROR: 'PROVIDER_AUTH_ERROR',
  PROVIDER_RATE_LIMIT: 'PROVIDER_RATE_LIMIT',
  PROVIDER_TIMEOUT: 'PROVIDER_TIMEOUT',
  PROVIDER_FAILED: 'PROVIDER_FAILED',
  PROVIDER_INVALID_RESPONSE: 'PROVIDER_INVALID_RESPONSE',
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
});

export const SAFE_PROVIDER_MESSAGES = Object.freeze({
  CONFIGURATION_ERROR: 'Business discovery provider is not configured.',
  VALIDATION_ERROR: 'This search exceeds the discovery provider limits.',
  PROVIDER_AUTH_ERROR: 'Business discovery provider rejected the configured credentials.',
  PROVIDER_RATE_LIMIT: 'Business discovery provider is rate limiting requests. Please try again later.',
  PROVIDER_TIMEOUT: 'Business discovery took too long and was stopped.',
  PROVIDER_FAILED: 'Business discovery run failed.',
  PROVIDER_INVALID_RESPONSE: 'Business discovery provider returned an unexpected response.',
  PROVIDER_UNAVAILABLE: 'Business discovery provider is temporarily unavailable.',
});

/** Errors whose message is safe to show to admins (no credentials or internals). */
export class ProviderError extends Error {
  constructor(message, { cause, code = PROVIDER_ERROR_CODES.PROVIDER_FAILED } = {}) {
    super(message, { cause });
    this.name = 'ProviderError';
    this.code = code;
  }
}

/** ProviderError with the standard safe message for `code`. */
export const providerError = (code, { message, cause } = {}) =>
  new ProviderError(message ?? SAFE_PROVIDER_MESSAGES[code] ?? SAFE_PROVIDER_MESSAGES.PROVIDER_FAILED, {
    code,
    cause,
  });

export const assertProvider = (provider) => {
  if (!provider || typeof provider.name !== 'string' || typeof provider.discoverBusinesses !== 'function') {
    throw new Error('Invalid Lead Finder provider: expected { name, discoverBusinesses() }');
  }
  return provider;
};

const MAX_TEXT_LENGTH = 300;

const cleanText = (value) => {
  if (typeof value !== 'string') return null;
  const text = value.trim().slice(0, MAX_TEXT_LENGTH);
  return text || null;
};

const cleanHttpUrl = (value) => {
  const text = cleanText(value);
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
};

const cleanCoordinate = (value, limit) =>
  typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= limit ? value : null;

/**
 * Validates and normalizes one provider record. Returns null for records that cannot
 * be stored (no name or no stable ID). `source` always comes from the provider's name,
 * never from the record itself.
 */
export const normalizeBusiness = (record, source) => {
  if (!record || typeof record !== 'object') return null;

  const businessName = cleanText(record.businessName);
  const sourceId = cleanText(typeof record.sourceId === 'number' ? String(record.sourceId) : record.sourceId);
  if (!businessName || !sourceId) return null;

  const categories = Array.isArray(record.categories)
    ? [...new Set(record.categories.map(cleanText).filter(Boolean))]
    : [];
  const category = cleanText(record.category) ?? categories[0] ?? null;

  return {
    source,
    sourceId,
    businessName,
    category,
    categories: category && !categories.includes(category) ? [category, ...categories] : categories,
    address: cleanText(record.address),
    city: cleanText(record.city),
    state: cleanText(record.state),
    country: cleanText(record.country),
    phone: cleanText(record.phone),
    website: cleanHttpUrl(record.website),
    googleMapsUrl: cleanHttpUrl(record.googleMapsUrl),
    latitude: cleanCoordinate(record.latitude, 90),
    longitude: cleanCoordinate(record.longitude, 180),
    permanentlyClosed: typeof record.permanentlyClosed === 'boolean' ? record.permanentlyClosed : null,
  };
};

/** Keeps the first record for each sourceId (providers can return overlapping pages). */
export const dedupeBySourceId = (businesses) => {
  const seen = new Set();
  return businesses.filter((b) => {
    if (seen.has(b.sourceId)) return false;
    seen.add(b.sourceId);
    return true;
  });
};
