import { Router } from 'express';
import {
  approveProspect,
  createProspectReview,
  getProspectReview,
  prospectOutreachPreview,
  rejectProspect,
  updateProspectReview,
} from '../../controllers/admin/review.controller.js';
import { reviewRateLimiter } from '../../middleware/rateLimiters.js';

// Human review of discovered prospects. Mounted at /api/admin/prospects behind
// requireAuth + requireAdmin. Nothing here contacts a business.
const router = Router();

router.get('/:prospectId/review', getProspectReview);
router.post('/:prospectId/review', reviewRateLimiter, createProspectReview);
router.patch('/:prospectId/review', reviewRateLimiter, updateProspectReview);
router.post('/:prospectId/approve', reviewRateLimiter, approveProspect);
router.post('/:prospectId/reject', reviewRateLimiter, rejectProspect);
router.post('/:prospectId/review/approve', reviewRateLimiter, approveProspect);
router.post('/:prospectId/review/reject', reviewRateLimiter, rejectProspect);
router.get('/:prospectId/outreach-preview', prospectOutreachPreview);

export default router;
