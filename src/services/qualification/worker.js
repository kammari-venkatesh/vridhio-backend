import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { qualificationConfig } from '../../config/qualification.js';
import { AiUsageRecord } from '../../models/aiUsageRecord.model.js';
import { ProspectQualification } from '../../models/prospectQualification.model.js';
import { ProspectWebsiteAnalysis } from '../../models/prospectWebsiteAnalysis.model.js';
import {
  checkAiBudget,
  markAiUsageUnavailable,
  markProviderCalled,
  releaseAiUsage,
  reserveAiUsage,
  settleAiUsage,
  updateReservation,
} from './aiBudget.service.js';
import { validateQualificationOutput } from './outputValidator.js';
import { QUALIFICATION_PROMPT_VERSION } from './prompt.js';
import { getQualificationProvider } from './providers/index.js';
import { QUALIFICATION_ERROR_CODES as C, QualificationError, safeQualificationMessage } from './qualificationErrors.js';
import { isUsableAnalysis, prepareQualificationInput } from './qualification.service.js';

const targetOf = (doc) => ({
  subjectKey: doc.subjectKey,
  prospectId: doc.prospectId,
  salesLeadId: doc.salesLeadId,
});

/**
 * MongoDB-backed qualification worker, following the website analysis worker: atomic
 * claim, heartbeat, stale recovery. Each attempt has one AiUsageRecord: reserved at
 * request time, re-checked against the budget before the provider is called, then
 * settled from reported tokens, marked UNAVAILABLE (provider called, usage unknown) or
 * released (provider never called). Paid calls are never retried automatically.
 */
