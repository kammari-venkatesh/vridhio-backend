import mongoose from 'mongoose';

/**
 * RESERVED: the run may still spend up to `reservedMicroUsd` (queued or in progress).
 * SETTLED: the provider reported token usage; `costMicroUsd` is final.
 * UNAVAILABLE: the provider was called but usage is unknown; the full reservation counts.
 * RELEASED: the provider was never called; nothing counts.
 */
export const AI_USAGE_STATUSES = Object.freeze(['RESERVED', 'SETTLED', 'UNAVAILABLE', 'RELEASED']);

/**
 * One AI provider attempt, kept as a ledger independent of the qualification record
 * (a refresh replaces the qualification, but spend history must stay for budgets).
 * Money is integer micro-USD.
 */
const aiUsageRecordSchema = new mongoose.Schema(
  {
    qualificationId: { type: mongoose.Schema.Types.ObjectId, ref: 'ProspectQualification', required: true },
    provider: { type: String, required: true },
    model: { type: String, default: null },
    status: { type: String, enum: AI_USAGE_STATUSES, required: true },
    reservedMicroUsd: { type: Number, default: 0 },
    costMicroUsd: { type: Number, default: null },
    inputTokens: { type: Number, default: null },
    outputTokens: { type: Number, default: null },
    totalTokens: { type: Number, default: null },
    providerCalledAt: { type: Date, default: null },
    settledAt: { type: Date, default: null },
  },
  { timestamps: true },
);

aiUsageRecordSchema.index({ createdAt: 1 });
aiUsageRecordSchema.index({ qualificationId: 1, createdAt: -1 });

export const AiUsageRecord = mongoose.model('AiUsageRecord', aiUsageRecordSchema);
