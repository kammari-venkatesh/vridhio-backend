import { AdminUser } from '../../models/adminUser.model.js';
import { ApiError } from '../../utils/ApiError.js';
import { clearAdminCookie, setAdminCookie, signAdminToken, verifyAdminToken } from '../../utils/adminToken.js';
import { DUMMY_PASSWORD_HASH, verifyPassword } from '../../utils/password.js';
import { validateLogin } from '../../validators/adminAuth.validator.js';
import { env } from '../../config/env.js';

const INVALID_LOGIN_MESSAGE = 'Invalid email or password';

export const login = async (req, res) => {
  const { credentials, errors, isValid } = validateLogin(req.body);
  if (!isValid) throw new ApiError(400, 'Validation failed', errors);

  const admin = await AdminUser.findOne({ email: credentials.email }).select('+passwordHash +sessionVersion');
  const passwordMatches = await verifyPassword(
    credentials.password,
    admin?.passwordHash ?? DUMMY_PASSWORD_HASH,
  );
  // Deactivated accounts get the same message, so a login attempt can't tell them apart.
  if (!admin || !passwordMatches || admin.disabled) throw new ApiError(401, INVALID_LOGIN_MESSAGE);

  admin.lastLoginAt = new Date();
  await AdminUser.updateOne({ _id: admin._id }, { $set: { lastLoginAt: admin.lastLoginAt } });
  setAdminCookie(res, signAdminToken(admin, admin.sessionVersion));
  res.json({ success: true, data: { admin: admin.toJSON() } });
};

export const logout = async (req, res) => {
  const token = req.cookies?.[env.adminCookieName];
  if (token) {
    try {
      const { sub, ver } = verifyAdminToken(token);
      await AdminUser.updateOne({ _id: sub, sessionVersion: ver }, { $inc: { sessionVersion: 1 } });
    } catch {
      // Expired or invalid tokens need no server-side revocation; the cookie is cleared below.
    }
  }

  clearAdminCookie(res);
  res.json({ success: true, message: 'Logged out' });
};

export const me = (req, res) => {
  res.json({ success: true, data: { admin: req.admin.toJSON() } });
};
