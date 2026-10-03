import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { leadFinderConfig } from '../../config/leadFinder.js';
import { leadWorkspaceConfig } from '../../config/leadWorkspace.js';
import { websiteAnalysisConfig } from '../../config/websiteAnalysis.js';
import { LeadFinderJob } from '../../models/leadFinderJob.model.js';
import { Prospect } from '../../models/prospect.model.js';
import { addProspectsToWorkspace } from '../leadWorkspace/salesLead.service.js';
import { requestAnalysis, resolveProspectTarget } from '../websiteAnalysis/websiteAnalysis.service.js';
import { haversineKm, isValidCoordinate } from '../../utils/geo.js';
import { checkBudget, toMicroUsd } from './cost.service.js';
import { getProvider, runnableProviders } from './providers.js';
import { upsertDiscoveredProspects } from './prospect.service.js';
import {
  assertProvider,
  dedupeBySourceId,
  normalizeBusiness,
  PROVIDER_ERROR_CODES,
  ProviderError,
  providerError,
} from './provider.interface.js';

const GENERIC_FAILURE = 'Lead discovery failed because of an internal error. Please try again.';
const STALE_JOB_MESSAGE = 'The search stopped unexpectedly (the worker restarted). Please start a new search.';
const MAX_RUN_ID_LENGTH = 100;
const SETTLE_CHECK_INTERVAL_MS = 10_000;

const chunk = (items, size) =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));

/** Settles with the promise, or rejects with the abort reason as soon as the signal fires. */
const raceAbort = (promise, signal) => {
  promise.catch(() => {}); // a late rejection after abort is expected and ignored
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
};

const runIdField = (value) =>
  typeof value === 'string' && value.length > 0 && value.length <= MAX_RUN_ID_LENGTH ? value : null;

/**
 * Keeps businesses within `radiusKm` of the centre. Businesses without valid
 * coordinates are excluded and counted separately, never assumed to be inside.
 */
export const filterByRadius = (businesses, center, radiusKm) => {
  const kept = [];
  let outsideRadius = 0;
  let missingCoordinates = 0;
  for (const business of businesses) {
    if (!isValidCoordinate(business.latitude, business.longitude)) {
      missingCoordinates += 1;
      continue;
    }
    const distance = haversineKm(center.latitude, center.longitude, business.latitude, business.longitude);
    if (distance <= radiusKm) kept.push(business);
    else outsideRadius += 1;
  }
  return { kept, outsideRadius, missingCoordinates };
};

/**
 * MongoDB-backed worker. Jobs are claimed with an atomic findOneAndUpdate, so any
 * number of workers (in-process or separate processes) never process the same job.
 * A worker only claims jobs whose stored provider is enabled in its own process
 * (`providers`), so a server with Apify disabled never picks up a real search, and
 * each job runs with exactly the provider stored on it.
 * Processes one job at a time per worker; all work is async I/O so API requests
 * in the same process are not blocked.
 */
