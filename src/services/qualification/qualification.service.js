import mongoose from 'mongoose';
import { qualificationConfig } from '../../config/qualification.js';
import { Prospect } from '../../models/prospect.model.js';
import { ACTIVE_QUALIFICATION_STATUSES, ProspectQualification } from '../../models/prospectQualification.model.js';
import { ProspectWebsiteAnalysis } from '../../models/prospectWebsiteAnalysis.model.js';
import { SalesLead } from '../../models/salesLead.model.js';
import { ApiError } from '../../utils/ApiError.js';
import { fromMicroUsd } from '../leadFinder/cost.service.js';
import { toAnalysisDto, resolveLeadTarget } from '../websiteAnalysis/websiteAnalysis.service.js';
import { normalizeWebsiteUrl } from '../websiteAnalysis/urlValidator.js';
import { checkAiBudget, getAiSpendSummary, releaseAiUsage, reserveAiUsage } from './aiBudget.service.js';
import { buildEvidencePayload } from './evidencePayload.js';
import { buildMessages, QUALIFICATION_PROMPT_VERSION } from './prompt.js';
import { getQualificationProvider, qualificationProviderStatus } from './providers/index.js';
import { QUALIFICATION_ERROR_CODES as C, safeQualificationMessage } from './qualificationErrors.js';

const DUPLICATE_KEY = 11000;
const prospectKey = (id) => `prospect:${id}`;
const leadKey = (id) => `lead:${id}`;

const comparableUrl = (raw) => {
  const { url } = normalizeWebsiteUrl(raw);
  return url ? url.replace(/\/$/, '').toLowerCase() : null;
};

// Analysis failures that say nothing about the website (the analyser itself stopped).
const NON_FACTUAL_ANALYSIS_ERRORS = ['INTERRUPTED', 'ANALYSIS_ERROR'];

/**
 * Whether a stored website analysis can be qualified: it finished (completed, skipped
 * for no website, or failed for a reason about the website itself) and it concerns
 * the website currently recorded for the business.
 */
export const isUsableAnalysis = (doc, target) => {
  if (!doc) return false;
  const finished =
    doc.status === 'COMPLETED' ||
    doc.status === 'SKIPPED' ||
    (doc.status === 'FAILED' && !NON_FACTUAL_ANALYSIS_ERRORS.includes(doc.errorCode));
  if (!finished) return false;
  return comparableUrl(doc.website?.websiteUrl) === comparableUrl(target.websiteUrl);
};

const sameTime = (a, b) => (a ? new Date(a).getTime() : null) === (b ? new Date(b).getTime() : null);

/** Why a completed qualification no longer matches the facts, or null when current. */
export const staleReason = (doc, analysisDoc, target) => {
  if (!isUsableAnalysis(analysisDoc, target)) return 'The website analysis is no longer valid for this business.';
  if (!sameTime(doc.analysisAnalyzedAt, analysisDoc.analyzedAt)) return 'The website was analysed again after this qualification.';
  if (doc.promptVersion !== QUALIFICATION_PROMPT_VERSION) return 'The qualification rules have changed since this qualification.';
  return null;
};

const isFresh = (doc, now = Date.now()) =>
  doc.status === 'COMPLETED' && doc.completedAt && now - doc.completedAt.getTime() < qualificationConfig.policy.freshForMs;

const aiState = () => {
  const { provider, mode, model } = qualificationProviderStatus();
  return { provider, mode, model };
};

const usageDto = (usage) =>
  usage?.costStatus
    ? {
        inputTokens: usage.inputTokens ?? null,
        outputTokens: usage.outputTokens ?? null,
        totalTokens: usage.totalTokens ?? null,
        // null means unknown, never free: see costStatus.
        costUsd: usage.costStatus === 'SETTLED' || usage.costStatus === 'NONE' ? fromMicroUsd(usage.costMicroUsd ?? 0) : null,
        costStatus: usage.costStatus,
      }
    : null;

const evidenceDto = (e) => ({ id: e.id, type: e.type, severity: e.severity, evidence: e.evidence, source: e.source });

/**
 * Public shape of a qualification. Worker lease fields, the requesting admin, the
 * usage-ledger link, prompts and provider responses never leave the server.
 */
