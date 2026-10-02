import { rateLimit } from 'express-rate-limit';
import { ApiError } from '../utils/ApiError.js';

export const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: (_req, _res, next) => {
    next(new ApiError(429, 'Too many login attempts. Please try again later.'));
  },
});

// Runs after requireAuth; preview is called on every mapping change, so the limit is generous.
export const importRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 120,
  keyGenerator: (req) => `admin:${req.admin.id}`,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: (_req, _res, next) => {
    next(new ApiError(429, 'Too many import requests. Please wait a few minutes and try again.'));
  },
});

const perAdminLimiter = ({ windowMs, limit, message }) =>
  rateLimit({
    windowMs,
    limit,
    keyGenerator: (req) => `admin:${req.admin.id}`,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, _res, next) => next(new ApiError(429, message)),
  });

// Website analysis makes outbound requests to third-party sites, so each kind of request
// has its own per-admin budget (on top of per-website cooldowns in the service).
export const websiteAnalysisRateLimiter = perAdminLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  message: 'Too many website analysis requests. Please wait a few minutes and try again.',
});
export const websiteAnalysisRefreshRateLimiter = perAdminLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  message: 'Too many website analysis refreshes. Please wait a few minutes and try again.',
});
export const websiteAnalysisBulkRateLimiter = perAdminLimiter({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  message: 'Too many bulk website analysis requests. Please wait and try again later.',
});

// AI qualification can spend money, so it is limited per admin on top of the AI budgets.
export const qualificationRateLimiter = perAdminLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  message: 'Too many AI qualification requests. Please wait a few minutes and try again.',
});
export const qualificationRefreshRateLimiter = perAdminLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  message: 'Too many AI qualification refreshes. Please wait a few minutes and try again.',
});
export const qualificationBulkRateLimiter = perAdminLimiter({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  message: 'Too many bulk AI qualification requests. Please wait and try again later.',
});

// Creating admins, changing passwords and access; also bounds guesses of the current password.
export const adminManagementRateLimiter = perAdminLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  message: 'Too many admin access changes. Please wait a few minutes and try again.',
});

// Human review writes (save, approve, reject) are cheap, but still bounded per admin.
export const reviewRateLimiter = perAdminLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 200,
  message: 'Too many review changes. Please wait a few minutes and try again.',
});

// Runs after requireAuth, so the limit applies per admin account rather than per IP.
export const jobCreationRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  keyGenerator: (req) => `admin:${req.admin.id}`,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: (_req, _res, next) => {
    next(new ApiError(429, 'Too many searches started. Please wait a few minutes and try again.'));
  },
});
