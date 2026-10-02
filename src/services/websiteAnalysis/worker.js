import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { websiteAnalysisConfig } from '../../config/websiteAnalysis.js';
import { ProspectWebsiteAnalysis } from '../../models/prospectWebsiteAnalysis.model.js';
import { ANALYSIS_ERROR_CODES as C, safeErrorMessage } from './analysisErrors.js';
import { buildFailureEvidence } from './evidenceBuilder.js';
import { resultToUpdate } from './websiteAnalysis.service.js';
import { createWebsiteAnalyzer } from './websiteAnalyzer.js';

/**
 * MongoDB-backed website analysis worker, following the Lead Finder worker pattern:
 * QUEUED analyses are claimed with an atomic findOneAndUpdate (safe with several
 * workers), kept alive by a heartbeat, and recovered as FAILED/INTERRUPTED if their
 * worker disappears. At most `concurrency` websites are analysed at once.
 */
export const createWebsiteAnalysisWorker = ({
  analyzer = createWebsiteAnalyzer(),
  workerId = `${os.hostname()}:${process.pid}:wa-${randomUUID().slice(0, 8)}`,
  concurrency = websiteAnalysisConfig.worker.concurrency,
  pollIntervalMs = websiteAnalysisConfig.worker.pollIntervalMs,
  heartbeatIntervalMs = websiteAnalysisConfig.worker.heartbeatIntervalMs,
  staleAfterMs = websiteAnalysisConfig.worker.staleAfterMs,
  maxAnalysisMs = websiteAnalysisConfig.worker.maxAnalysisMs,
  logger = console,
} = {}) => {
  let running = false;
  let timer = null;
  const inFlight = new Set();

  const owned = (id) => ({ _id: id, status: 'ANALYZING', lockedBy: workerId });

  const claimNext = () => {
    const now = new Date();
    return ProspectWebsiteAnalysis.findOneAndUpdate(
      { status: 'QUEUED' },
      {
        $set: { status: 'ANALYZING', startedAt: now, lastAttemptAt: now, heartbeatAt: now, lockedBy: workerId },
        $inc: { attemptCount: 1 },
      },
      { sort: { queuedAt: 1, _id: 1 }, returnDocument: 'after' },
    );
  };

  const recoverStale = () =>
    ProspectWebsiteAnalysis.updateMany(
      { status: 'ANALYZING', heartbeatAt: { $lt: new Date(Date.now() - staleAfterMs) } },
      {
        $set: {
          status: 'FAILED',
          errorCode: C.INTERRUPTED,
          errorMessage: safeErrorMessage(C.INTERRUPTED),
          completedAt: new Date(),
          lockedBy: null,
          heartbeatAt: null,
        },
      },
    );

  /** Analyses one claimed document. A cancelled analysis is aborted and its result discarded. */
  const analyseClaimed = async (doc) => {
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(new Error('analysis deadline')), maxAnalysisMs);
    const heartbeat = setInterval(() => {
      ProspectWebsiteAnalysis.updateOne(owned(doc._id), { $set: { heartbeatAt: new Date() } })
        .then((r) => {
          if (r.matchedCount === 0) controller.abort(new Error('cancelled'));
        })
        .catch(() => {});
    }, heartbeatIntervalMs);

    let result;
    try {
      result = await analyzer.analyze({ websiteUrl: doc.website?.websiteUrl ?? null }, { signal: controller.signal });
    } catch (err) {
      logger.error(`[website-analysis] analysis ${doc._id} failed unexpectedly: ${err?.message}`);
      result = {
        status: 'FAILED',
        errorCode: C.ANALYSIS_ERROR,
        errorMessage: safeErrorMessage(C.ANALYSIS_ERROR),
        website: { websiteUrl: doc.website?.websiteUrl ?? null, normalizedWebsiteUrl: null, hasWebsite: Boolean(doc.website?.websiteUrl) },
        evidence: buildFailureEvidence({ errorCode: C.ANALYSIS_ERROR }),
      };
    } finally {
      clearTimeout(deadline);
      clearInterval(heartbeat);
    }

    const update = await ProspectWebsiteAnalysis.updateOne(owned(doc._id), {
      $set: resultToUpdate(result, { websiteSource: doc.website?.websiteSource }),
    });
    return update.modifiedCount === 1 ? result.status : 'CANCELLED';
  };

  /** Claims and analyses at most one website. Returns null when nothing is queued. */
  const runOnce = async () => {
    await recoverStale();
    const doc = await claimNext();
    if (!doc) return null;
    return { analysisId: doc._id.toString(), outcome: await analyseClaimed(doc) };
  };

  const tick = async () => {
    if (!running) return;
    try {
      await recoverStale();
      while (running && inFlight.size < concurrency) {
        const doc = await claimNext();
        if (!doc) break;
        const task = analyseClaimed(doc)
          .catch((err) => logger.error(`[website-analysis] worker error: ${err.message}`))
          .finally(() => {
            inFlight.delete(task);
            if (running) {
              clearTimeout(timer);
              timer = setTimeout(tick, 0);
            }
          });
        inFlight.add(task);
      }
    } catch (err) {
      logger.error(`[website-analysis] worker error: ${err.message}`);
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
    /** Stops polling and waits for analyses in progress. */
    async stop() {
      running = false;
      clearTimeout(timer);
      await Promise.allSettled([...inFlight]);
    },
  };
};
