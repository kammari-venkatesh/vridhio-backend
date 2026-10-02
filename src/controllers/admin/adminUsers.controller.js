import * as adminUsers from '../../services/adminUsers.service.js';
import { ApiError } from '../../utils/ApiError.js';
import { setAdminCookie, signAdminToken } from '../../utils/adminToken.js';
import { validateCreateAdmin, validatePasswordChange, validateStatusChange } from '../../validators/adminUser.validator.js';

const validated = ({ value, errors, isValid }) => {
  if (!isValid) throw new ApiError(400, 'Validation failed', errors);
  return value;
};

export const listAdmins = async (_req, res) => {
  res.json({ success: true, data: await adminUsers.listAdmins() });
};

export const createAdmin = async (req, res) => {
  const value = validated(validateCreateAdmin(req.body));
  res.status(201).json({ success: true, data: await adminUsers.createAdmin(value, req.admin) });
};

export const updateAdminStatus = async (req, res) => {
  const { disabled } = validated(validateStatusChange(req.body));
  res.json({ success: true, data: await adminUsers.setAdminDisabled(req.params.adminId, disabled, req.admin) });
};

export const changeAdminPassword = async (req, res) => {
  const value = validated(validatePasswordChange(req.body));
  const { admin, self, sessionVersion, updated } = await adminUsers.changeAdminPassword(req.params.adminId, value, req.admin);
  // Your other sessions end; this one continues with a fresh cookie.
  if (self) setAdminCookie(res, signAdminToken(updated, sessionVersion));
  res.json({ success: true, data: admin });
};

export const removeAdmin = async (req, res) => {
  res.json({ success: true, data: await adminUsers.removeAdmin(req.params.adminId, req.admin) });
};
