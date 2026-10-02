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

/**
 * Which provider new searches use and whether it is ready. `mode` is "live" only for a
 * real provider with valid configuration. Never includes secrets or identifiers.
 */
const providerState = (name) => {
  if (!isKnownProvider(name)) return { provider: name, mode: 'unconfigured', configured: false, actorConfigured: false };
  if (name === 'fake') return { provider: 'fake', mode: 'test', configured: true, actorConfigured: false };
  const { configured, actorConfigured = false } = getProvider(name).getStatus?.() ?? { configured: true };
  return { provider: name, mode: configured ? 'live' : 'unconfigured', configured, actorConfigured };
};

export const getProviderStatus = (name = leadFinderConfig.provider, budget = leadFinderConfig.budget) => ({
  ...providerState(name),
  dailyBudgetConfigured: budget.dailyUsd !== null,
  monthlyBudgetConfigured: budget.monthlyUsd !== null,
});
