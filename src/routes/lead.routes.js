import { Router } from 'express';
import { createLead, listLeads } from '../controllers/lead.controller.js';

const router = Router();

router.post('/', createLead);
router.get('/', listLeads);

export default router;
