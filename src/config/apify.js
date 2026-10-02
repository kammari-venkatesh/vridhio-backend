// Apify discovery provider settings. Server-side only: the token is never logged,
// returned by the API or exposed to the frontend.

const numberFrom = (raw, fallback) => {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : Number.NaN;
};

export const readApifyConfig = (env = process.env) => ({
  enabled: env.APIFY_ENABLED === 'true',
  // APIFY_API_TOKEN is accepted for backwards compatibility with earlier .env files.
  token: (env.APIFY_TOKEN || env.APIFY_API_TOKEN || '').trim(),
  actorId: (env.APIFY_ACTOR_ID ?? '').trim(),
  // Which input/output adapter matches the configured Actor (see services/leadFinder/apify/actorAdapters.js).
  actorAdapter: (env.APIFY_ACTOR_ADAPTER ?? 'google-maps').trim(),
  timeoutSeconds: numberFrom(env.APIFY_TIMEOUT_SECONDS, 300),
  maxItems: numberFrom(env.APIFY_MAX_ITEMS, 100),
  maxTotalChargeUsd: numberFrom(env.APIFY_MAX_TOTAL_CHARGE_USD, 1),
  pollIntervalSeconds: numberFrom(env.APIFY_POLL_INTERVAL_SECONDS, 5),
});

export const apifyConfig = Object.freeze(readApifyConfig());

/** Names of missing or invalid settings (never their values). */
export const apifyConfigIssues = (config, { knownAdapters = [] } = {}) => {
  const issues = [];
  if (!config.token) issues.push('APIFY_TOKEN');
  if (!config.actorId) issues.push('APIFY_ACTOR_ID');
  if (knownAdapters.length && !knownAdapters.includes(config.actorAdapter)) issues.push('APIFY_ACTOR_ADAPTER');
  for (const key of ['timeoutSeconds', 'maxItems', 'maxTotalChargeUsd', 'pollIntervalSeconds']) {
    if (!Number.isFinite(config[key])) issues.push(`APIFY_${key.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`);
  }
  return issues;
};
