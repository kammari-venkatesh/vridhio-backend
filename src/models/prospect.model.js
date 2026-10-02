import mongoose from 'mongoose';

// Businesses discovered by the Lead Finder. Deliberately separate from inbound
// contact-form leads; turning a prospect into a sales lead must be an explicit step.
export const PROSPECT_STATUSES = ['new'];

const optionalString = { type: String, default: null, trim: true };

const prospectSchema = new mongoose.Schema(
  {
    businessName: { type: String, required: true, trim: true },
    category: optionalString,
    categories: { type: [String], default: [] },
    address: optionalString,
    city: optionalString,
    state: optionalString,
    country: optionalString,
    phone: optionalString,
    website: optionalString,
    googleMapsUrl: optionalString,
    latitude: { type: Number, default: null, min: -90, max: 90 },
    longitude: { type: Number, default: null, min: -180, max: 180 },

    source: { type: String, required: true },
    sourceId: { type: String, required: true },

    // Job that first discovered the business; jobIds lists every job that found it.
    jobId: { type: mongoose.Schema.Types.ObjectId, ref: 'LeadFinderJob', required: true },
    jobIds: { type: [mongoose.Schema.Types.ObjectId], ref: 'LeadFinderJob', default: [] },

    status: { type: String, required: true, enum: PROSPECT_STATUSES, default: 'new' },
    lastSeenAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// One document per business per data source, however many searches find it.
prospectSchema.index({ source: 1, sourceId: 1 }, { unique: true });
// Prospect listing for a job, alphabetical.
prospectSchema.index({ jobIds: 1, businessName: 1 });

export const Prospect = mongoose.model('Prospect', prospectSchema);
