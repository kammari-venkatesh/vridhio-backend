import jwt from 'jsonwebtoken';
import { env, isProduction } from '../config/env.js';

const JWT_OPTIONS = { algorithm: 'HS256', issuer: 'vridhio-api', audience: 'vridhio-admin' };

export const signAdminToken = (admin, sessionVersion) =>
  jwt.sign({ sub: admin.id, ver: sessionVersion }, env.jwtSecret, {
    ...JWT_OPTIONS,
    expiresIn: env.adminSessionTtlSeconds,
  });

/** Throws jsonwebtoken errors (TokenExpiredError, JsonWebTokenError) on failure. */
export const verifyAdminToken = (token) =>
  jwt.verify(token, env.jwtSecret, {
    algorithms: [JWT_OPTIONS.algorithm],
    issuer: JWT_OPTIONS.issuer,
    audience: JWT_OPTIONS.audience,
  });

export const adminCookieOptions = () => ({
  httpOnly: true,
  secure: isProduction,
  sameSite: 'strict',
  path: '/api',
});

export const setAdminCookie = (res, token) => {
  res.cookie(env.adminCookieName, token, {
    ...adminCookieOptions(),
    maxAge: env.adminSessionTtlSeconds * 1000,
  });
};

export const clearAdminCookie = (res) => {
  res.clearCookie(env.adminCookieName, adminCookieOptions());
};
