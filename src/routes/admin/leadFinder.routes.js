import { Router } from 'express';
import {
  cancelJob,
  createJob,
  getJob,
  listJobs,
  listProspects,
  providerStatus,
  usageSummary,
} from '../../controllers/admin/leadFinder.controller.js';
import { promoteProspect } from '../../controllers/admin/leadWorkspace.controller.js';
import {
  analyzeProspect,
  cancelAnalysisJob,
  getAnalysisJob,
  getProspectAnalysis,
  refreshProspect,
} from '../../controllers/admin/websiteAnalysis.controller.js';
import {
  aiStatus,
  getProspectQualification,
  qualifyProspect,
  refreshProspectQualification,
} from '../../controllers/admin/qualification.controller.js';
import {
  jobCreationRateLimiter,
  qualificationRateLimiter,
  qualificationRefreshRateLimiter,
  websiteAnalysisRateLimiter,
  websiteAnalysisRefreshRateLimiter,
} from '../../middleware/rateLimiters.js';

// Mounted behind requireAuth + requireAdmin in routes/admin/index.js.
const router = Router();

// `{ refresh: true }` on the analyze endpoint counts against the refresh budget too.
const refreshBudgetIfRequested = (req, res, next) =>
  req.body?.refresh === true ? websiteAnalysisRefreshRateLimiter(req, res, next) : next();

router.get('/provider-status', providerStatus);
router.get('/usage', usageSummary);
router.post('/jobs', jobCreationRateLimiter, createJob);
router.get('/jobs', listJobs);
router.get('/jobs/:jobId', getJob);
router.get('/jobs/:jobId/prospects', listProspects);
router.post('/jobs/:jobId/cancel', cancelJob);
router.post('/prospects/:prospectId/promote', promoteProspect);

// Website & digital presence analysis (Phase 4). Never started by discovery itself.
router.post('/prospects/:prospectId/analyze', websiteAnalysisRateLimiter, refreshBudgetIfRequested, analyzeProspect);
router.post('/prospects/:prospectId/analyze/refresh', websiteAnalysisRefreshRateLimiter, refreshProspect);
router.get('/prospects/:prospectId/analysis', getProspectAnalysis);
router.get('/website-analysis/jobs/:jobId', getAnalysisJob);
router.post('/website-analysis/jobs/:jobId/cancel', cancelAnalysisJob);

// AI qualification (Phase 5). Reads stored facts only; never starts an analysis.
const qualificationRefreshIfRequested = (req, res, next) =>
  req.body?.refresh === true ? qualificationRefreshRateLimiter(req, res, next) : next();
router.get('/ai/status', aiStatus);
router.post('/prospects/:prospectId/qualify', qualificationRateLimiter, qualificationRefreshIfRequested, qualifyProspect);
router.post('/prospects/:prospectId/qualify/refresh', qualificationRefreshRateLimiter, refreshProspectQualification);
router.get('/prospects/:prospectId/qualification', getProspectQualification);

export default router;