export const createQualificationWorker = ({
  provider: injectedProvider,
  workerId = `${os.hostname()}:${process.pid}:q-${randomUUID().slice(0, 8)}`,
  pollIntervalMs = qualificationConfig.worker.pollIntervalMs,
  heartbeatIntervalMs = qualificationConfig.worker.heartbeatIntervalMs,
  staleAfterMs = qualificationConfig.worker.staleAfterMs,
  logger = console,
} = {}) => {
  let running = false;
  let timer = null;
  let current = null;

  const owned = (id) => ({ _id: id, status: 'ANALYZING', lockedBy: workerId });

  const claimNext = () => {
    const now = new Date();
    return ProspectQualification.findOneAndUpdate(
      { status: 'QUEUED' },
      {
        $set: { status: 'ANALYZING', startedAt: now, lastAttemptAt: now, heartbeatAt: now, lockedBy: workerId },
        $inc: { attemptCount: 1 },
      },
      { sort: { requestedAt: 1, _id: 1 }, returnDocument: 'after' },
    );
  };

  /** Fails qualifications whose worker stopped heartbeating, and settles their ledger entries. */
  const recoverStale = async () => {
    const stale = await ProspectQualification.find({
      status: 'ANALYZING',
      heartbeatAt: { $lt: new Date(Date.now() - staleAfterMs) },
    }).select('_id usageRecordId');
    for (const doc of stale) {
      const res = await ProspectQualification.updateOne(
        { _id: doc._id, status: 'ANALYZING', heartbeatAt: { $lt: new Date(Date.now() - staleAfterMs) } },
        {
          $set: {
            status: 'FAILED',
            errorCode: C.INTERRUPTED,
            errorMessage: safeQualificationMessage(C.INTERRUPTED),
            failedAt: new Date(),
            lockedBy: null,
            heartbeatAt: null,
          },
        },
      );
      if (res.modifiedCount === 1 && doc.usageRecordId) {
        const record = await AiUsageRecord.findById(doc.usageRecordId).select('providerCalledAt');
        if (record?.providerCalledAt) await markAiUsageUnavailable(doc.usageRecordId);
        else await releaseAiUsage(doc.usageRecordId);
      }
    }
    return stale.length;
  };

  const fail = async (doc, err, { usage = null, costMicroUsd = null, costStatus = null, durationMs = null } = {}) => {
    const code = err instanceof QualificationError ? err.code : C.QUALIFICATION_ERROR;
    await ProspectQualification.updateOne(owned(doc._id), {
      $set: {
        status: 'FAILED',
        errorCode: code,
        errorMessage: safeQualificationMessage(code),
        failedAt: new Date(),
        durationMs,
        usage: { ...(usage ?? {}), costMicroUsd, costStatus },
        lockedBy: null,
        heartbeatAt: null,
      },
    });
    return 'FAILED';
  };

  /** Qualifies one claimed record. Returns the stored status. */
  const qualifyClaimed = async (doc) => {
    const provider = injectedProvider ?? getQualificationProvider();
    let recordId = doc.usageRecordId;
    const heartbeat = setInterval(() => {
      ProspectQualification.updateOne(owned(doc._id), { $set: { heartbeatAt: new Date() } }).catch(() => {});
    }, heartbeatIntervalMs);
    const started = Date.now();
    let providerCalled = false;

    try {
      if (!provider) throw new QualificationError(C.AI_DISABLED);
      const analysisDoc = await ProspectWebsiteAnalysis.findOne({ subjectKey: doc.subjectKey });
      const target = { ...targetOf(doc), websiteUrl: analysisDoc?.website?.websiteUrl ?? null };
      if (!analysisDoc || !isUsableAnalysis(analysisDoc, target)) throw new QualificationError(C.ANALYSIS_REQUIRED);

      const { evidence, candidates, payload, messages } = await prepareQualificationInput(target, analysisDoc);
      const estimate = provider.estimateMaxCostMicroUsd(messages);
      if (recordId) await updateReservation(recordId, estimate);
      else {
        recordId = (await reserveAiUsage({ qualificationId: doc._id, provider: provider.name, model: provider.model, reservedMicroUsd: estimate }))._id;
        await ProspectQualification.updateOne(owned(doc._id), { $set: { usageRecordId: recordId } });
      }
      const overBudget = await checkAiBudget({ estimateMicroUsd: estimate, excludeRecordId: recordId });
      if (overBudget) throw new QualificationError(C.BUDGET_EXCEEDED, { detail: overBudget });

      // Facts sent are recorded first, so a failed attempt still shows what was used.
      await ProspectQualification.updateOne(owned(doc._id), {
        $set: {
          analysisId: analysisDoc._id,
          analysisAnalyzedAt: analysisDoc.analyzedAt,
          provider: provider.name,
          model: provider.model,
          promptVersion: QUALIFICATION_PROMPT_VERSION,
          evidenceSnapshot: evidence,
          candidateServiceIds: candidates.map((c) => c.serviceId),
        },
      });

      await markProviderCalled(recordId);
      providerCalled = true;
      const { output, usage } = await provider.analyzeProspect({ payload, messages });
      const costMicroUsd = provider.costMicroUsd(usage);
      if (usage && costMicroUsd !== null) await settleAiUsage(recordId, usage, costMicroUsd);
      else await markAiUsageUnavailable(recordId, { usage });
      const costStatus = !usage || costMicroUsd === null ? 'UNAVAILABLE' : provider.paid ? 'SETTLED' : 'NONE';
      const durationMs = Date.now() - started;

      let validated;
      try {
        validated = validateQualificationOutput(output, { evidence, candidates });
      } catch (err) {
        logger.warn(`[qualification] ${doc._id} output rejected: ${err.message}`);
        return await fail(doc, err, { usage, costMicroUsd, costStatus, durationMs });
      }
      const { value, validation } = validated;
      const res = await ProspectQualification.updateOne(owned(doc._id), {
        $set: {
          status: 'COMPLETED',
          completedAt: new Date(),
          errorCode: null,
          errorMessage: null,
          ...value,
          validation,
          usage: { ...usage, costMicroUsd, costStatus },
          durationMs,
          lockedBy: null,
          heartbeatAt: null,
        },
      });
      return res.modifiedCount === 1 ? 'COMPLETED' : 'LOST';
    } catch (err) {
      const code = err instanceof QualificationError ? err.code : C.QUALIFICATION_ERROR;
      if (code === C.QUALIFICATION_ERROR) logger.error(`[qualification] ${doc._id} failed unexpectedly: ${err?.message}`);
      else logger.warn(`[qualification] ${doc._id} failed: ${code}`);

      // Ledger: priced tokens -> settle; provider reached but cost unknown -> unavailable; otherwise release.
      const usage = err?.usage ?? null;
      let costMicroUsd = null;
      let costStatus = null;
      if (recordId) {
        const reachedProvider = providerCalled && (err instanceof QualificationError ? err.providerCalled : true);
        costMicroUsd = usage && provider ? provider.costMicroUsd(usage) : null;
        if (costMicroUsd !== null) {
          await settleAiUsage(recordId, usage, costMicroUsd);
          costStatus = provider.paid ? 'SETTLED' : 'NONE';
        } else if (usage || reachedProvider) {
          await markAiUsageUnavailable(recordId, { usage });
          costStatus = 'UNAVAILABLE';
        } else {
          await releaseAiUsage(recordId);
        }
      }
      return fail(doc, err, { usage, costMicroUsd, costStatus, durationMs: Date.now() - started });
    } finally {
      clearInterval(heartbeat);
    }
  };

  /** Claims and qualifies at most one business. Returns null when nothing is queued. */
  const runOnce = async () => {
    await recoverStale();
    const doc = await claimNext();
    if (!doc) return null;
    return { qualificationId: doc._id.toString(), outcome: await qualifyClaimed(doc) };
  };

  const tick = async () => {
    if (!running) return;
    try {
      current = runOnce();
      const result = await current;
      current = null;
      if (running) {
        clearTimeout(timer);
        timer = setTimeout(tick, result ? 0 : pollIntervalMs);
      }
      return;
    } catch (err) {
      current = null;
      logger.error(`[qualification] worker error: ${err.message}`);
    }
    if (running) {
      clearTimeout(timer);
      timer = setTimeout(tick, pollIntervalMs);
    }
  };

  return {
    workerId,
    runOnce,
    claimNext,
    recoverStale,
    start() {
      if (running) return;
      running = true;
      timer = setTimeout(tick, 0);
    },
    /** Stops polling and waits for the qualification in progress. */
    async stop() {
      running = false;
      clearTimeout(timer);
      await Promise.allSettled(current ? [current] : []);
    },
  };
};
