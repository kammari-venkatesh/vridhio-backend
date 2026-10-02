const positiveNumber = (raw, fallback) => {
  const value = Number(raw);
  return raw !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
};

/** Budget in USD; an unset or invalid value falls back to `fallback` (null = disabled). */
/** USD limit from env: "off" disables it (null); missing or invalid values fall back to the safe default. */
export const budgetUsd = (raw, fallback) => {
  if (raw === undefined || raw.trim() === '') return fallback;
  if (raw.trim().toLowerCase() === 'off') return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};

export const leadFinderConfig = {
  // Searches use test data unless the admin explicitly asks for a real search on a server
  // where Apify is enabled (APIFY_ENABLED=true plus credentials). See services/leadFinder/providers.js.
  defaultProvider: 'fake',
  workerEnabled: process.env.LEAD_FINDER_WORKER_ENABLED !== 'false',
  fakeProviderLatencyMs: Number(process.env.FAKE_PROVIDER_LATENCY_MS ?? 1500),

  worker: {
    pollIntervalMs: 2000,
    batchSize: 5,
    heartbeatIntervalMs: 30_000,
    // A running job with no heartbeat for this long is assumed abandoned (worker crashed or restarted).
    staleJobAfterMs: 10 * 60 * 1000,
    // Hard upper bound on one provider call, whatever the provider's own timeout.
    providerTimeoutMs: positiveNumber(process.env.LEAD_FINDER_PROVIDER_TIMEOUT_MS, 8 * 60 * 1000),
    // How often a running discovery checks whether its job was cancelled.
    cancelCheckIntervalMs: 5000,
    // Pay-per-event charges are finalised by the provider shortly after a run ends; the cost
    // reported at that moment can be incomplete, so it is re-read once this much time has passed.
    costSettleDelayMs: 60_000,
    // Reads of the final cost before giving up and marking it unavailable.
    maxCostSettleAttempts: 5,
  },

  // Spending limits for paid discovery, per UTC day / UTC calendar month.
  budget: {
    dailyUsd: budgetUsd(process.env.LEAD_FINDER_DAILY_BUDGET_USD, 5),
    monthlyUsd: budgetUsd(process.env.LEAD_FINDER_MONTHLY_BUDGET_USD, null),
  },

  // Resolves a typed location to a search centre for radius filtering (OpenStreetMap Nominatim).
  geocoding: {
    enabled: process.env.LEAD_FINDER_GEOCODING_ENABLED !== 'false',
    url: process.env.LEAD_FINDER_GEOCODING_URL || 'https://nominatim.openstreetmap.org/search',
    userAgent: 'VridhioLeadFinder/1.0 (internal admin tool)',
    timeoutMs: 8000,
    // Nominatim's usage policy allows at most one request per second.
    minIntervalMs: 1100,
    cacheTtlMs: 24 * 60 * 60 * 1000,
  },

  limits: {
    maxBusinesses: 100,
    defaultMaxBusinesses: 25,
    maxRadiusKm: 50,
    maxCategories: 10,
    maxActiveJobs: 3,
    locationMaxLength: 100,
    categoryMaxLength: 60,
  },

  pagination: {
    jobs: { defaultLimit: 20, maxLimit: 50 },
    prospects: { defaultLimit: 25, maxLimit: 100 },
  },
};
