import mongoose from 'mongoose';

export const ADMIN_ROLES = ['admin'];

const adminUserSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    passwordHash: {
      type: String,
      required: true,
      select: false,
    },
    role: {
      type: String,
      required: true,
      enum: ADMIN_ROLES,
      default: 'admin',
    },
    // Incremented on logout so previously issued JWTs stop being accepted.
    sessionVersion: {
      type: Number,
      required: true,
      default: 0,
      select: false,
    },
    // Deactivated admins cannot sign in and their existing sessions are rejected.
    disabled: { type: Boolean, default: false },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'AdminUser', default: null },
    lastLoginAt: { type: Date, default: null },
    passwordChangedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    toJSON: {
      transform: (_doc, ret) => {
        ret.id = ret._id.toString();
        ret.disabled = ret.disabled === true;
        if (ret.createdBy && typeof ret.createdBy === 'object' && 'email' in ret.createdBy) {
          ret.createdBy = { id: ret.createdBy.id ?? ret.createdBy._id?.toString(), email: ret.createdBy.email };
        } else if (ret.createdBy) {
          ret.createdBy = { id: ret.createdBy.toString(), email: null };
        }
        delete ret._id;
        delete ret.__v;
        delete ret.passwordHash;
        delete ret.sessionVersion;
        return ret;
      },
    },
  },
);

export const AdminUser = mongoose.model('AdminUser', adminUserSchema);
