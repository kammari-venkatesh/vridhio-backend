import mongoose from 'mongoose';
import { SALES_LEAD_SOURCES, SALES_LEAD_STATUSES } from '../config/leadWorkspace.js';
import { computeDedupeKeys } from '../services/leadWorkspace/leadFields.js';

// A business in the internal sales workflow. Separate from inbound contact-form leads
// and from Lead Finder prospects; a sales lead may reference the prospect it came from.

const optionalString = { type: String, default: null, trim: true };

const salesLeadSchema = new mongoose.Schema(
  {
    businessName: { type: String, required: true, trim: true, maxlength: 200 },
    category: optionalString,

    contactName: optionalString,
    phone: optionalString,
    email: { ...optionalString, lowercase: true },

    website: optionalString,
    address: optionalString,
    city: optionalString,
    state: optionalString,
    country: optionalString,
    googleMapsUrl: optionalString,

    source: { type: String, required: true, enum: SALES_LEAD_SOURCES, default: 'MANUAL' },
    // Human-readable origin, e.g. "Spreadsheet paste" or "CSV file: gyms.csv".
    sourceDetail: optionalString,
    // Discovery provider and its stable ID for AI_DISCOVERY leads (internal).
    sourceProvider: optionalString,
    sourceId: optionalString,
    prospectId: { type: mongoose.Schema.Types.ObjectId, ref: 'Prospect', default: null },

    // Validated against SALES_SERVICES in the service layer so the list stays configurable.
    potentialServices: { type: [String], default: [] },
    status: { type: String, required: true, enum: SALES_LEAD_STATUSES, default: 'NEW' },
    tags: { type: [String], default: [] },
    notes: { type: String, default: '', maxlength: 5000 },
    // Unmapped spreadsheet columns live here instead of becoming schema fields.
    customFields: { type: Map, of: String, default: () => new Map() },

    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'AdminUser', default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'AdminUser', default: null },

    archived: { type: Boolean, default: false },
    archivedAt: { type: Date, default: null },

    // Normalised duplicate-detection keys, derived from the fields above (internal).
    dedupe: {
      website: { type: String, default: null },
      phone: { type: String, default: null },
      nameCity: { type: String, default: null },
    },
  },
  { timestamps: true },
);

salesLeadSchema.pre('validate', function setDedupeKeys() {
  this.dedupe = computeDedupeKeys(this);
});

const stringKey = (field) => ({ partialFilterExpression: { [field]: { $type: 'string' } } });

// A prospect becomes at most one sales lead, and a provider record at most one.
salesLeadSchema.index(
  { prospectId: 1 },
  { unique: true, partialFilterExpression: { prospectId: { $type: 'objectId' } } },
);
salesLeadSchema.index({ sourceProvider: 1, sourceId: 1 }, { unique: true, ...stringKey('sourceId') });

// Duplicate lookups.
salesLeadSchema.index({ 'dedupe.website': 1 }, stringKey('dedupe.website'));
salesLeadSchema.index({ 'dedupe.phone': 1 }, stringKey('dedupe.phone'));
salesLeadSchema.index({ 'dedupe.nameCity': 1 }, stringKey('dedupe.nameCity'));

// Workspace listing: archived is always filtered; default sort is newest first.
salesLeadSchema.index({ archived: 1, createdAt: -1 });
salesLeadSchema.index({ archived: 1, updatedAt: -1 });
salesLeadSchema.index({ archived: 1, status: 1, createdAt: -1 });
salesLeadSchema.index({ source: 1 });
salesLeadSchema.index({ city: 1 });
salesLeadSchema.index({ category: 1 });
salesLeadSchema.index({ tags: 1 });

export const SalesLead = mongoose.model('SalesLead', salesLeadSchema);
