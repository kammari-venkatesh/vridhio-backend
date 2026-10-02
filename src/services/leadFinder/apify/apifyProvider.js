import { setTimeout as delay } from 'node:timers/promises';
import { ApifyClient } from 'apify-client';
import { apifyConfig, apifyConfigIssues } from '../../../config/apify.js';
import { leadFinderConfig } from '../../../config/leadFinder.js';
import { PROVIDER_ERROR_CODES as CODES, providerError } from '../provider.interface.js';
import { ACTOR_ADAPTERS, getActorAdapter } from './actorAdapters.js';
import { describeForLog, mapApifyError } from './apifyErrors.js';

const TERMINAL_STATUSES = new Set(['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT']);
// Extra time on top of the Actor's own timeout for the platform to report the final status.
const STATUS_GRACE_MS = 60_000;
// Bounded retries for idempotent reads (status polling, dataset download, abort).
const READ_MAX_RETRIES = 2;

const defaultClientFactory = (options) => new ApifyClient(options);

/**
 * Business discovery through an Apify Actor. Runs asynchronously: start the Actor,
 * poll its status, then download the default dataset and map it through the
 * configured Actor adapter.
 */
export const createApifyProvider = ({
  config = apifyConfig,
  clientFactory = defaultClientFactory,
  sleep = delay,
  now = Date.now,
  logger = console,
} = {}) => {
  const adapter = getActorAdapter(config.actorAdapter);
  const issues = apifyConfigIssues(config, { knownAdapters: Object.keys(ACTOR_ADAPTERS) });
  const appMax = leadFinderConfig.limits.maxBusinesses;
  const itemLimit = Number.isFinite(config.maxItems) ? Math.min(config.maxItems, appMax) : appMax;
  let clients = null;

  const getClients = () => {
    // Starting a paid run is never retried: a lost response could otherwise launch a second run.
    clients ??= {
      start: clientFactory({ token: config.token, maxRetries: 0 }),
      read: clientFactory({ token: config.token, maxRetries: READ_MAX_RETRIES }),
    };
    return clients;
  };

  const log = (message) => logger.warn?.(`[lead-finder] apify: ${message}`);

  const validateRequest = (params) => {
    if (issues.length) {
      log(`not configured (missing or invalid: ${issues.join(', ')})`);
      throw providerError(CODES.CONFIGURATION_ERROR);
    }
    if (!Number.isInteger(params?.maxBusinesses) || params.maxBusinesses < 1 || params.maxBusinesses > itemLimit) {
      throw providerError(CODES.VALIDATION_ERROR, {
        message: `Business discovery is limited to ${itemLimit} businesses per search.`,
      });
    }
  };

  const abortRun = async (runId) => {
    try {
      await getClients().read.run(runId).abort();
    } catch (err) {
      log(`could not abort run: ${describeForLog(mapApifyError(err))}`);
    }
  };

  const waitForRun = async (run, { signal, deadline }) => {
    let current = run;
    while (!TERMINAL_STATUSES.has(current.status)) {
      if (now() >= deadline) throw providerError(CODES.PROVIDER_TIMEOUT);
      await sleep(config.pollIntervalSeconds * 1000, undefined, { signal });
      signal?.throwIfAborted();
      current = await getClients().read.run(current.id).get();
      if (!current || typeof current.status !== 'string') throw providerError(CODES.PROVIDER_INVALID_RESPONSE);
    }
    return current;
  };

  /** Records the run's provider-reported cost; null (never a guessed value) when it cannot be read. */
  const reportCost = async (runId, knownRun, reportUsage) => {
    if (!reportUsage) return;
    let usd = knownRun?.usageTotalUsd;
    if (typeof usd !== 'number') {
      try {
        usd = (await getClients().read.run(runId).get())?.usageTotalUsd;
      } catch (err) {
        log(`could not read run cost: ${describeForLog(mapApifyError(err))}`);
      }
    }
    try {
      await reportUsage({ totalUsd: typeof usd === 'number' && Number.isFinite(usd) && usd >= 0 ? usd : null });
    } catch {
      log('could not record run cost');
    }
  };

  /** Current provider-reported cost of a past run (a free read); null when not reported. */
  const getRunCost = async (runId) => {
    if (issues.length) throw providerError(CODES.CONFIGURATION_ERROR);
    let run;
    try {
      run = await getClients().read.run(runId).get();
    } catch (err) {
      throw mapApifyError(err);
    }
    const usd = run?.usageTotalUsd;
    return typeof usd === 'number' && Number.isFinite(usd) && usd >= 0 ? usd : null;
  };

  const discoverBusinesses = async (params, { signal, reportRun, reportUsage } = {}) => {
    validateRequest(params);
    signal?.throwIfAborted();

    const limit = Math.min(params.maxBusinesses, itemLimit);
    let run;
    try {
      run = await getClients()
        .start.actor(config.actorId)
        .start(adapter.buildInput(params, { limit }), {
          timeout: config.timeoutSeconds,
          maxItems: limit,
          maxTotalChargeUsd: config.maxTotalChargeUsd,
          restartOnError: false,
        });
    } catch (err) {
      const error = mapApifyError(err);
      log(`start failed: ${describeForLog(error)}`);
      throw error;
    }

    const runId = typeof run?.id === 'string' ? run.id : null;
    const datasetId = typeof run?.defaultDatasetId === 'string' ? run.defaultDatasetId : null;
    let finished = false;
    let costReported = false;
    try {
      if (!runId || !datasetId) throw providerError(CODES.PROVIDER_INVALID_RESPONSE);
      await reportRun?.({ runId, datasetId });

      const final = await waitForRun(
        { ...run, status: run.status ?? 'READY' },
        { signal, deadline: now() + config.timeoutSeconds * 1000 + STATUS_GRACE_MS },
      );
      finished = true;
      costReported = true;
      await reportCost(runId, final, reportUsage);
      if (final.status === 'TIMED-OUT') throw providerError(CODES.PROVIDER_TIMEOUT);
      if (final.status !== 'SUCCEEDED') throw providerError(CODES.PROVIDER_FAILED);

      const page = await getClients().read.dataset(datasetId).listItems({ limit, clean: true });
      signal?.throwIfAborted();
      if (!Array.isArray(page?.items)) throw providerError(CODES.PROVIDER_INVALID_RESPONSE);

      const records = page.items.map((item) => adapter.mapItem(item, params));
      const malformed = records.filter((r) => r === null).length;
      logger.info?.(`[lead-finder] apify: run finished with ${records.length} items (${malformed} malformed)`);
      // Malformed items stay in the list as null so the worker can count them as invalid.
      return records;
    } catch (err) {
      if (!finished && runId) await abortRun(runId);
      // Aborted or failed runs can still have incurred charges.
      if (runId && !costReported) await reportCost(runId, null, reportUsage);
      if (signal?.aborted && err === signal.reason) throw err;
      if (err?.name === 'AbortError') throw err;
      const error = mapApifyError(err);
      log(`run ended with ${describeForLog(error)}`);
      throw error;
    }
  };

  return {
    name: 'apify',
    discoverBusinesses,
    validateRequest,
    supportsRadius: true,
    maxRunCostUsd: () => config.maxTotalChargeUsd,
    getRunCost,
    getStatus: () => ({ configured: issues.length === 0, actorConfigured: Boolean(config.actorId) }),
  };
};
