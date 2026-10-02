import { Router } from 'express';
import { createLead, listLeads } from '../controllers/lead.controller.js';
import { noStore } from '../middleware/noStore.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireAdmin } from '../middleware/requireRole.js';

const router = Router();

router.post('/', createLead);
router.get('/', noStore, requireAuth, requireAdmin, listLeads);

export default router;
