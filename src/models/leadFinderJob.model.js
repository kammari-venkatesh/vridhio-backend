import mongoose from 'mongoose';

export const JOB_STATUSES = ['queued', 'running', 'completed', 'failed', 'cancelled'];
export const ACTIVE_JOB_STATUSES = ['queued', 'running'];

const countField = { type: Number, required: true, default: 0, min: 0 };

const leadFinderJobSchema = new mongoose.Schema(
  {
    status: { type: String, required: true, enum: JOB_STATUSES, default: 'queued' },
    provider: { type: String, required: true },
    params: {
      location: { type: String, required: true, trim: true },
      radius: { type: Number, required: true, min: 0 }, // kilometres
      categories: {
        type: [String],
        required: true,
        validate: { validator: (v) => v.length > 0, message: 'At least one category is required' },
      },
      maxBusinesses: { type: Number, required: true, min: 1 },
    },
    progress: {
      total: countField, // raw records returned by the provider
      invalid: countField, // raw records rejected as malformed (no name, no stable ID, wrong shape)
      closed: countField, // unique businesses excluded as permanently closed
      outsideRadius: countField, // unique businesses farther than the radius from the search centre
      missingCoordinates: countField, // unique businesses excluded because their location is unknown
      discovered: countField, // unique businesses kept after the closed and radius filters
      processed: countField, // businesses saved as prospects so far
      newProspects: countField, // of those, businesses not seen in any earlier job
      qualified: countField, // filled in by AI qualification in a later phase
    },
    // Resolved centre of the search; set when the provider supports radius filtering.
    searchArea: {
      latitude: { type: Number, default: null, min: -90, max: 90 },
      longitude: { type: Number, default: null, min: -180, max: 180 },
      label: { type: String, default: null },
      source: { type: String, enum: ['coordinates', 'geocoded', null], default: null },
    },
    radiusEnforced: { type: Boolean, default: false },
    // Paid providers only: the most one run may cost (provider spending cap), in micro-USD.
    costCapMicroUsd: { type: Number, default: null, min: 0 },
    // Provider-reported cost of the run in micro-USD (1 USD = 1,000,000); null when unavailable.
    // Provisional until settledAt is set: charges can still be added just after a run ends.
    usage: {
      totalMicroUsd: { type: Number, default: null, min: 0 },
      retrievedAt: { type: Date, default: null },
      settledAt: { type: Date, default: null },
      settleAttempts: { type: Number, default: 0, min: 0 },
    },
    error: { type: String, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'AdminUser', required: true },
    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
    // Worker lease (internal, never returned by the API).
    lockedBy: { type: String, default: null },
    heartbeatAt: { type: Date, default: null },
    // Remote run identifiers for support and cost tracing (internal, never returned by the API).
    providerRun: {
      runId: { type: String, default: null },
      datasetId: { type: String, default: null },
    },
  },
  { timestamps: true },
);

// Worker claim (oldest queued first), stale-job recovery and active-job counting.
leadFinderJobSchema.index({ status: 1, createdAt: 1 });
// Job history, newest first.
leadFinderJobSchema.index({ createdAt: -1 });

export const LeadFinderJob = mongoose.model('LeadFinderJob', leadFinderJobSchema);
