import { Router } from 'express';
import { login, logout, me } from '../../controllers/admin/auth.controller.js';
import { loginRateLimiter } from '../../middleware/rateLimiters.js';
import { requireAuth } from '../../middleware/requireAuth.js';
import { requireAdmin } from '../../middleware/requireRole.js';

const router = Router();

router.post('/login', loginRateLimiter, login);
router.post('/logout', logout);
router.get('/me', requireAuth, requireAdmin, me);

export default router;
