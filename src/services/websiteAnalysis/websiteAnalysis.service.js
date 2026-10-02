import mongoose from 'mongoose';
import { websiteAnalysisConfig } from '../../config/websiteAnalysis.js';
import { Prospect } from '../../models/prospect.model.js';
import {
  ACTIVE_ANALYSIS_STATUSES,
  ProspectWebsiteAnalysis,
} from '../../models/prospectWebsiteAnalysis.model.js';
import { SalesLead } from '../../models/salesLead.model.js';
import { ApiError } from '../../utils/ApiError.js';
import { ANALYSIS_ERROR_CODES as C, safeErrorMessage } from './analysisErrors.js';
import { buildFailureEvidence } from './evidenceBuilder.js';
import { normalizeWebsiteUrl } from './urlValidator.js';

const DUPLICATE_KEY = 11000;
const isObjectId = (id) => typeof id === 'string' && /^[a-f0-9]{24}$/i.test(id) && mongoose.isValidObjectId(id);

const prospectKey = (id) => `prospect:${id}`;
const leadKey = (id) => `lead:${id}`;

const comparableUrl = (raw) => {
  const { url } = normalizeWebsiteUrl(raw);
  return url ? url.replace(/\/$/, '').toLowerCase() : null;
};

const prospectWebsiteSource = (prospect) => (prospect.source === 'apify' ? 'APIFY' : 'TEST_PROVIDER');
const leadWebsiteSource = (lead) => (lead.source === 'MANUAL' ? 'MANUAL' : 'SALES_LEAD');

/**
 * What to analyse for a business. A discovered business is analysed once, shared by the
 * prospect and the sales lead made from it. The sales lead's website wins when an admin
 * has changed it (the lead is the human-maintained record); otherwise the discovered one.
 */
const targetForProspect = (prospect, lead) => {
  const leadSite = lead?.website?.trim() || null;
  const useLead = leadSite && comparableUrl(leadSite) !== comparableUrl(prospect.website);
  return {
    subjectKey: prospectKey(prospect._id.toString()),
    prospectId: prospect._id,
    salesLeadId: lead?._id ?? null,
    websiteUrl: useLead ? leadSite : (prospect.website?.trim() || leadSite || null),
    websiteSource: useLead ? leadWebsiteSource(lead) : prospect.website ? prospectWebsiteSource(prospect) : lead ? leadWebsiteSource(lead) : null,
  };
};

export const resolveProspectTarget = async (prospectId) => {
  const prospect = isObjectId(prospectId) ? await Prospect.findById(prospectId) : null;
  if (!prospect) throw new ApiError(404, 'Prospect not found');
  const lead = await SalesLead.findOne({ prospectId: prospect._id }).select('website source');
  return targetForProspect(prospect, lead);
};

export const resolveLeadTarget = async (leadId) => {
  const lead = isObjectId(leadId) ? await SalesLead.findById(leadId).select('website source prospectId') : null;
  if (!lead) throw new ApiError(404, 'Lead not found');
  if (lead.prospectId) {
    const prospect = await Prospect.findById(lead.prospectId);
    if (prospect) return targetForProspect(prospect, lead);
  }
  return {
    subjectKey: leadKey(lead._id.toString()),
    prospectId: null,
    salesLeadId: lead._id,
    websiteUrl: lead.website?.trim() || null,
    websiteSource: lead.website ? leadWebsiteSource(lead) : null,
  };
};

const mapObject = (value) => (value instanceof Map ? Object.fromEntries(value) : { ...(value ?? {}) });
const plain = (value) => (value?.toObject ? value.toObject() : value);

const isFresh = (doc, now = Date.now()) =>
  doc.status === 'COMPLETED' && doc.analyzedAt && now - doc.analyzedAt.getTime() < websiteAnalysisConfig.policy.freshForMs;

