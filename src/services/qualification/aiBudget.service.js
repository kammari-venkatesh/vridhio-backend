import { qualificationConfig } from '../../config/qualification.js';
import { AiUsageRecord } from '../../models/aiUsageRecord.model.js';
import { fromMicroUsd, startOfUtcDay, startOfUtcMonth, toMicroUsd } from '../leadFinder/cost.service.js';

export const AI_DAILY_BUDGET_MESSAGE = "Today's AI qualification budget has been reached.";
export const AI_MONTHLY_BUDGET_MESSAGE = "This month's AI qualification budget has been reached.";

/**
 * AI spend of attempts created since `since`:
 * - settled: provider-reported tokens priced at the configured rates;
 * - reserved: the full estimate of attempts still queued or running;
 * - unavailable: the full estimate of attempts whose provider call happened but
 *   whose usage is unknown (never counted as $0).
 */
export const getAiSpendSince = async (since, { excludeRecordId } = {}) => {
  const filter = { createdAt: { $gte: since }, status: { $ne: 'RELEASED' } };
  if (excludeRecordId) filter._id = { $ne: excludeRecordId };
  const records = await AiUsageRecord.find(filter).select('status reservedMicroUsd costMicroUsd').lean();
  const total = { settledMicroUsd: 0, reservedMicroUsd: 0, unavailableMicroUsd: 0 };
  for (const r of records) {
    if (r.status === 'SETTLED') total.settledMicroUsd += r.costMicroUsd ?? 0;
    else if (r.status === 'RESERVED') total.reservedMicroUsd += r.reservedMicroUsd ?? 0;
    else if (r.status === 'UNAVAILABLE') total.unavailableMicroUsd += r.reservedMicroUsd ?? 0;
  }
  return total;
};

const committed = (t) => t.settledMicroUsd + t.reservedMicroUsd + t.unavailableMicroUsd;

/**
 * The reason an attempt costing up to `estimateMicroUsd` would exceed the daily or
 * monthly AI budget (settled + reserved + unavailable + estimate), or null if it fits.
 */
export const checkAiBudget = async ({ estimateMicroUsd, excludeRecordId, now = new Date(), budget = qualificationConfig.budget }) => {
  const fits = async (since, budgetUsd) => {
    if (budgetUsd === null) return true;
    const spend = await getAiSpendSince(since, { excludeRecordId });
    return committed(spend) + estimateMicroUsd <= toMicroUsd(budgetUsd);
  };
  if (!(await fits(startOfUtcDay(now), budget.dailyUsd))) return AI_DAILY_BUDGET_MESSAGE;
  if (!(await fits(startOfUtcMonth(now), budget.monthlyUsd))) return AI_MONTHLY_BUDGET_MESSAGE;
  return null;
};

export const reserveAiUsage = ({ qualificationId, provider, model, reservedMicroUsd }) =>
  AiUsageRecord.create({ qualificationId, provider, model, status: 'RESERVED', reservedMicroUsd });

export const updateReservation = (recordId, reservedMicroUsd) =>
  AiUsageRecord.updateOne({ _id: recordId, status: 'RESERVED' }, { $set: { reservedMicroUsd } });

export const markProviderCalled = (recordId, at = new Date()) =>
  AiUsageRecord.updateOne({ _id: recordId, status: 'RESERVED' }, { $set: { providerCalledAt: at } });

/** Replaces the reservation with the actual cost from reported token usage. */
export const settleAiUsage = (recordId, usage, costMicroUsd, at = new Date()) =>
  AiUsageRecord.updateOne(
    { _id: recordId, status: 'RESERVED' },
    {
      $set: {
        status: 'SETTLED',
        costMicroUsd,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
        settledAt: at,
      },
    },
  );

/**
 * The provider was called but its cost is unknown (no usage reported, or no price for
 * the model): the reservation stays counted. Reported tokens are still recorded.
 */
export const markAiUsageUnavailable = (recordId, { usage = null, at = new Date() } = {}) =>
  AiUsageRecord.updateOne(
    { _id: recordId, status: 'RESERVED' },
    {
      $set: {
        status: 'UNAVAILABLE',
        settledAt: at,
        ...(usage && { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: usage.totalTokens }),
      },
    },
  );

/** The provider was never called: nothing is charged. */
export const releaseAiUsage = (recordId, at = new Date()) =>
  AiUsageRecord.updateOne({ _id: recordId, status: 'RESERVED' }, { $set: { status: 'RELEASED', settledAt: at } });

const summarize = (t, budgetUsd) => ({
  settledUsd: fromMicroUsd(t.settledMicroUsd),
  reservedUsd: fromMicroUsd(t.reservedMicroUsd),
  unavailableUsd: fromMicroUsd(t.unavailableMicroUsd),
  committedUsd: fromMicroUsd(committed(t)),
  budgetUsd,
});

/** Today's and this month's AI spend for the admin UI. */
export const getAiSpendSummary = async ({ now = new Date(), budget = qualificationConfig.budget } = {}) => {
  const [today, month] = await Promise.all([getAiSpendSince(startOfUtcDay(now)), getAiSpendSince(startOfUtcMonth(now))]);
  return { timezone: 'UTC', today: summarize(today, budget.dailyUsd), month: summarize(month, budget.monthlyUsd) };
};
