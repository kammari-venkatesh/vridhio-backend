const positiveInt = (raw, fallback, max = Number.MAX_SAFE_INTEGER) => {
  const value = Number(raw);
  return raw !== undefined && Number.isInteger(value) && value > 0 ? Math.min(value, max) : fallback;
};

/**
 * Website & digital presence analysis (Phase 4). Direct HTTP(S) requests only: no paid
 * APIs, no browser, no crawling. Each analysis fetches at most the homepage, robots.txt
 * and a few sitemap candidates.
 */
export const websiteAnalysisConfig = {
  workerEnabled: process.env.WEBSITE_ANALYSIS_WORKER_ENABLED !== 'false',
  // Lead Finder queues an analysis for every business it saves (WEBSITE_ANALYSIS_AUTO=false turns this off).
  autoAnalyzeDiscovered: process.env.WEBSITE_ANALYSIS_AUTO !== 'false',
  userAgent: 'Mozilla/5.0 (compatible; VridhioSiteCheck/1.0; +https://vridhio.com)',
  // Token matched against robots.txt user-agent groups.
  robotsAgent: 'vridhiositecheck',
  // Bump when stored facts would differ; results from older versions are re-fetched on request.
  analyzerVersion: 2,

  request: {
    timeoutMs: positiveInt(process.env.WEBSITE_ANALYSIS_TIMEOUT_MS, 10_000, 30_000),
    maxRedirects: 5,
    // Decompressed bytes; larger homepages are rejected rather than truncated.
    maxHtmlBytes: 3 * 1024 * 1024,
    maxRobotsBytes: 256 * 1024,
    // Only the start of a sitemap is read: enough to recognise it, never the whole file.
    maxSitemapBytes: 64 * 1024,
    maxSitemapCandidates: 3,
    // One retry for failures that are often transient (timeouts, resets, DNS hiccups).
    transientRetries: 1,
    retryDelayMs: 1000,
  },

  worker: {
    pollIntervalMs: 2000,
    concurrency: positiveInt(process.env.WEBSITE_ANALYSIS_CONCURRENCY, 2, 5),
    heartbeatIntervalMs: 15_000,
    // An ANALYZING record with no heartbeat for this long is assumed abandoned.
    staleAfterMs: 3 * 60 * 1000,
    // Hard ceiling on one whole analysis (homepage + robots + sitemap, including retries).
    maxAnalysisMs: 60_000,
  },

  policy: {
    // A completed analysis newer than this is returned instead of fetching the site again.
    freshForMs: positiveInt(process.env.WEBSITE_ANALYSIS_FRESH_DAYS, 7, 90) * 24 * 60 * 60 * 1000,
    // A failed analysis is not retried automatically within this window (explicit refresh only).
    failedCooldownMs: 15 * 60 * 1000,
    // Minimum gap between two fetches of the same business, even with refresh.
    refreshCooldownMs: 5 * 60 * 1000,
    maxQueued: 200,
    bulkMaxIds: 25,
  },
};
