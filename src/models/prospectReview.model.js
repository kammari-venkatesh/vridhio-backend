import mongoose from 'mongoose';

export const REVIEW_DECISIONS = Object.freeze(['PENDING', 'APPROVED', 'REJECTED', 'NEEDS_REVIEW']);
export const SERVICE_DECISIONS = Object.freeze(['APPROVED', 'REJECTED']);
export const REVIEW_ACTIONS = Object.freeze(['CREATED', 'UPDATED', 'NEEDS_REVIEW', 'APPROVED', 'REJECTED', 'LEAD_UPDATED']);
// History is append-only; very old entries are trimmed so the document stays small.
export const MAX_REVIEW_HISTORY = 200;

const serviceDecisionSchema = new mongoose.Schema(
  {
    serviceId: { type: String, required: true },
    decision: { type: String, enum: SERVICE_DECISIONS, required: true },
  },
  { _id: false },
);

const historyEntrySchema = new mongoose.Schema(
  {
    at: { type: Date, required: true },
    action: { type: String, enum: REVIEW_ACTIONS, required: true },
    reviewerId: { type: mongoose.Schema.Types.ObjectId, ref: 'AdminUser', required: true },
    reviewerEmail: { type: String, default: null },
    previousDecision: { type: String, enum: [...REVIEW_DECISIONS, null], default: null },
    newDecision: { type: String, enum: REVIEW_DECISIONS, required: true },
    approvedServices: { type: [String], default: [] },
    rejectedServices: { type: [String], default: [] },
    addedLeadServices: { type: [String], default: [] },
    notes: { type: String, default: null },
  },
  { _id: false },
);

/**
 * A human decision about one business's AI qualification. It references the business
 * (same subject key as its website analysis and qualification) and the qualification
 * version it was made against; neither is copied. Writes are optimistic: every change
 * must name the `version` it was based on, and the matching history entry is pushed in
 * the same atomic update.
 */
const prospectReviewSchema = new mongoose.Schema(
  {
    subjectKey: { type: String, required: true, unique: true },
    prospectId: { type: mongoose.Schema.Types.ObjectId, ref: 'Prospect', default: null },
    salesLeadId: { type: mongoose.Schema.Types.ObjectId, ref: 'SalesLead', default: null },
    qualificationId: { type: mongoose.Schema.Types.ObjectId, ref: 'ProspectQualification', required: true },
    // The qualification run this review refers to; a later run makes the review outdated.
    qualificationCompletedAt: { type: Date, required: true },
    analysisId: { type: mongoose.Schema.Types.ObjectId, ref: 'ProspectWebsiteAnalysis', default: null },

    decision: { type: String, enum: REVIEW_DECISIONS, default: 'PENDING' },
    serviceDecisions: { type: [serviceDecisionSchema], default: [] },
    approvedServices: { type: [String], default: [] },
    rejectedServices: { type: [String], default: [] },
    reviewNotes: { type: String, default: null },
    reviewerEditedSummary: { type: String, default: null },
    reviewerEditedNextAction: { type: String, default: null },
    evidenceAcknowledged: { type: Boolean, default: false },

    reviewerId: { type: mongoose.Schema.Types.ObjectId, ref: 'AdminUser', required: true },
    reviewedAt: { type: Date, default: null },
    version: { type: Number, required: true, min: 1 },
    leadUpdate: {
      appliedAt: { type: Date, default: null },
      addedServices: { type: [String], default: [] },
    },
    history: { type: [historyEntrySchema], default: [] },
  },
  { timestamps: true },
);

prospectReviewSchema.index({ decision: 1, updatedAt: -1 });

export const ProspectReview = mongoose.model('ProspectReview', prospectReviewSchema);
