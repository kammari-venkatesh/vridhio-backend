import { ApiError } from '../utils/ApiError.js';

/** Must run after requireAuth; checks the role loaded from the database. */
export const requireRole =
  (...allowedRoles) =>
  (req, _res, next) => {
    if (!req.admin) return next(new ApiError(401, 'Authentication required'));
    if (!allowedRoles.includes(req.admin.role)) {
      return next(new ApiError(403, 'You do not have permission to access this resource'));
    }
    next();
  };

export const requireAdmin = requireRole('admin');
