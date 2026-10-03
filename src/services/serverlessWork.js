import { waitUntil } from '@vercel/functions';
import { leadFinderConfig } from '../config/leadFinder.js';
import { websiteAnalysisConfig } from '../config/websiteAnalysis.js';
import { qualificationConfig } from '../config/qualification.js';
import { createLeadFinderWorker } from './leadFinder/worker.js';
import { createWebsiteAnalysisWorker } from './websiteAnalysis/worker.js';
import { qualificationProviderStatus } from './qualification/providers/index.js';
import { createQualificationWorker } from './qualification/worker.js';

// Stays well inside Vercel's function duration limit (300 s by default with fluid compute).
const DRAIN_BUDGET_MS = 240_000;

let workers = null;
let draining = null;

const getWorkers = () => {
  workers ??= [
    leadFinderConfig.workerEnabled && createLeadFinderWorker(),
    websiteAnalysisConfig.workerEnabled && createWebsiteAnalysisWorker(),
    qualificationConfig.workerEnabled &&
      ['live', 'test'].includes(qualificationProviderStatus().mode) &&
      createQualificationWorker(),
  ].filter(Boolean);
  return workers;
};

/** Processes queued jobs, analyses and qualifications until all queues are empty or the budget runs out. */
export const drainQueues = async ({ budgetMs = DRAIN_BUDGET_MS, logger = console } = {}) => {
  const deadline = Date.now() + budgetMs;
  const leadFinder = getWorkers().find((worker) => worker.settleCostsOnce);
  for (const worker of getWorkers()) {
    try {
      while (Date.now() < deadline && (await worker.runOnce())) {
        /* keep draining */
      }
    } catch (err) {
      logger.error(`[serverless-work] ${worker.workerId}: ${err.message}`);
    }
  }
  await leadFinder?.settleCostsOnce?.().catch(() => {});
};

/**
 * Serverless hosts never run server.js, so its polling workers don't exist there. Instead every
 * admin request kicks a drain that outlives the response (waitUntil). One drain per instance at
 * a time; claims are atomic, so concurrent instances never process the same item.
 */
export const kickBackgroundWork = (_req, _res, next) => {
  if (!draining) {
    draining = drainQueues().finally(() => {
      draining = null;
    });
    waitUntil(draining);
  }
  next();
};
