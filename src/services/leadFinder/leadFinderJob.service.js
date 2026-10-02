import mongoose from 'mongoose';
import { leadFinderConfig } from '../../config/leadFinder.js';
import { ACTIVE_JOB_STATUSES, LeadFinderJob } from '../../models/leadFinderJob.model.js';
import { ApiError } from '../../utils/ApiError.js';
import { checkBudget, costPerNewProspectMicroUsd, fromMicroUsd, hasSettledCost, toMicroUsd } from './cost.service.js';
import { GeocodingError, resolveSearchCenter } from './geocoding.service.js';
import { PROVIDER_ERROR_CODES, ProviderError, SAFE_PROVIDER_MESSAGES } from './provider.interface.js';
import { getProvider, isKnownProvider } from './providers.js';

const isPaidJob = (job) => job.costCapMicroUsd !== null && job.costCapMicroUsd !== undefined;

/**
 * Cost as shown to admins. "test": no paid provider; "pending": run still going or its
 * final cost not settled yet; "recorded": final provider-reported cost; "unavailable":
 * a paid run happened but its cost could not be retrieved; "none": no paid run started.
 */
const costDto = (job) => {
  if (!isPaidJob(job)) return { status: 'test', totalUsd: null, perNewProspectUsd: null };
  if (hasSettledCost(job)) {
    const total = job.usage.totalMicroUsd;
    return {
      status: 'recorded',
      totalUsd: fromMicroUsd(total),
      perNewProspectUsd: fromMicroUsd(costPerNewProspectMicroUsd(total, job.progress.newProspects)),
    };
  }
  let status = 'none';
  if (ACTIVE_JOB_STATUSES.includes(job.status)) status = 'pending';
  else if (job.providerRun?.runId) status = job.usage?.settledAt ? 'unavailable' : 'pending';
  return { status, totalUsd: null, perNewProspectUsd: null };
};

/** Public shape of a job; worker lease fields and provider internals stay server-side. */
export const toJobDto = (job) => ({
  id: job._id.toString(),
  status: job.status,
  providerMode: isPaidJob(job) ? 'live' : 'test',
  params: {
    location: job.params.location,
    radius: job.params.radius,
    categories: [...job.params.categories],
    maxBusinesses: job.params.maxBusinesses,
  },
  searchArea: job.radiusEnforced
    ? {
        label: job.searchArea.label,
        latitude: job.searchArea.latitude,
        longitude: job.searchArea.longitude,
        radiusEnforced: true,
      }
    : { label: null, latitude: null, longitude: null, radiusEnforced: false },
  progress: {
    total: job.progress.total,
    invalid: job.progress.invalid ?? 0,
    closed: job.progress.closed ?? 0,
    outsideRadius: job.progress.outsideRadius ?? 0,
    missingCoordinates: job.progress.missingCoordinates ?? 0,
    discovered: job.progress.discovered,
    processed: job.progress.processed,
    newProspects: job.progress.newProspects,
    qualified: job.progress.qualified,
  },
  cost: costDto(job),
  error: job.error,
  createdAt: job.createdAt,
  updatedAt: job.updatedAt,
  startedAt: job.startedAt,
  finishedAt: job.finishedAt,
});

export const findJobOrThrow = async (jobId) => {
  const job = mongoose.isValidObjectId(jobId) ? await LeadFinderJob.findById(jobId) : null;
  if (!job) throw new ApiError(404, 'Lead Finder job not found');
  return job;
};

/**
 * Rejects searches the configured provider cannot run (not configured, over its
 * limits) before anything is queued or any paid run starts.
 */
const assertProviderCanRun = (providerName, params, resolveProvider) => {
  if (!isKnownProvider(providerName)) {
    throw new ApiError(503, SAFE_PROVIDER_MESSAGES[PROVIDER_ERROR_CODES.CONFIGURATION_ERROR]);
  }
  const provider = resolveProvider(providerName);
  try {
    provider.validateRequest?.(params);
  } catch (err) {
    if (!(err instanceof ProviderError)) throw err;
    throw new ApiError(err.code === PROVIDER_ERROR_CODES.VALIDATION_ERROR ? 400 : 503, err.message);
  }
  return provider;
};

const resolveArea = async (location, geocode) => {
  try {
    return await geocode(location);
  } catch (err) {
    if (err instanceof GeocodingError) throw new ApiError(err.code === 'NOT_FOUND' ? 400 : 503, err.message);
    throw err;
  }
};

/**
 * Validates, budgets and queues a search. Everything that can reject it (provider
 * configuration, limits, active-job cap, budget, unresolvable location) runs before
 * the job is stored, so a rejected search never reaches a paid provider.
 */
export const createJob = async (
  params,
  adminId,
  { resolveProvider = getProvider, geocode = resolveSearchCenter } = {},
) => {
  const provider = assertProviderCanRun(leadFinderConfig.provider, params, resolveProvider);

  const { maxActiveJobs } = leadFinderConfig.limits;
  const activeJobs = await LeadFinderJob.countDocuments({ status: { $in: ACTIVE_JOB_STATUSES } });
  if (activeJobs >= maxActiveJobs) {
    throw new ApiError(
      429,
      `Up to ${maxActiveJobs} searches can run at once. Wait for one to finish or cancel it.`,
    );
  }

  const costCapMicroUsd = typeof provider.maxRunCostUsd === 'function' ? toMicroUsd(provider.maxRunCostUsd()) : null;
  if (costCapMicroUsd !== null) {
    const reason = await checkBudget({ capMicroUsd: costCapMicroUsd });
    if (reason) throw new ApiError(429, reason);
  }

  const searchArea = provider.supportsRadius ? await resolveArea(params.location, geocode) : null;

  const job = await LeadFinderJob.create({
    params,
    provider: leadFinderConfig.provider,
    createdBy: adminId,
    costCapMicroUsd,
    radiusEnforced: Boolean(searchArea),
    ...(searchArea && { searchArea }),
  });
  return toJobDto(job);
};

export const getJob = async (jobId) => toJobDto(await findJobOrThrow(jobId));

export const listJobs = async ({ page, limit }) => {
  const [jobs, total] = await Promise.all([
    LeadFinderJob.find()
      .sort({ createdAt: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    LeadFinderJob.countDocuments(),
  ]);
  return { items: jobs.map(toJobDto), page, limit, total, totalPages: Math.ceil(total / limit) };
};

/**
 * Queued jobs are cancelled immediately. Running jobs are marked cancelled too; the
 * worker checks the status between processing steps and stops without completing.
 */
export const cancelJob = async (jobId) => {
  if (!mongoose.isValidObjectId(jobId)) throw new ApiError(404, 'Lead Finder job not found');

  const job = await LeadFinderJob.findOneAndUpdate(
    { _id: jobId, status: { $in: ACTIVE_JOB_STATUSES } },
    { $set: { status: 'cancelled', finishedAt: new Date() } },
    { returnDocument: 'after' },
  );
  if (job) return toJobDto(job);

  await findJobOrThrow(jobId);
  throw new ApiError(409, 'Only queued or running jobs can be cancelled');
};
