import { Router } from 'express';
import { getDashboard } from '../../controllers/admin/dashboard.controller.js';
import { noStore } from '../../middleware/noStore.js';
import { requireAuth } from '../../middleware/requireAuth.js';
import { requireAdmin } from '../../middleware/requireRole.js';
import adminUsersRoutes from './adminUsers.routes.js';
import authRoutes from './auth.routes.js';
import leadFinderRoutes from './leadFinder.routes.js';
import leadWorkspaceRoutes from './leadWorkspace.routes.js';
import prospectRoutes from './prospect.routes.js';
import salesLeadRoutes from './salesLead.routes.js';

const router = Router();

router.use(noStore);
router.use('/auth', authRoutes);

// Everything registered below this line requires an authenticated admin.
router.use(requireAuth, requireAdmin);

router.get('/dashboard', getDashboard);
router.use('/lead-finder', leadFinderRoutes);
router.use('/lead-workspace', leadWorkspaceRoutes);
router.use('/leads', salesLeadRoutes);
router.use('/prospects', prospectRoutes);
router.use('/admins', adminUsersRoutes);

export default router;
