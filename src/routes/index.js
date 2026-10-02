import { Router } from 'express';
import adminRoutes from './admin/index.js';
import leadRoutes from './lead.routes.js';

const router = Router();

router.get('/health', (_req, res) => {
  res.json({ success: true, status: 'ok', uptime: process.uptime() });
});

router.use('/leads', leadRoutes);
router.use('/admin', adminRoutes);

export default router;
