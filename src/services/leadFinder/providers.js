import { apifyConfig } from '../../config/apify.js';
import { leadFinderConfig } from '../../config/leadFinder.js';
import { createApifyProvider } from './apify/apifyProvider.js';
import { createFakeProvider } from './fakeProvider.js';
import { assertProvider } from './provider.interface.js';

const registry = new Map([
  ['fake', () => createFakeProvider({ latencyMs: leadFinderConfig.fakeProviderLatencyMs })],
  ['apify', () => createApifyProvider()],
]);
const instances = new Map();

export const isKnownProvider = (name) => registry.has(name);

export const getProvider = (name) => {
  if (!registry.has(name)) throw new Error(`Unknown Lead Finder provider "${name}"`);
  if (!instances.has(name)) instances.set(name, assertProvider(registry.get(name)()));
  return instances.get(name);
};

/** Provider names as used by the admin API ("test" / "apify") and as stored on jobs ("fake" / "apify"). */
export const PUBLIC_PROVIDER_NAMES = Object.freeze({ fake: 'test', apify: 'apify' });
export const INTERNAL_PROVIDER_NAMES = Object.freeze({ test: 'fake', apify: 'apify' });

export const REAL_SEARCH_ERRORS = Object.freeze({
  REAL_APIFY_DISABLED: 'REAL_APIFY_DISABLED',
  REAL_APIFY_NOT_CONFIGURED: 'REAL_APIFY_NOT_CONFIGURED',
});

export const REAL_SEARCH_MESSAGES = Object.freeze({
  REAL_APIFY_DISABLED: 'Real Apify search is disabled on this server. No search was started.',
  REAL_APIFY_NOT_CONFIGURED:
    'Real Apify search is enabled but its server configuration is incomplete. No search was started.',
});

/**
 * Whether this server may run a provider. Test data is always available. Apify needs
 * APIFY_ENABLED=true and complete server-side configuration; credentials never come from requests.
 */
export const providerAvailability = (name, { apifyEnabled = apifyConfig.enabled, resolveProvider = getProvider } = {}) => {
  if (name === 'fake') return { available: true, reason: null };
  if (name !== 'apify') return { available: false, reason: null };
  if (!apifyEnabled) return { available: false, reason: REAL_SEARCH_ERRORS.REAL_APIFY_DISABLED };
  const { configured = false } = resolveProvider(name).getStatus?.() ?? {};
  return configured
    ? { available: true, reason: null }
    : { available: false, reason: REAL_SEARCH_ERRORS.REAL_APIFY_NOT_CONFIGURED };
};

/** Providers whose jobs a worker in this process may execute. */
export const runnableProviders = (options) =>
  [...registry.keys()].filter((name) => providerAvailability(name, options).available);

/**
 * Search modes the admin can choose and whether each can run here. Test is always the
 * default. Never includes secrets or identifiers.
 */
export const getProviderStatus = ({ budget = leadFinderConfig.budget, ...options } = {}) => {
  const real = providerAvailability('apify', options);
  const resolve = options.resolveProvider ?? getProvider;
  return {
    defaultProvider: PUBLIC_PROVIDER_NAMES[leadFinderConfig.defaultProvider],
    providers: {
      test: { available: true },
      apify: {
        available: real.available,
        unavailableReason: real.reason,
        maxRunCostUsd: real.available ? (resolve('apify').maxRunCostUsd?.() ?? null) : null,
      },
    },
    dailyBudgetConfigured: budget.dailyUsd !== null,
    monthlyBudgetConfigured: budget.monthlyUsd !== null,
  };
};
