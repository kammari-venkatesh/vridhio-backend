import mongoose from 'mongoose';
import { CONFIDENCE } from '../services/websiteAnalysis/technologyDetector.js';
import { EVIDENCE_SEVERITIES, EVIDENCE_SOURCES, EVIDENCE_TYPES } from '../services/websiteAnalysis/evidenceBuilder.js';
import { SOCIAL_PLATFORMS } from '../services/websiteAnalysis/socialDetector.js';

/**
 * Website & digital presence evidence for one business (Phase 4). Kept apart from
 * Prospect and SalesLead so it can be refreshed independently and never overwrites the
 * discovered data: `website.websiteUrl` is the address as recorded, `availability.finalUrl`
 * is where it actually led.
 *
 * One document per business (`subjectKey`): "prospect:<id>" for discovered businesses
 * (shared with the sales lead created from them) or "lead:<id>" for manual/imported
 * leads with no prospect. The document doubles as the analysis job: QUEUED documents are
 * claimed atomically by the website analysis worker.
 *
 * NOT_ANALYZED is never stored; it is what the API reports when no document exists.
 */
export const ANALYSIS_STATUSES = ['NOT_ANALYZED', 'QUEUED', 'ANALYZING', 'COMPLETED', 'FAILED', 'SKIPPED', 'CANCELLED'];
export const ACTIVE_ANALYSIS_STATUSES = ['QUEUED', 'ANALYZING'];
export const WEBSITE_SOURCES = ['APIFY', 'TEST_PROVIDER', 'SALES_LEAD', 'MANUAL'];

const str = { type: String, default: null };
const num = { type: Number, default: null };
const bool = { type: Boolean, default: null };
const count = { type: Number, default: 0, min: 0 };

const analysisSchema = new mongoose.Schema(
  {
    subjectKey: { type: String, required: true },
    prospectId: { type: mongoose.Schema.Types.ObjectId, ref: 'Prospect', default: null },
    salesLeadId: { type: mongoose.Schema.Types.ObjectId, ref: 'SalesLead', default: null },

    status: { type: String, required: true, enum: ANALYSIS_STATUSES, default: 'QUEUED' },
    queuedAt: { type: Date, default: null },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    analyzedAt: { type: Date, default: null },
    lastAttemptAt: { type: Date, default: null },
    attemptCount: count,
    errorCode: str,
    errorMessage: str,
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'AdminUser', default: null },

    website: {
      websiteUrl: str,
      normalizedWebsiteUrl: str,
      hasWebsite: { type: Boolean, default: false },
      websiteSource: { type: String, enum: [...WEBSITE_SOURCES, null], default: null },
    },

    availability: {
      reachable: { type: Boolean, default: false },
      httpStatus: num,
      finalUrl: str,
      redirectCount: count,
      redirectChain: { type: [String], default: [] },
      responseTimeMs: num,
      contentType: str,
      https: bool,
      bytes: num,
      attempts: count,
    },

    page: {
      title: str,
      titleLength: count,
      metaDescription: str,
      metaDescriptionLength: count,
      canonicalUrl: str,
      lang: str,
      charset: str,
      viewport: str,
      metaRobots: str,
    },

    content: {
      hasH1: bool,
      h1Count: count,
      h1Text: { type: [String], default: [] },
      headingCount: count,
      headingCounts: { h1: count, h2: count, h3: count, h4: count, h5: count, h6: count },
      imageCount: count,
      imagesWithoutAltCount: count,
      imagesWithEmptyAltCount: count,
      internalLinkCount: count,
      externalLinkCount: count,
      telLinkCount: count,
      mailtoLinkCount: count,
    },

    robots: {
      robotsTxtUrl: str,
      robotsTxtExists: bool,
      robotsTxtStatus: num,
      robotsTxtAccessible: bool,
      robotsTxtSitemaps: { type: [String], default: [] },
      robotsDisallowsAll: bool,
      robotsErrorCode: str,
    },

    sitemap: {
      sitemapExists: bool,
      sitemapUrl: str,
      sitemapStatus: num,
      sitemapSource: { type: String, enum: ['ROBOTS', 'HTML_LINK', 'DEFAULT_PATH', null], default: null },
      sitemapKind: str,
      checkedUrls: {
        type: [{ _id: false, url: String, source: String, status: { type: Number, default: null }, outcome: String }],
        default: [],
      },
    },

    structuredData: {
      hasJsonLd: bool,
      jsonLdBlockCount: count,
      jsonLdInvalidBlockCount: count,
      jsonLdTypes: { type: [String], default: [] },
      openGraph: { present: bool, tags: { type: Map, of: String, default: () => new Map() } },
      twitterCard: { present: bool, card: str, tags: { type: Map, of: String, default: () => new Map() } },
    },

    mobile: {
      hasViewport: bool,
      viewportStatus: { type: String, enum: ['viewport_present', 'viewport_missing', 'unknown'], default: 'unknown' },
      viewportContent: str,
      mobileSignals: { type: [String], default: [] },
    },

    technologies: {
      type: [
        {
          _id: false,
          name: { type: String, required: true },
          category: str,
          confidence: { type: String, enum: Object.values(CONFIDENCE), required: true },
          evidence: { type: String, required: true },
        },
      ],
      default: [],
    },
    socialLinks: {
      type: [
        {
          _id: false,
          platform: { type: String, enum: SOCIAL_PLATFORMS, required: true },
          url: { type: String, required: true },
          source: { type: String, default: 'WEBSITE' },
        },
      ],
      default: [],
    },
    evidence: {
      type: [
        {
          _id: false,
          type: { type: String, enum: EVIDENCE_TYPES, required: true },
          severity: { type: String, enum: EVIDENCE_SEVERITIES, required: true },
          evidence: { type: String, required: true },
          source: { type: String, enum: EVIDENCE_SOURCES, required: true },
        },
      ],
      default: [],
    },

    durationMs: num,
    analyzerVersion: num,

    // Worker lease (internal, never returned by the API).
    lockedBy: str,
    heartbeatAt: { type: Date, default: null },
  },
  { timestamps: true },
);

analysisSchema.index({ subjectKey: 1 }, { unique: true });
// Worker claim (oldest queued first) and stale-run recovery.
analysisSchema.index({ status: 1, queuedAt: 1 });
analysisSchema.index({ prospectId: 1 }, { partialFilterExpression: { prospectId: { $type: 'objectId' } } });
analysisSchema.index({ salesLeadId: 1 }, { partialFilterExpression: { salesLeadId: { $type: 'objectId' } } });

export const ProspectWebsiteAnalysis = mongoose.model('ProspectWebsiteAnalysis', analysisSchema);
