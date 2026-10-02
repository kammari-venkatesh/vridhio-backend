import express, { Router } from 'express';
import { leadWorkspaceConfig } from '../../config/leadWorkspace.js';
import { getMeta, importLeads, importPreview } from '../../controllers/admin/leadWorkspace.controller.js';
import { importRateLimiter } from '../../middleware/rateLimiters.js';

// Mounted at /api/admin/lead-workspace behind requireAuth + requireAdmin. The app-level
// 100kb JSON parser skips /import, so large bodies are only parsed for signed-in admins.
const router = Router();

// UTF-8 can use up to 4 bytes per character, but pasted spreadsheet data is mostly ASCII.
const importBodyLimit = Math.ceil((leadWorkspaceConfig.import.maxContentLength * 1.5) / 1024) + 64;
const importJson = express.json({ limit: `${importBodyLimit}kb` });

router.get('/meta', getMeta);
router.post('/import/preview', importRateLimiter, importJson, importPreview);
router.post('/import', importRateLimiter, importJson, importLeads);

export default router;
