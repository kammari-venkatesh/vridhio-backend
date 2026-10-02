import mongoose from 'mongoose';

// Stored lifecycle states. NOT_ANALYZED, STALE and ANALYSIS_REQUIRED are derived when
// the record is read (no record / the website analysis changed / no usable analysis).
export const QUALIFICATION_STATUSES = Object.freeze(['QUEUED', 'ANALYZING', 'COMPLETED', 'FAILED']);
export const ACTIVE_QUALIFICATION_STATUSES = Object.freeze(['QUEUED', 'ANALYZING']);
export const LEVELS = Object.freeze(['HIGH', 'MEDIUM', 'LOW']);
export const QUALIFICATION_PROVIDERS = Object.freeze(['fake', 'openai', 'nvidia']);

const evidenceItemSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    type: { type: String, required: true },
    severity: { type: String, default: null },
    evidence: { type: String, default: '' },
    source: { type: String, default: null },
  },
  { _id: false },
);

const opportunitySchema = new mongoose.Schema(
  {
    serviceId: { type: String, required: true },
    serviceName: { type: String, required: true },
    priority: { type: String, enum: LEVELS, required: true },
    confidence: { type: String, enum: LEVELS, required: true },
    reason: { type: String, required: true },
    evidenceReferences: { type: [String], default: [] },
  },
  { _id: false },
);

/**
 * AI qualification of one business, kept apart from the factual records it reads
 * (Prospect, SalesLead, ProspectWebsiteAnalysis are never written by Phase 5).
 * Shares the website analysis subject key, so a prospect and the lead made from it
 * have one qualification.
 */
const prospectQualificationSchema = new mongoose.Schema(
  {
    subjectKey: { type: String, required: true },
    prospectId: { type: mongoose.Schema.Types.ObjectId, ref: 'Prospect', default: null },
    salesLeadId: { type: mongoose.Schema.Types.ObjectId, ref: 'SalesLead', default: null },
    analysisId: { type: mongoose.Schema.Types.ObjectId, ref: 'ProspectWebsiteAnalysis', default: null },
    // analyzedAt of the website analysis this qualification read; a newer analysis makes it STALE.
    analysisAnalyzedAt: { type: Date, default: null },

    status: { type: String, enum: QUALIFICATION_STATUSES, required: true },
    requestedAt: { type: Date, default: null },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    failedAt: { type: Date, default: null },
    lastAttemptAt: { type: Date, default: null },
    attemptCount: { type: Number, default: 0 },
    errorCode: { type: String, default: null },
    errorMessage: { type: String, default: null },
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'AdminUser', default: null },

    provider: { type: String, enum: [...QUALIFICATION_PROVIDERS, null], default: null },
    model: { type: String, default: null },
    promptVersion: { type: String, default: null },

    // Evidence exactly as sent to the provider; references below point at these IDs.
    evidenceSnapshot: { type: [evidenceItemSchema], default: [] },
    candidateServiceIds: { type: [String], default: [] },

    summary: { type: String, default: null },
    confidence: { type: String, enum: [...LEVELS, null], default: null },
    opportunities: { type: [opportunitySchema], default: [] },
    evidenceReferences: { type: [String], default: [] },
    missingInformation: { type: [String], default: [] },
    recommendedNextAction: { type: String, default: null },
    validation: {
      droppedOpportunities: { type: Number, default: 0 },
      droppedReferences: { type: Number, default: 0 },
      notes: { type: [String], default: [] },
    },

    usage: {
      inputTokens: { type: Number, default: null },
      outputTokens: { type: Number, default: null },
      totalTokens: { type: Number, default: null },
      costMicroUsd: { type: Number, default: null },
      costStatus: { type: String, enum: ['SETTLED', 'UNAVAILABLE', 'NONE', null], default: null },
    },
    usageRecordId: { type: mongoose.Schema.Types.ObjectId, ref: 'AiUsageRecord', default: null },
    durationMs: { type: Number, default: null },

    // Internal worker lease; never returned by the API.
    lockedBy: { type: String, default: null },
    heartbeatAt: { type: Date, default: null },
  },
  { timestamps: true },
);

prospectQualificationSchema.index({ subjectKey: 1 }, { unique: true });
prospectQualificationSchema.index({ status: 1, requestedAt: 1 });
prospectQualificationSchema.index({ prospectId: 1 }, { partialFilterExpression: { prospectId: { $type: 'objectId' } } });
prospectQualificationSchema.index({ salesLeadId: 1 }, { partialFilterExpression: { salesLeadId: { $type: 'objectId' } } });

export const ProspectQualification = mongoose.model('ProspectQualification', prospectQualificationSchema);
