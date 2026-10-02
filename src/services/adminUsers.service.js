import mongoose from 'mongoose';
import { AdminUser } from '../models/adminUser.model.js';
import { SalesLead } from '../models/salesLead.model.js';
import { ApiError } from '../utils/ApiError.js';
import { hashPassword, verifyPassword } from '../utils/password.js';

const DUPLICATE_KEY = 11000;
const ACTIVE = { disabled: { $ne: true } };

const findTarget = async (id, select = '') => {
  const admin = mongoose.isValidObjectId(id) ? await AdminUser.findById(id).select(select) : null;
  if (!admin) throw new ApiError(404, 'Admin not found');
  return admin;
};

const toDto = async (admin) => (await admin.populate('createdBy', 'email')).toJSON();

const isSelf = (actor, target) => actor._id.equals(target._id);

/** Refuses to leave the panel without any active admin. */
const assertAnotherActiveAdmin = async (target) => {
  const others = await AdminUser.countDocuments({ ...ACTIVE, _id: { $ne: target._id } });
  if (others === 0) throw new ApiError(409, 'At least one active admin must remain.', { code: 'LAST_ADMIN' });
};

export const listAdmins = async () => {
  const admins = await AdminUser.find().sort({ createdAt: 1 }).populate('createdBy', 'email');
  return admins.map((a) => a.toJSON());
};

export const createAdmin = async ({ email, password }, actor) => {
  if (await AdminUser.exists({ email })) {
    throw new ApiError(409, 'An admin with this email already exists.', { email: 'An admin with this email already exists.' });
  }
  try {
    const admin = await AdminUser.create({
      email,
      passwordHash: await hashPassword(password),
      role: 'admin',
      createdBy: actor._id,
      passwordChangedAt: new Date(),
    });
    return toDto(admin);
  } catch (err) {
    if (err?.code === DUPLICATE_KEY) {
      throw new ApiError(409, 'An admin with this email already exists.', { email: 'An admin with this email already exists.' });
    }
    throw err;
  }
};

/** Deactivating also ends every session of that admin; reactivating does not restore old sessions. */
export const setAdminDisabled = async (id, disabled, actor) => {
  const target = await findTarget(id);
  if (isSelf(actor, target)) throw new ApiError(400, "You can't deactivate your own account.");
  if (disabled) await assertAnotherActiveAdmin(target);
  const updated = await AdminUser.findByIdAndUpdate(
    target._id,
    { $set: { disabled }, ...(disabled ? { $inc: { sessionVersion: 1 } } : {}) },
    { returnDocument: 'after' },
  );
  // Two admins deactivating each other at once could both pass the check above.
  if (disabled && (await AdminUser.countDocuments(ACTIVE)) === 0) {
    await AdminUser.updateOne({ _id: target._id }, { $set: { disabled: false } });
    throw new ApiError(409, 'At least one active admin must remain.', { code: 'LAST_ADMIN' });
  }
  return toDto(updated);
};

/**
 * Sets a new password and signs that admin out everywhere. Changing your own password
 * needs your current one; the caller re-issues your session cookie afterwards.
 */
export const changeAdminPassword = async (id, { password, currentPassword }, actor) => {
  const target = await findTarget(id, '+passwordHash');
  const self = isSelf(actor, target);
  if (self) {
    if (typeof currentPassword !== 'string' || !(await verifyPassword(currentPassword, target.passwordHash))) {
      throw new ApiError(400, 'Validation failed', { currentPassword: 'Current password is incorrect.' });
    }
  }
  const updated = await AdminUser.findByIdAndUpdate(
    target._id,
    { $set: { passwordHash: await hashPassword(password), passwordChangedAt: new Date() }, $inc: { sessionVersion: 1 } },
    { returnDocument: 'after' },
  ).select('+sessionVersion');
  return { admin: await toDto(updated), self, sessionVersion: updated.sessionVersion, updated };
};

/** Only deactivated admins can be removed; leads assigned to them become unassigned. */
export const removeAdmin = async (id, actor) => {
  const target = await findTarget(id);
  if (isSelf(actor, target)) throw new ApiError(400, "You can't remove your own account.");
  if (!target.disabled) {
    throw new ApiError(409, 'Deactivate this admin before removing them.', { code: 'ACTIVE_ADMIN' });
  }
  await SalesLead.updateMany({ assignedTo: target._id }, { $set: { assignedTo: null } });
  await AdminUser.deleteOne({ _id: target._id, disabled: true });
  return { id: target._id.toString() };
};