/** Public shape of an analysis; worker lease fields and the requesting admin stay server-side. */
export const toAnalysisDto = (doc, target = null) => {
  const sd = doc.structuredData ?? {};
  const websiteChanged = Boolean(
    target && doc.website?.websiteUrl !== undefined && comparableUrl(target.websiteUrl) !== comparableUrl(doc.website?.websiteUrl),
  );
  return {
    id: doc._id.toString(),
    jobId: doc._id.toString(),
    prospectId: doc.prospectId ? doc.prospectId.toString() : null,
    salesLeadId: doc.salesLeadId ? doc.salesLeadId.toString() : null,
    status: doc.status,
    queuedAt: doc.queuedAt,
    startedAt: doc.startedAt,
    completedAt: doc.completedAt,
    analyzedAt: doc.analyzedAt,
    lastAttemptAt: doc.lastAttemptAt,
    attemptCount: doc.attemptCount ?? 0,
    errorCode: doc.errorCode,
    errorMessage: doc.errorMessage,
    fresh: Boolean(isFresh(doc)),
    websiteChanged,
    website: plain(doc.website),
    availability: plain(doc.availability),
    page: plain(doc.page),
    content: plain(doc.content),
    robots: plain(doc.robots),
    sitemap: plain(doc.sitemap),
    structuredData: {
      hasJsonLd: sd.hasJsonLd ?? null,
      jsonLdBlockCount: sd.jsonLdBlockCount ?? 0,
      jsonLdInvalidBlockCount: sd.jsonLdInvalidBlockCount ?? 0,
      jsonLdTypes: [...(sd.jsonLdTypes ?? [])],
      openGraph: { present: sd.openGraph?.present ?? null, tags: mapObject(sd.openGraph?.tags) },
      twitterCard: { present: sd.twitterCard?.present ?? null, card: sd.twitterCard?.card ?? null, tags: mapObject(sd.twitterCard?.tags) },
    },
    mobile: plain(doc.mobile),
    technologies: (doc.technologies ?? []).map(plain),
    socialLinks: (doc.socialLinks ?? []).map(plain),
    evidence: (doc.evidence ?? []).map(plain),
    durationMs: doc.durationMs,
    analyzerVersion: doc.analyzerVersion,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
};

const notAnalyzedDto = (target) => ({
  id: null,
  jobId: null,
  prospectId: target.prospectId ? target.prospectId.toString() : null,
  salesLeadId: target.salesLeadId ? target.salesLeadId.toString() : null,
  status: 'NOT_ANALYZED',
  website: {
    websiteUrl: target.websiteUrl,
    normalizedWebsiteUrl: null,
    hasWebsite: Boolean(target.websiteUrl),
    websiteSource: target.websiteSource,
  },
});

/** Every fact path reset to its empty value; used when a new result replaces an old one. */
export const EMPTY_FACTS = Object.freeze({
  availability: { reachable: false, httpStatus: null, finalUrl: null, redirectCount: 0, redirectChain: [], responseTimeMs: null, contentType: null, https: null, bytes: null, attempts: 0 },
  page: { title: null, titleLength: 0, metaDescription: null, metaDescriptionLength: 0, canonicalUrl: null, lang: null, charset: null, viewport: null, metaRobots: null },
  content: { hasH1: null, h1Count: 0, h1Text: [], headingCount: 0, headingCounts: { h1: 0, h2: 0, h3: 0, h4: 0, h5: 0, h6: 0 }, imageCount: 0, imagesWithoutAltCount: 0, imagesWithEmptyAltCount: 0, internalLinkCount: 0, externalLinkCount: 0, telLinkCount: 0, mailtoLinkCount: 0 },
  robots: { robotsTxtUrl: null, robotsTxtExists: null, robotsTxtStatus: null, robotsTxtAccessible: null, robotsTxtSitemaps: [], robotsDisallowsAll: null, robotsErrorCode: null },
  sitemap: { sitemapExists: null, sitemapUrl: null, sitemapStatus: null, sitemapSource: null, sitemapKind: null, checkedUrls: [] },
  structuredData: { hasJsonLd: null, jsonLdBlockCount: 0, jsonLdInvalidBlockCount: 0, jsonLdTypes: [], openGraph: { present: null, tags: {} }, twitterCard: { present: null, card: null, tags: {} } },
  mobile: { hasViewport: null, viewportStatus: 'unknown', viewportContent: null, mobileSignals: [] },
  technologies: [],
  socialLinks: [],
  evidence: [],
});

/** $set document that stores an analyzer result, replacing every earlier fact. */
export const resultToUpdate = (result, { websiteSource }) => {
  const now = new Date();
  const set = {
    status: result.status,
    errorCode: result.errorCode ?? null,
    errorMessage: result.errorMessage ?? null,
    completedAt: now,
    analyzedAt: now,
    durationMs: result.durationMs ?? null,
    analyzerVersion: websiteAnalysisConfig.analyzerVersion,
    'website.websiteUrl': result.website.websiteUrl,
    'website.normalizedWebsiteUrl': result.website.normalizedWebsiteUrl,
    'website.hasWebsite': result.website.hasWebsite,
    'website.websiteSource': websiteSource ?? null,
    lockedBy: null,
    heartbeatAt: null,
  };
  for (const [key, empty] of Object.entries(EMPTY_FACTS)) set[key] = result[key] ?? empty;
  return set;
};

/** Stores a result that needs no network request (no website, invalid or unsafe address). */
const storeImmediateResult = async (target, result, adminId) => {
  const now = new Date();
  const update = () => ProspectWebsiteAnalysis.findOneAndUpdate(
    { subjectKey: target.subjectKey, status: { $nin: ACTIVE_ANALYSIS_STATUSES } },
    {
      $set: {
        ...resultToUpdate(result, target),
        prospectId: target.prospectId,
        salesLeadId: target.salesLeadId,
        requestedBy: adminId ?? null,
        queuedAt: now,
        startedAt: now,
        lastAttemptAt: now,
      },
      $inc: { attemptCount: 1 },
    },
    { upsert: true, returnDocument: 'after' },
  );
  try {
    return await update();
  } catch (err) {
    if (err?.code !== DUPLICATE_KEY) throw err;
    return ProspectWebsiteAnalysis.findOne({ subjectKey: target.subjectKey });
  }
};

const immediateResult = (target) => {
  const normalized = normalizeWebsiteUrl(target.websiteUrl);
  if (!normalized.error) return null;
  const hasWebsite = normalized.error !== C.NO_WEBSITE;
  return {
    status: hasWebsite ? 'FAILED' : 'SKIPPED',
    errorCode: normalized.error,
    errorMessage: safeErrorMessage(normalized.error),
    website: { websiteUrl: target.websiteUrl, normalizedWebsiteUrl: null, hasWebsite },
    evidence: buildFailureEvidence({ errorCode: normalized.error }),
    durationMs: 0,
  };
};

const minutes = (ms) => Math.max(1, Math.ceil(ms / 60_000));

/**
 * Queues an analysis unless an equivalent one exists:
 *  - QUEUED/ANALYZING: the running one is returned (never a second job);
 *  - COMPLETED within the freshness window, or FAILED/SKIPPED within the failure
 *    cooldown, for the same website: the stored result is returned;
 *  - refresh=true re-queues, but never within `refreshCooldownMs` of the last attempt.
 * Returns { analysis, outcome: 'queued' | 'reused' | 'in_progress' | 'completed' }.
 */
export const requestAnalysis = async (target, { refresh = false, adminId = null } = {}) => {
  const { policy } = websiteAnalysisConfig;
  const now = Date.now();
  const existing = await ProspectWebsiteAnalysis.findOne({ subjectKey: target.subjectKey });
  const sameWebsite = existing && comparableUrl(existing.website?.websiteUrl) === comparableUrl(target.websiteUrl);

  if (existing && ACTIVE_ANALYSIS_STATUSES.includes(existing.status)) {
    return { analysis: toAnalysisDto(existing, target), outcome: 'in_progress' };
  }
  if (existing && sameWebsite) {
    const sinceAttempt = existing.lastAttemptAt ? now - existing.lastAttemptAt.getTime() : Infinity;
    if (refresh && sinceAttempt < policy.refreshCooldownMs) {
      throw new ApiError(
        429,
        `This website was checked less than ${minutes(policy.refreshCooldownMs)} minutes ago. Try again in ${minutes(policy.refreshCooldownMs - sinceAttempt)} minute(s).`,
      );
    }
    if (!refresh && isFresh(existing, now)) return { analysis: toAnalysisDto(existing, target), outcome: 'reused' };
    if (!refresh && ['FAILED', 'SKIPPED'].includes(existing.status) && sinceAttempt < policy.failedCooldownMs) {
      return { analysis: toAnalysisDto(existing, target), outcome: 'reused' };
    }
  }

  const immediate = immediateResult(target);
  if (immediate) {
    const doc = await storeImmediateResult(target, immediate, adminId);
    return { analysis: toAnalysisDto(doc, target), outcome: 'completed' };
  }

  const queued = await ProspectWebsiteAnalysis.countDocuments({ status: 'QUEUED' });
  if (queued >= policy.maxQueued) {
    throw new ApiError(429, `The website analysis queue is full (${policy.maxQueued} waiting). Try again in a few minutes.`);
  }

  try {
    const doc = await ProspectWebsiteAnalysis.findOneAndUpdate(
      { subjectKey: target.subjectKey, status: { $nin: ACTIVE_ANALYSIS_STATUSES } },
      {
        $set: {
          status: 'QUEUED',
          queuedAt: new Date(),
          startedAt: null,
          prospectId: target.prospectId,
          salesLeadId: target.salesLeadId,
          requestedBy: adminId ?? null,
          'website.websiteUrl': target.websiteUrl,
          'website.hasWebsite': true,
          'website.websiteSource': target.websiteSource,
          lockedBy: null,
          heartbeatAt: null,
        },
      },
      { upsert: true, returnDocument: 'after' },
    );
    return { analysis: toAnalysisDto(doc, target), outcome: 'queued' };
  } catch (err) {
    // Two requests for the same business at once: the unique subjectKey lets one win.
    if (err?.code !== DUPLICATE_KEY) throw err;
    const doc = await ProspectWebsiteAnalysis.findOne({ subjectKey: target.subjectKey });
    return { analysis: toAnalysisDto(doc, target), outcome: 'in_progress' };
  }
};

export const getAnalysisFor = async (target) => {
  const doc = await ProspectWebsiteAnalysis.findOne({ subjectKey: target.subjectKey });
  return doc ? toAnalysisDto(doc, target) : notAnalyzedDto(target);
};

const findAnalysisOrThrow = async (analysisId) => {
  const doc = isObjectId(analysisId) ? await ProspectWebsiteAnalysis.findById(analysisId) : null;
  if (!doc) throw new ApiError(404, 'Website analysis not found');
  return doc;
};

/** Job-style view of one analysis (the analysis document is its own job). */
export const getAnalysisJob = async (analysisId) => {
  const doc = await findAnalysisOrThrow(analysisId);
  const jobStatus = { QUEUED: 'QUEUED', ANALYZING: 'RUNNING', COMPLETED: 'COMPLETED', SKIPPED: 'COMPLETED', FAILED: 'FAILED', CANCELLED: 'CANCELLED' };
  return {
    jobId: doc._id.toString(),
    status: jobStatus[doc.status] ?? doc.status,
    analysisStatus: doc.status,
    prospectId: doc.prospectId ? doc.prospectId.toString() : null,
    salesLeadId: doc.salesLeadId ? doc.salesLeadId.toString() : null,
    queuedAt: doc.queuedAt,
    startedAt: doc.startedAt,
    completedAt: doc.completedAt,
    errorCode: doc.errorCode,
    errorMessage: doc.errorMessage,
  };
};

/** Queued analyses are cancelled at once; a running one is discarded when it finishes. */
export const cancelAnalysis = async (analysisId) => {
  if (!isObjectId(analysisId)) throw new ApiError(404, 'Website analysis not found');
  const doc = await ProspectWebsiteAnalysis.findOneAndUpdate(
    { _id: analysisId, status: { $in: ACTIVE_ANALYSIS_STATUSES } },
    { $set: { status: 'CANCELLED', completedAt: new Date(), lockedBy: null } },
    { returnDocument: 'after' },
  );
  if (doc) return toAnalysisDto(doc);
  await findAnalysisOrThrow(analysisId);
  throw new ApiError(409, 'Only queued or running analyses can be cancelled');
};

/** Queues analyses for several leads at once; each lead gets its own outcome. */
export const requestBulkAnalysis = async (leadIds, adminId) => {
  const results = [];
  for (const leadId of leadIds) {
    try {
      const target = await resolveLeadTarget(leadId);
      const { analysis, outcome } = await requestAnalysis(target, { adminId });
      results.push({ leadId, outcome, status: analysis.status, analysisId: analysis.id });
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      results.push({ leadId, outcome: err.statusCode === 404 ? 'not_found' : 'rejected', status: null, analysisId: null, message: err.message });
      // A full queue rejects every remaining lead the same way; stop early.
      if (err.statusCode === 429 && /queue is full/.test(err.message)) break;
    }
  }
  const count = (outcome) => results.filter((r) => r.outcome === outcome).length;
  return {
    results,
    queued: count('queued'),
    reused: count('reused') + count('in_progress'),
    completed: count('completed'),
    rejected: count('rejected') + count('not_found'),
  };
};

const summaryOf = (doc, currentWebsite) =>
  doc
    ? {
        id: doc._id.toString(),
        status: doc.status,
        analyzedAt: doc.analyzedAt,
        errorCode: doc.errorCode,
        reachable: doc.availability?.reachable ?? null,
        httpStatus: doc.availability?.httpStatus ?? null,
        websiteChanged:
          currentWebsite !== undefined && doc.website?.websiteUrl !== undefined
            ? comparableUrl(currentWebsite) !== comparableUrl(doc.website.websiteUrl)
            : false,
      }
    : null;

/** Adds `websiteAnalysis` (a small status summary, or null) to sales lead DTOs. */
export const attachLeadAnalysisSummaries = async (leads) => {
  if (leads.length === 0) return leads;
  const keyOf = (lead) => (lead.prospectId ? prospectKey(lead.prospectId) : leadKey(lead.id));
  const docs = await ProspectWebsiteAnalysis.find({ subjectKey: { $in: leads.map(keyOf) } }).select(
    'subjectKey status analyzedAt errorCode availability.reachable availability.httpStatus website.websiteUrl',
  );
  const byKey = new Map(docs.map((d) => [d.subjectKey, d]));
  return leads.map((lead) => ({
    ...lead,
    websiteAnalysis: summaryOf(byKey.get(keyOf(lead)), lead.website ? lead.website : undefined),
  }));
};

/** Adds `websiteAnalysis` summaries to prospect DTOs. */
export const attachProspectAnalysisSummaries = async (prospects) => {
  if (prospects.length === 0) return prospects;
  const docs = await ProspectWebsiteAnalysis.find({ subjectKey: { $in: prospects.map((p) => prospectKey(p.id)) } }).select(
    'subjectKey status analyzedAt errorCode availability.reachable availability.httpStatus website.websiteUrl',
  );
  const byKey = new Map(docs.map((d) => [d.subjectKey, d]));
  return prospects.map((p) => ({ ...p, websiteAnalysis: summaryOf(byKey.get(prospectKey(p.id))) }));
};

/** Status summaries for a set of lead IDs (polling while analyses run). */
export const leadAnalysisStatuses = async (leadIds) => {
  const leads = await SalesLead.find({ _id: { $in: leadIds } }).select('prospectId website');
  const dtos = leads.map((l) => ({ id: l._id.toString(), prospectId: l.prospectId?.toString() ?? null, website: l.website }));
  const withSummaries = await attachLeadAnalysisSummaries(dtos);
  return Object.fromEntries(withSummaries.map((l) => [l.id, l.websiteAnalysis]));
};
