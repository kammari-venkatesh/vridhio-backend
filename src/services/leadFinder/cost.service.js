import { leadFinderConfig } from '../../config/leadFinder.js';
import { ACTIVE_JOB_STATUSES, LeadFinderJob } from '../../models/leadFinderJob.model.js';

// Money is handled as integer micro-USD (1 USD = 1,000,000) so sums never accumulate float errors.
const MICRO = 1_000_000;

export const toMicroUsd = (usd) => (typeof usd === 'number' && Number.isFinite(usd) && usd >= 0 ? Math.round(usd * MICRO) : null);
export const fromMicroUsd = (micro) => (Number.isInteger(micro) ? micro / MICRO : null);

export const DAILY_BUDGET_MESSAGE = "Today's discovery budget has been reached.";
export const MONTHLY_BUDGET_MESSAGE = "This month's discovery budget has been reached.";

export const startOfUtcDay = (date = new Date()) =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
export const startOfUtcMonth = (date = new Date()) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));

/** True once the provider's final cost has been read and recorded. */
export const hasSettledCost = (job) => Boolean(job.usage?.settledAt) && Number.isInteger(job.usage?.totalMicroUsd);

/**
 * What a paid job counts against the budget:
 * - its final provider-reported cost once settled;
 * - its full spending cap while queued or running (it may still spend up to that);
 * - its full cap if a run started but the final cost is not known yet or could not be
 *   retrieved (worst case; the cost reported as a run ends can still grow);
 * - nothing if it never started a paid run.
 */
const chargeFor = (job) => {
  if (hasSettledCost(job)) return { spent: job.usage.totalMicroUsd, reserved: 0 };
  const cap = job.costCapMicroUsd ?? 0;
  if (ACTIVE_JOB_STATUSES.includes(job.status) || job.providerRun?.runId) return { spent: 0, reserved: cap };
  return { spent: 0, reserved: 0 };
};

/** Recorded spend and outstanding reservations of paid jobs created since `since`. */
export const getSpendSince = async (since, { excludeJobId } = {}) => {
  const filter = {
    createdAt: { $gte: since },
    $or: [{ costCapMicroUsd: { $ne: null } }, { 'usage.totalMicroUsd': { $ne: null } }],
  };
  if (excludeJobId) filter._id = { $ne: excludeJobId };
  const jobs = await LeadFinderJob.find(filter).select('status costCapMicroUsd usage providerRun.runId').lean();
  return jobs.reduce(
    (total, job) => {
      const { spent, reserved } = chargeFor(job);
      return { spentMicroUsd: total.spentMicroUsd + spent, reservedMicroUsd: total.reservedMicroUsd + reserved };
    },
    { spentMicroUsd: 0, reservedMicroUsd: 0 },
  );
};

const summarize = ({ spentMicroUsd, reservedMicroUsd }, budgetUsd) => ({
  spentUsd: fromMicroUsd(spentMicroUsd),
  reservedUsd: fromMicroUsd(reservedMicroUsd),
  budgetUsd,
});

/** Today's and this month's discovery spend, for the admin UI. */
export const getSpendSummary = async ({ now = new Date(), budget = leadFinderConfig.budget } = {}) => {
  const [today, month] = await Promise.all([getSpendSince(startOfUtcDay(now)), getSpendSince(startOfUtcMonth(now))]);
  return {
    timezone: 'UTC',
    today: summarize(today, budget.dailyUsd),
    month: summarize(month, budget.monthlyUsd),
  };
};

/**
 * Returns the reason a new paid run of up to `capMicroUsd` would exceed the daily or
 * monthly budget, or null when it fits. Only checked before a run starts: a run that
 * is already going is never stopped for crossing a budget, it just blocks later ones.
 */
export const checkBudget = async ({
  capMicroUsd,
  excludeJobId,
  now = new Date(),
  budget = leadFinderConfig.budget,
}) => {
  const fits = async (since, budgetUsd) => {
    if (budgetUsd === null) return true;
    const { spentMicroUsd, reservedMicroUsd } = await getSpendSince(since, { excludeJobId });
    return spentMicroUsd + reservedMicroUsd + capMicroUsd <= toMicroUsd(budgetUsd);
  };
  if (!(await fits(startOfUtcDay(now), budget.dailyUsd))) return DAILY_BUDGET_MESSAGE;
  if (!(await fits(startOfUtcMonth(now), budget.monthlyUsd))) return MONTHLY_BUDGET_MESSAGE;
  return null;
};

/** Cost per newly saved prospect in micro-USD, or null when cost is unknown or nothing new was found. */
export const costPerNewProspectMicroUsd = (totalMicroUsd, newProspects) =>
  Number.isInteger(totalMicroUsd) && Number.isInteger(newProspects) && newProspects > 0
    ? Math.round(totalMicroUsd / newProspects)
    : null;