export const createLeadFinderWorker = ({
  resolveProvider = getProvider,
  providers = runnableProviders(),
  workerId = `${os.hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`,
  pollIntervalMs = leadFinderConfig.worker.pollIntervalMs,
  batchSize = leadFinderConfig.worker.batchSize,
  heartbeatIntervalMs = leadFinderConfig.worker.heartbeatIntervalMs,
  staleJobAfterMs = leadFinderConfig.worker.staleJobAfterMs,
  providerTimeoutMs = leadFinderConfig.worker.providerTimeoutMs,
  cancelCheckIntervalMs = leadFinderConfig.worker.cancelCheckIntervalMs,
  costSettleDelayMs = leadFinderConfig.worker.costSettleDelayMs,
  maxCostSettleAttempts = leadFinderConfig.worker.maxCostSettleAttempts,
  addProspectsToLeads = leadWorkspaceConfig.autoAddProspects,
  analyzeWebsites = websiteAnalysisConfig.autoAnalyzeDiscovered,
  logger = console,
  onProgress = () => {},
} = {}) => {
  let running = false;
  let timer = null;
  let inFlight = null;
  let lastSettleCheckAt = 0;

  const ownedRunning = (jobId) => ({ _id: jobId, status: 'running', lockedBy: workerId });

  const claimNextJob = () =>
    LeadFinderJob.findOneAndUpdate(
      { status: 'queued', provider: { $in: providers } },
      { $set: { status: 'running', startedAt: new Date(), heartbeatAt: new Date(), lockedBy: workerId } },
      { sort: { createdAt: 1, _id: 1 }, returnDocument: 'after' },
    );

  const recoverStaleJobs = () =>
    LeadFinderJob.updateMany(
      { status: 'running', heartbeatAt: { $lt: new Date(Date.now() - staleJobAfterMs) } },
      { $set: { status: 'failed', error: STALE_JOB_MESSAGE, finishedAt: new Date() } },
    );

  const stillOwned = async (jobId) => (await LeadFinderJob.exists(ownedRunning(jobId))) !== null;

  const updateProgress = async (jobId, progress) => {
    const fields = Object.fromEntries(Object.entries(progress).map(([k, v]) => [`progress.${k}`, v]));
    await LeadFinderJob.updateOne(ownedRunning(jobId), { $set: { ...fields, heartbeatAt: new Date() } });
    await onProgress(progress, jobId);
  };

  const reportRun = (jobId) => async ({ runId, datasetId } = {}) => {
    await LeadFinderJob.updateOne(ownedRunning(jobId), {
      $set: { 'providerRun.runId': runIdField(runId), 'providerRun.datasetId': runIdField(datasetId) },
    });
  };

  // Saved prospects stay saved if this fails; they can still be added from the job page.
  const addBatchToWorkspace = async (job, batch, source) => {
    try {
      const prospects = await Prospect.find({ source, sourceId: { $in: batch.map((b) => b.sourceId) } });
      await addProspectsToWorkspace(prospects, job.createdBy, { searchLocation: job.params.location });
    } catch (err) {
      logger.error(`[lead-finder] job ${job._id}: could not add prospects to the Lead Workspace: ${err.message}`);
    }
  };

  // Free (direct HTTP, no AI). The search succeeds even if queuing fails; Analyze still works per lead.
  const analyzeBatch = async (job, batch, source) => {
    try {
      const prospects = await Prospect.find({ source, sourceId: { $in: batch.map((b) => b.sourceId) } }).select('_id');
      for (const prospect of prospects) {
        await requestAnalysis(await resolveProspectTarget(prospect._id.toString()), { adminId: job.createdBy });
      }
    } catch (err) {
      logger.error(`[lead-finder] job ${job._id}: could not queue website analyses: ${err.message}`);
    }
  };

  // Cost is recorded even if the job was cancelled meanwhile: the money was spent either way.
  const reportUsage = (jobId) => async ({ totalUsd } = {}) => {
    await LeadFinderJob.updateOne(
      { _id: jobId, 'usage.settledAt': null },
      { $set: { 'usage.totalMicroUsd': toMicroUsd(totalUsd), 'usage.retrievedAt': new Date() } },
    );
  };

  /**
   * Calls the provider with an abort signal that fires when the job is cancelled
   * (checked periodically) or runs past the provider time budget. Returns null when
   * the job was cancelled; results that arrive after that are discarded.
   */
  const discover = async (job, provider, params) => {
    const controller = new AbortController();
    const cancelled = new Error('Job cancelled');
    const timeout = setTimeout(
      () => controller.abort(providerError(PROVIDER_ERROR_CODES.PROVIDER_TIMEOUT)),
      providerTimeoutMs,
    );
    const cancelWatch = setInterval(() => {
      stillOwned(job._id)
        .then((owned) => !owned && controller.abort(cancelled))
        .catch(() => {});
    }, cancelCheckIntervalMs);

    try {
      return await raceAbort(
        provider.discoverBusinesses(params, {
          signal: controller.signal,
          reportRun: reportRun(job._id),
          reportUsage: reportUsage(job._id),
        }),
        controller.signal,
      );
    } catch (err) {
      if (controller.signal.reason === cancelled) return null;
      throw controller.signal.aborted ? controller.signal.reason : err;
    } finally {
      clearTimeout(timeout);
      clearInterval(cancelWatch);
    }
  };

  const processJob = async (job) => {
    if (!providers.includes(job.provider)) {
      throw new ProviderError('This server is not allowed to run this search provider.', {
        code: PROVIDER_ERROR_CODES.CONFIGURATION_ERROR,
      });
    }
    const provider = assertProvider(resolveProvider(job.provider));
    // Never run a job with a different provider than the one it was created for.
    if (provider.name !== job.provider) throw new Error(`Provider mismatch: job "${job.provider}", resolved "${provider.name}"`);
    const { location, radius, categories, maxBusinesses } = job.params;
    const center = job.radiusEnforced ? job.searchArea : null;
    if (center && !isValidCoordinate(center.latitude, center.longitude)) {
      throw new ProviderError('The search location could not be resolved. Please start a new search.');
    }

    // Re-checked here as well as at creation: budgets may have been used up while this job was queued.
    if (job.costCapMicroUsd !== null && job.costCapMicroUsd !== undefined) {
      const reason = await checkBudget({ capMicroUsd: job.costCapMicroUsd, excludeJobId: job._id });
      if (reason) throw new ProviderError(reason, { code: PROVIDER_ERROR_CODES.VALIDATION_ERROR });
    }

    const params = { location, radius, categories: [...categories], maxBusinesses };
    if (center) params.center = { latitude: center.latitude, longitude: center.longitude };

    // One provider call per job: if fewer businesses fall inside the radius than requested,
    // the job simply saves fewer. Paid runs are never repeated automatically.
    const records = await discover(job, provider, params);
    if (records === null || !(await stillOwned(job._id))) return 'cancelled';
    if (!Array.isArray(records)) throw new ProviderError('The data provider returned an invalid response.');

    const valid = records.map((r) => normalizeBusiness(r, provider.name)).filter(Boolean);
    const unique = dedupeBySourceId(valid);
    const open = unique.filter((b) => b.permanentlyClosed !== true);
    const { kept, outsideRadius, missingCoordinates } = center
      ? filterByRadius(open, center, radius)
      : { kept: open, outsideRadius: 0, missingCoordinates: 0 };
    const businesses = kept.slice(0, maxBusinesses).map(({ permanentlyClosed, ...business }) => business);
    await updateProgress(job._id, {
      total: records.length,
      invalid: records.length - valid.length,
      closed: unique.length - open.length,
      outsideRadius,
      missingCoordinates,
      discovered: businesses.length,
    });

    let processed = 0;
    let newProspects = 0;
    for (const batch of chunk(businesses, batchSize)) {
      if (!(await stillOwned(job._id))) return 'cancelled';
      newProspects += await upsertDiscoveredProspects(batch, job._id);
      processed += batch.length;
      await updateProgress(job._id, { processed, newProspects });
      if (addProspectsToLeads) await addBatchToWorkspace(job, batch, provider.name);
      if (analyzeWebsites) await analyzeBatch(job, batch, provider.name);
    }

    const result = await LeadFinderJob.updateOne(ownedRunning(job._id), {
      $set: { status: 'completed', finishedAt: new Date(), heartbeatAt: new Date() },
    });
    return result.modifiedCount === 1 ? 'completed' : 'cancelled';
  };

  const failJob = async (job, err) => {
    const detail = err instanceof ProviderError ? `${err.code}: ${err.message}` : err.message;
    logger.error(`[lead-finder] job ${job._id} failed: ${detail}`);
    await LeadFinderJob.updateOne(ownedRunning(job._id), {
      $set: {
        status: 'failed',
        error: err instanceof ProviderError ? err.message : GENERIC_FAILURE,
        finishedAt: new Date(),
      },
    });
  };

  /**
   * Re-reads the final cost of one finished paid run whose cost is still provisional.
   * After repeated failures the cost is marked unavailable (null), never guessed.
   * Returns the job ID handled, or null when nothing needed settling.
   */
  const settleCostsOnce = async () => {
    const job = await LeadFinderJob.findOne({
      'providerRun.runId': { $ne: null },
      'usage.settledAt': null,
      provider: { $in: providers },
      status: { $in: ['completed', 'failed', 'cancelled'] },
      finishedAt: { $lte: new Date(Date.now() - costSettleDelayMs) },
    })
      .sort({ finishedAt: 1 })
      .select('provider providerRun.runId usage')
      .lean();
    if (!job) return null;

    const provider = resolveProvider(job.provider);
    const settle = (totalMicroUsd) =>
      LeadFinderJob.updateOne(
        { _id: job._id },
        { $set: { 'usage.totalMicroUsd': totalMicroUsd, 'usage.retrievedAt': new Date(), 'usage.settledAt': new Date() } },
      );

    if (typeof provider?.getRunCost !== 'function') {
      await settle(job.usage?.totalMicroUsd ?? null);
      return job._id.toString();
    }
    let totalUsd = null;
    try {
      totalUsd = await provider.getRunCost(job.providerRun.runId);
    } catch (err) {
      logger.warn?.(`[lead-finder] could not read final cost for job ${job._id}: ${err.code ?? 'error'}`);
    }
    const micro = toMicroUsd(totalUsd);
    const attempts = (job.usage?.settleAttempts ?? 0) + 1;
    if (micro !== null) await settle(micro);
    else if (attempts >= maxCostSettleAttempts) await settle(null);
    else await LeadFinderJob.updateOne({ _id: job._id }, { $set: { 'usage.settleAttempts': attempts } });
    return job._id.toString();
  };

  /** Claims and processes at most one job. Returns null when the queue is empty. */
  const runOnce = async () => {
    await recoverStaleJobs();
    const job = await claimNextJob();
    if (!job) return null;

    const heartbeat = setInterval(() => {
      LeadFinderJob.updateOne(ownedRunning(job._id), { $set: { heartbeatAt: new Date() } }).catch(() => {});
    }, heartbeatIntervalMs);

    try {
      return { jobId: job._id.toString(), outcome: await processJob(job) };
    } catch (err) {
      await failJob(job, err);
      return { jobId: job._id.toString(), outcome: 'failed' };
    } finally {
      clearInterval(heartbeat);
    }
  };

  const tick = async () => {
    if (!running) return;
    let result = null;
    try {
      inFlight = runOnce();
      result = await inFlight;
      // Cost settlement only uses idle time and is throttled to one read every few seconds.
      if (!result && Date.now() - lastSettleCheckAt >= SETTLE_CHECK_INTERVAL_MS) {
        lastSettleCheckAt = Date.now();
        inFlight = settleCostsOnce();
        await inFlight;
      }
    } catch (err) {
      logger.error(`[lead-finder] worker error: ${err.message}`);
    } finally {
      inFlight = null;
    }
    // Drain the queue back-to-back; otherwise wait before polling again.
    if (running) timer = setTimeout(tick, result ? 0 : pollIntervalMs);
  };

  return {
    workerId,
    providers: [...providers],
    runOnce,
    settleCostsOnce,
    claimNextJob,
    recoverStaleJobs,
    start() {
      if (running) return;
      running = true;
      timer = setTimeout(tick, 0);
    },
    /** Stops polling and waits for the job currently being processed, if any. */
    async stop() {
      running = false;
      clearTimeout(timer);
      await inFlight?.catch(() => {});
    },
  };
};