export const toQualificationDto = (doc, { analysisDoc, target }) => {
  const stale = doc.status === 'COMPLETED' ? staleReason(doc, analysisDoc, target) : null;
  const completed = doc.status === 'COMPLETED';
  return {
    id: doc._id.toString(),
    prospectId: doc.prospectId ? doc.prospectId.toString() : null,
    salesLeadId: doc.salesLeadId ? doc.salesLeadId.toString() : null,
    analysisId: doc.analysisId ? doc.analysisId.toString() : null,
    status: stale ? 'STALE' : doc.status,
    staleReason: stale,
    fresh: Boolean(completed && !stale && isFresh(doc)),
    requestedAt: doc.requestedAt,
    startedAt: doc.startedAt,
    completedAt: doc.completedAt,
    failedAt: doc.failedAt,
    attemptCount: doc.attemptCount ?? 0,
    errorCode: doc.status === 'FAILED' ? doc.errorCode : null,
    errorMessage: doc.status === 'FAILED' ? doc.errorMessage : null,
    provider: doc.provider,
    model: doc.model,
    promptVersion: doc.promptVersion,
    isTestProvider: doc.provider === 'fake',
    summary: completed ? doc.summary : null,
    confidence: completed ? doc.confidence : null,
    opportunities: completed
      ? (doc.opportunities ?? []).map((o) => ({
          serviceId: o.serviceId,
          serviceName: o.serviceName,
          priority: o.priority,
          confidence: o.confidence,
          reason: o.reason,
          evidenceReferences: [...o.evidenceReferences],
        }))
      : [],
    evidenceReferences: completed ? [...(doc.evidenceReferences ?? [])] : [],
    evidence: completed ? (doc.evidenceSnapshot ?? []).map(evidenceDto) : [],
    missingInformation: completed ? [...(doc.missingInformation ?? [])] : [],
    recommendedNextAction: completed ? doc.recommendedNextAction : null,
    validation: completed
      ? {
          droppedOpportunities: doc.validation?.droppedOpportunities ?? 0,
          droppedReferences: doc.validation?.droppedReferences ?? 0,
          notes: [...(doc.validation?.notes ?? [])],
        }
      : null,
    usage: usageDto(doc.usage),
    durationMs: doc.durationMs ?? null,
    ai: aiState(),
  };
};

const placeholderDto = (target, status) => ({
  id: null,
  prospectId: target.prospectId ? target.prospectId.toString() : null,
  salesLeadId: target.salesLeadId ? target.salesLeadId.toString() : null,
  analysisId: null,
  status,
  errorCode: status === 'ANALYSIS_REQUIRED' ? C.ANALYSIS_REQUIRED : null,
  errorMessage: status === 'ANALYSIS_REQUIRED' ? safeQualificationMessage(C.ANALYSIS_REQUIRED) : null,
  opportunities: [],
  evidence: [],
  missingInformation: [],
  ai: aiState(),
});

const loadAnalysis = (target) => ProspectWebsiteAnalysis.findOne({ subjectKey: target.subjectKey });

/**
 * Business facts for the payload. The sales lead is the human-maintained record, so
 * its values win; discovered prospect values fill gaps. Contact details, notes and
 * other personal data are never read.
 */
export const loadBusinessFacts = async (target) => {
  const fields = 'businessName category city state country website';
  const [lead, prospect] = await Promise.all([
    target.salesLeadId ? SalesLead.findById(target.salesLeadId).select(fields).lean() : null,
    target.prospectId ? Prospect.findById(target.prospectId).select(fields).lean() : null,
  ]);
  const pick = (key) => lead?.[key] || prospect?.[key] || null;
  return {
    businessName: pick('businessName'),
    category: pick('category'),
    city: pick('city'),
    state: pick('state'),
    country: pick('country'),
    website: target.websiteUrl ?? null,
  };
};

/** Evidence payload and chat messages for a target with a usable analysis. */
export const prepareQualificationInput = async (target, analysisDoc) => {
  const business = await loadBusinessFacts(target);
  const built = buildEvidencePayload({ business, analysis: toAnalysisDto(analysisDoc) });
  return { ...built, messages: buildMessages(built.payload) };
};

const minutes = (ms) => Math.max(1, Math.ceil(ms / 60_000));

const assertAiAvailable = () => {
  const status = qualificationProviderStatus();
  if (status.mode === 'disabled') throw new ApiError(503, safeQualificationMessage(C.AI_DISABLED), { code: C.AI_DISABLED });
  if (status.mode === 'unconfigured') {
    throw new ApiError(503, safeQualificationMessage(C.AI_UNCONFIGURED), { code: C.AI_UNCONFIGURED });
  }
  return getQualificationProvider();
};

/**
 * Queues a qualification unless an equivalent one exists:
 *  - QUEUED/ANALYZING: the running one is returned;
 *  - COMPLETED, current and within QUALIFICATION_FRESH_DAYS, or FAILED within the
 *    failure cooldown for the same analysis: the stored result is returned;
 *  - refresh=true re-queues, never within `refreshCooldownMs` of the last attempt.
 * Never starts a website analysis: without a usable one it fails with 409
 * ANALYSIS_REQUIRED. The estimated cost is checked against and reserved in the AI
 * budget before anything is queued.
 */
