import express, { Router } from 'express';
import {
  archiveLead,
  bulkUpdate,
  createLead,
  createLeadsBatch,
  exportLeads,
  getLead,
  listLeads,
  updateLead,
} from '../../controllers/admin/leadWorkspace.controller.js';
import {
  analyzeLead,
  bulkAnalyzeLeads,
  getLeadAnalysis,
  leadAnalysisStatuses,
  refreshLead,
} from '../../controllers/admin/websiteAnalysis.controller.js';
import {
  bulkQualifyLeads,
  getLeadQualification,
  leadQualificationStatuses,
  qualifyLead,
  refreshLeadQualification,
} from '../../controllers/admin/qualification.controller.js';
import {
  approveLead,
  createLeadReview,
  getLeadReview,
  leadOutreachPreview,
  rejectLead,
  updateLeadReview,
} from '../../controllers/admin/review.controller.js';
import {
  qualificationBulkRateLimiter,
  qualificationRateLimiter,
  qualificationRefreshRateLimiter,
  reviewRateLimiter,
  websiteAnalysisBulkRateLimiter,
  websiteAnalysisRateLimiter,
  websiteAnalysisRefreshRateLimiter,
} from '../../middleware/rateLimiters.js';

// Sales leads (Lead Workspace). Mounted at /api/admin/leads behind requireAuth + requireAdmin.
// Inbound contact-form leads stay at /api/leads.
const router = Router();
// Up to 500 pasted rows; the app-level 100kb parser skips this path so only admins reach it.
const batchJson = express.json({ limit: '1mb' });
const refreshBudgetIfRequested = (req, res, next) =>
  req.body?.refresh === true ? websiteAnalysisRefreshRateLimiter(req, res, next) : next();
const qualificationRefreshIfRequested = (req, res, next) =>
  req.body?.refresh === true ? qualificationRefreshRateLimiter(req, res, next) : next();

router.get('/', listLeads);
router.post('/', createLead);
router.post('/batch', batchJson, createLeadsBatch);
router.get('/export', exportLeads);
router.patch('/bulk', bulkUpdate);
router.post('/analyze/bulk', websiteAnalysisBulkRateLimiter, bulkAnalyzeLeads);
router.get('/analysis-status', leadAnalysisStatuses);
router.post('/qualification/bulk', qualificationBulkRateLimiter, bulkQualifyLeads);
router.get('/qualification-status', leadQualificationStatuses);
router.get('/:leadId', getLead);
router.patch('/:leadId', updateLead);
router.delete('/:leadId', archiveLead);
router.post('/:leadId/analyze', websiteAnalysisRateLimiter, refreshBudgetIfRequested, analyzeLead);
router.post('/:leadId/analyze/refresh', websiteAnalysisRefreshRateLimiter, refreshLead);
router.get('/:leadId/analysis', getLeadAnalysis);
router.post('/:leadId/qualify', qualificationRateLimiter, qualificationRefreshIfRequested, qualifyLead);
router.post('/:leadId/qualify/refresh', qualificationRefreshRateLimiter, refreshLeadQualification);
router.get('/:leadId/qualification', getLeadQualification);
router.get('/:leadId/review', getLeadReview);
router.post('/:leadId/review', reviewRateLimiter, createLeadReview);
router.patch('/:leadId/review', reviewRateLimiter, updateLeadReview);
router.post('/:leadId/review/approve', reviewRateLimiter, approveLead);
router.post('/:leadId/review/reject', reviewRateLimiter, rejectLead);
router.get('/:leadId/outreach-preview', leadOutreachPreview);

export default router;
