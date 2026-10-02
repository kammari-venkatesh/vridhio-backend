import { Router } from 'express';
import {
  changeAdminPassword,
  createAdmin,
  listAdmins,
  removeAdmin,
  updateAdminStatus,
} from '../../controllers/admin/adminUsers.controller.js';
import { adminManagementRateLimiter } from '../../middleware/rateLimiters.js';

// Admin accounts for the admin panel. Mounted at /api/admin/admins behind requireAuth + requireAdmin.
const router = Router();

router.get('/', listAdmins);
router.post('/', adminManagementRateLimiter, createAdmin);
router.patch('/:adminId', adminManagementRateLimiter, updateAdminStatus);
router.post('/:adminId/password', adminManagementRateLimiter, changeAdminPassword);
router.delete('/:adminId', adminManagementRateLimiter, removeAdmin);

export default router;
