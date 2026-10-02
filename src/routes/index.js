import { Router } from 'express';
import leadRoutes from './lead.routes.js';

const router = Router();

router.get('/health', (_req, res) => {
  res.json({ success: true, status: 'ok', uptime: process.uptime() });
});

router.use('/leads', leadRoutes);

export default router;
