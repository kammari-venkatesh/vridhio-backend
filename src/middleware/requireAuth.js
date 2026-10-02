import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { AdminUser } from '../models/adminUser.model.js';
import { verifyAdminToken } from '../utils/adminToken.js';
import { ApiError } from '../utils/ApiError.js';

const decodeToken = (token) => {
  try {
    return verifyAdminToken(token);
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) throw new ApiError(401, 'Session expired');
    throw new ApiError(401, 'Invalid session');
  }
};

/**
 * Authenticates the admin from the httpOnly session cookie and loads them from the
 * database, so role and account state always come from the server, never the client.
 */
export const requireAuth = async (req, _res, next) => {
  const token = req.cookies?.[env.adminCookieName];
  if (!token) throw new ApiError(401, 'Authentication required');

  const payload = decodeToken(token);
  if (!mongoose.isValidObjectId(payload.sub)) throw new ApiError(401, 'Invalid session');

  const admin = await AdminUser.findById(payload.sub).select('+sessionVersion');
  if (!admin || admin.disabled || admin.sessionVersion !== payload.ver) throw new ApiError(401, 'Invalid session');

  req.admin = admin;
  next();
};