export const requestQualification = async (target, { refresh = false, adminId = null } = {}) => {
  const { policy } = qualificationConfig;
  const provider = assertAiAvailable();
  const analysisDoc = await loadAnalysis(target);
  if (!isUsableAnalysis(analysisDoc, target)) {
    throw new ApiError(409, safeQualificationMessage(C.ANALYSIS_REQUIRED), { code: C.ANALYSIS_REQUIRED });
  }

  const now = Date.now();
  const existing = await ProspectQualification.findOne({ subjectKey: target.subjectKey });
  const dto = (doc) => toQualificationDto(doc, { analysisDoc, target });

  if (existing && ACTIVE_QUALIFICATION_STATUSES.includes(existing.status)) return { qualification: dto(existing), outcome: 'in_progress' };
  if (existing) {
    const sinceAttempt = existing.requestedAt ? now - existing.requestedAt.getTime() : Infinity;
    if (refresh && sinceAttempt < policy.refreshCooldownMs) {
      throw new ApiError(
        429,
        `This business was qualified less than ${minutes(policy.refreshCooldownMs)} minutes ago. Try again in ${minutes(policy.refreshCooldownMs - sinceAttempt)} minute(s).`,
      );
    }
    const current = !staleReason(existing, analysisDoc, target);
    if (!refresh && existing.status === 'COMPLETED' && current && isFresh(existing, now)) {
      return { qualification: dto(existing), outcome: 'reused' };
    }
    if (
      !refresh &&
      existing.status === 'FAILED' &&
      sameTime(existing.analysisAnalyzedAt, analysisDoc.analyzedAt) &&
      sinceAttempt < policy.failedCooldownMs
    ) {
      return { qualification: dto(existing), outcome: 'reused' };
    }
  }

  const queued = await ProspectQualification.countDocuments({ status: 'QUEUED' });
  if (queued >= policy.maxQueued) {
    throw new ApiError(429, `The AI qualification queue is full (${policy.maxQueued} waiting). Try again in a few minutes.`);
  }

  const { messages } = await prepareQualificationInput(target, analysisDoc);
  const estimateMicroUsd = provider.estimateMaxCostMicroUsd(messages);
  const overBudget = await checkAiBudget({ estimateMicroUsd });
  if (overBudget) throw new ApiError(429, overBudget, { code: C.BUDGET_EXCEEDED });

  const qualificationId = existing?._id ?? new mongoose.Types.ObjectId();
  const reservation = await reserveAiUsage({
    qualificationId,
    provider: provider.name,
    model: provider.model,
    reservedMicroUsd: estimateMicroUsd,
  });
  try {
    const doc = await ProspectQualification.findOneAndUpdate(
      { subjectKey: target.subjectKey, status: { $nin: ACTIVE_QUALIFICATION_STATUSES } },
      {
        $setOnInsert: { _id: qualificationId },
        $set: {
          status: 'QUEUED',
          requestedAt: new Date(),
          startedAt: null,
          failedAt: null,
          errorCode: null,
          errorMessage: null,
          requestedBy: adminId ?? null,
          prospectId: target.prospectId,
          salesLeadId: target.salesLeadId,
          analysisId: analysisDoc._id,
          usageRecordId: reservation._id,
          lockedBy: null,
          heartbeatAt: null,
        },
      },
      { upsert: true, returnDocument: 'after' },
    );
    return { qualification: dto(doc), outcome: 'queued' };
  } catch (err) {
    await releaseAiUsage(reservation._id);
    // Two requests for the same business at once: the unique subjectKey lets one win.
    if (err?.code !== DUPLICATE_KEY) throw err;
    const doc = await ProspectQualification.findOne({ subjectKey: target.subjectKey });
    return { qualification: dto(doc), outcome: 'in_progress' };
  }
};

/** Current qualification state, including the derived NOT_ANALYZED / ANALYSIS_REQUIRED / STALE. */
export const getQualificationFor = async (target) => {
  const [doc, analysisDoc] = await Promise.all([
    ProspectQualification.findOne({ subjectKey: target.subjectKey }),
    loadAnalysis(target),
  ]);
  if (doc) return toQualificationDto(doc, { analysisDoc, target });
  return placeholderDto(target, isUsableAnalysis(analysisDoc, target) ? 'NOT_ANALYZED' : 'ANALYSIS_REQUIRED');
};

// Bulk requests stop at the first error that would reject every remaining lead.
const STOPS_BULK = (err) => err.statusCode === 503 || err.details?.code === C.BUDGET_EXCEEDED || /queue is full/.test(err.message);

/** Queues qualifications for several leads; each lead gets its own outcome. */
export const requestBulkQualification = async (leadIds, adminId) => {
  const results = [];
  for (const leadId of leadIds) {
    try {
      const target = await resolveLeadTarget(leadId);
      const { qualification, outcome } = await requestQualification(target, { adminId });
      results.push({ leadId, outcome, status: qualification.status, qualificationId: qualification.id });
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      const outcome = err.statusCode === 404 ? 'not_found' : err.details?.code === C.ANALYSIS_REQUIRED ? 'analysis_required' : 'rejected';
      results.push({ leadId, outcome, status: null, qualificationId: null, message: err.message });
      if (STOPS_BULK(err)) break;
    }
  }
  const count = (outcome) => results.filter((r) => r.outcome === outcome).length;
  return {
    results,
    queued: count('queued'),
    reused: count('reused') + count('in_progress'),
    analysisRequired: count('analysis_required'),
    rejected: count('rejected') + count('not_found'),
    skipped: leadIds.length - results.length,
  };
};

const ANALYSIS_FIELDS = 'subjectKey status errorCode analyzedAt website.websiteUrl';
const QUALIFICATION_SUMMARY_FIELDS =
  'subjectKey status errorCode completedAt analysisAnalyzedAt promptVersion provider confidence opportunities.serviceId opportunities.priority';

/** Small qualification summary for list views, or null when never requested. */
const summaryOf = (doc, analysisDoc, target) => {
  if (!doc) return { status: isUsableAnalysis(analysisDoc, target) ? 'NOT_ANALYZED' : 'ANALYSIS_REQUIRED', serviceIds: [] };
  const stale = doc.status === 'COMPLETED' ? staleReason(doc, analysisDoc, target) : null;
  return {
    id: doc._id.toString(),
    status: stale ? 'STALE' : doc.status,
    errorCode: doc.status === 'FAILED' ? doc.errorCode : null,
    completedAt: doc.completedAt,
    confidence: doc.status === 'COMPLETED' ? doc.confidence : null,
    serviceIds: doc.status === 'COMPLETED' ? (doc.opportunities ?? []).map((o) => o.serviceId) : [],
    isTestProvider: doc.provider === 'fake',
  };
};

/** Adds `qualification` summaries to sales lead DTOs ({ id, prospectId, website }). */
export const attachLeadQualificationSummaries = async (leads) => {
  if (leads.length === 0) return leads;
  const keyOf = (lead) => (lead.prospectId ? prospectKey(lead.prospectId) : leadKey(lead.id));
  const keys = leads.map(keyOf);
  const [docs, analyses] = await Promise.all([
    ProspectQualification.find({ subjectKey: { $in: keys } }).select(QUALIFICATION_SUMMARY_FIELDS),
    ProspectWebsiteAnalysis.find({ subjectKey: { $in: keys } }).select(ANALYSIS_FIELDS),
  ]);
  const byKey = new Map(docs.map((d) => [d.subjectKey, d]));
  const analysisByKey = new Map(analyses.map((d) => [d.subjectKey, d]));
  return leads.map((lead) => {
    const key = keyOf(lead);
    // The lead's own website is what a qualification must match (see resolveLeadTarget).
    const target = { websiteUrl: lead.website ?? analysisByKey.get(key)?.website?.websiteUrl ?? null };
    return { ...lead, qualification: summaryOf(byKey.get(key), analysisByKey.get(key), target) };
  });
};

/** Qualification summaries for a set of lead IDs (polling while qualifications run). */
export const leadQualificationStatuses = async (leadIds) => {
  const leads = await SalesLead.find({ _id: { $in: leadIds } }).select('prospectId website');
  const dtos = leads.map((l) => ({ id: l._id.toString(), prospectId: l.prospectId?.toString() ?? null, website: l.website }));
  const withSummaries = await attachLeadQualificationSummaries(dtos);
  return Object.fromEntries(withSummaries.map((l) => [l.id, l.qualification]));
};

/** Provider mode and AI spend for the admin UI; never includes credentials. */
export const getAiStatus = async () => {
  const { provider, mode, model, problems } = qualificationProviderStatus();
  return {
    provider,
    mode,
    model,
    problems,
    promptVersion: QUALIFICATION_PROMPT_VERSION,
    freshDays: Math.round(qualificationConfig.policy.freshForMs / 86_400_000),
    spend: await getAiSpendSummary(),
  };
};
