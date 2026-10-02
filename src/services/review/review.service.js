import { leadWorkspaceConfig, SERVICE_CATALOG } from '../../config/leadWorkspace.js';
import { Prospect } from '../../models/prospect.model.js';
import { ProspectQualification } from '../../models/prospectQualification.model.js';
import { MAX_REVIEW_HISTORY, ProspectReview } from '../../models/prospectReview.model.js';
import { ProspectWebsiteAnalysis } from '../../models/prospectWebsiteAnalysis.model.js';
import { SalesLead } from '../../models/salesLead.model.js';
import { ApiError } from '../../utils/ApiError.js';
import { isUsableAnalysis, staleReason } from '../qualification/qualification.service.js';

const DUPLICATE_KEY = 11000;
const serviceById = new Map(SERVICE_CATALOG.map((s) => [s.id, s]));

export const READINESS = Object.freeze({
  NOT_REVIEWED: 'NOT_REVIEWED',
  AI_REVIEWED: 'AI_REVIEWED',
  HUMAN_APPROVED: 'HUMAN_APPROVED',
  HUMAN_REJECTED: 'HUMAN_REJECTED',
  OUTREACH_READY: 'OUTREACH_READY',
});

const conflict = (code, message, extra = {}) => new ApiError(409, message, { code, ...extra });
const invalid = (errors) => new ApiError(400, 'Validation failed', errors);

const sameTime = (a, b) => (a ? new Date(a).getTime() : null) === (b ? new Date(b).getTime() : null);

const loadContext = async (target) => {
  const [analysis, qualification, review] = await Promise.all([
    ProspectWebsiteAnalysis.findOne({ subjectKey: target.subjectKey }),
    ProspectQualification.findOne({ subjectKey: target.subjectKey }),
    ProspectReview.findOne({ subjectKey: target.subjectKey }),
  ]);
  return { analysis, qualification, review };
};

/**
 * Whether the stored analysis and qualification can be reviewed now (null) or why not.
 * Rejecting only needs a completed qualification: saying "no" is always safe.
 */
const qualificationProblem = ({ analysis, qualification }, target, { allowOutdated = false } = {}) => {
  if (!allowOutdated && !isUsableAnalysis(analysis, target)) {
    return conflict('ANALYSIS_REQUIRED', 'This business needs a completed website analysis before it can be reviewed.');
  }
  if (qualification?.status !== 'COMPLETED') {
    return conflict('QUALIFICATION_REQUIRED', 'This business needs a completed AI qualification before it can be reviewed.');
  }
  if (!allowOutdated && staleReason(qualification, analysis, target)) {
    return conflict('QUALIFICATION_OUTDATED', 'The AI qualification is outdated. Qualify the business again before reviewing it.');
  }
  return null;
};

const recommendedIds = (qualification) => (qualification?.opportunities ?? []).map((o) => o.serviceId);

/**
 * Approved services whose AI recommendation is not backed by the stored evidence: the
 * opportunity must exist, cite at least one reference, and every reference must be an
 * evidence item in the qualification's snapshot of the website analysis.
 */
export const servicesWithInvalidEvidence = (qualification, serviceIds) => {
  const evidenceIds = new Set((qualification?.evidenceSnapshot ?? []).map((e) => e.id));
  return serviceIds.filter((id) => {
    const opp = (qualification?.opportunities ?? []).find((o) => o.serviceId === id);
    const refs = opp?.evidenceReferences ?? [];
    return refs.length === 0 || !refs.every((ref) => evidenceIds.has(ref));
  });
};

const reviewIsCurrent = (review, qualification) =>
  Boolean(
    review &&
      qualification &&
      review.qualificationId.equals(qualification._id) &&
      sameTime(review.qualificationCompletedAt, qualification.completedAt),
  );

/** Outreach readiness, derived from MongoDB state every time (never stored or sent by clients). */
export const computeReadiness = ({ analysis, qualification, review }, target) => {
  const problems = [];
  const analysisOk = isUsableAnalysis(analysis, target);
  const qualificationOk = analysisOk && qualification?.status === 'COMPLETED' && !staleReason(qualification, analysis, target);
  if (!analysisOk) problems.push('The website analysis is missing or no longer matches this business.');
  else if (!qualificationOk) problems.push('The AI qualification is missing, unfinished or outdated.');

  const decision = review?.decision ?? null;
  if (decision === 'REJECTED') return { status: READINESS.HUMAN_REJECTED, problems: [...problems, 'A reviewer rejected this business.'] };
  if (decision !== 'APPROVED') {
    problems.push(decision === 'NEEDS_REVIEW' ? 'A reviewer marked this business as needing more review.' : 'No reviewer has approved this business yet.');
    return { status: qualificationOk ? READINESS.AI_REVIEWED : READINESS.NOT_REVIEWED, problems };
  }

  if (qualificationOk && !reviewIsCurrent(review, qualification)) {
    problems.push('The AI qualification changed after this approval. Review it again.');
  }
  if (review.approvedServices.length === 0) problems.push('No service was approved.');
  if (qualificationOk && servicesWithInvalidEvidence(qualification, review.approvedServices).length > 0) {
    problems.push('An approved service is not supported by the stored website evidence.');
  }
  return { status: problems.length === 0 ? READINESS.OUTREACH_READY : READINESS.HUMAN_APPROVED, problems };
};

const serviceRef = (id) => ({ serviceId: id, serviceName: serviceById.get(id)?.name ?? id });

const historyDto = (h) => ({
  at: h.at,
  action: h.action,
  reviewer: { id: h.reviewerId.toString(), email: h.reviewerEmail },
  previousDecision: h.previousDecision,
  newDecision: h.newDecision,
  approvedServices: [...h.approvedServices],
  rejectedServices: [...h.rejectedServices],
  addedLeadServices: [...(h.addedLeadServices ?? [])],
  notes: h.notes,
});

export const toReviewDto = (review, qualification) => ({
  id: review._id.toString(),
  prospectId: review.prospectId?.toString() ?? null,
  salesLeadId: review.salesLeadId?.toString() ?? null,
  qualificationId: review.qualificationId.toString(),
  qualificationCompletedAt: review.qualificationCompletedAt,
  outdated: !reviewIsCurrent(review, qualification),
  decision: review.decision,
  serviceDecisions: review.serviceDecisions.map((d) => ({ ...serviceRef(d.serviceId), decision: d.decision })),
  approvedServices: review.approvedServices.map(serviceRef),
  rejectedServices: review.rejectedServices.map(serviceRef),
  reviewNotes: review.reviewNotes,
  reviewerEditedSummary: review.reviewerEditedSummary,
  reviewerEditedNextAction: review.reviewerEditedNextAction,
  evidenceAcknowledged: review.evidenceAcknowledged,
  reviewer: review.reviewerId?.email
    ? { id: review.reviewerId._id.toString(), email: review.reviewerId.email }
    : { id: review.reviewerId.toString(), email: null },
  reviewedAt: review.reviewedAt,
  version: review.version,
  leadUpdate: review.leadUpdate?.appliedAt
    ? { appliedAt: review.leadUpdate.appliedAt, addedServices: [...review.leadUpdate.addedServices] }
    : null,
  history: [...review.history].reverse().map(historyDto),
  createdAt: review.createdAt,
  updatedAt: review.updatedAt,
});

/** The review for a business (or null) and its outreach readiness. */
export const getReview = async (target) => {
  const ctx = await loadContext(target);
  if (ctx.review) await ctx.review.populate('reviewerId', 'email');
  return {
    review: ctx.review ? toReviewDto(ctx.review, ctx.qualification) : null,
    readiness: computeReadiness(ctx, target),
  };
};

/**
 * Applies the reviewer's service decisions on top of the stored ones. Only services the
 * current qualification recommends (and that exist in the catalogue) can be decided;
 * decisions for services no longer recommended are dropped.
 */
const mergeServiceDecisions = (existing, incoming, qualification) => {
  const recommended = recommendedIds(qualification);
  const errors = {};
  incoming.forEach(({ serviceId }, i) => {
    if (!serviceById.has(serviceId)) errors[`serviceDecisions.${i}`] = `Unknown service: ${serviceId}.`;
    else if (!recommended.includes(serviceId)) errors[`serviceDecisions.${i}`] = `${serviceId} was not recommended by this qualification.`;
  });
  if (Object.keys(errors).length) throw invalid(errors);

  const byId = new Map(existing.filter((d) => recommended.includes(d.serviceId)).map((d) => [d.serviceId, d.decision]));
  for (const { serviceId, decision } of incoming) {
    if (decision === 'UNDECIDED') byId.delete(serviceId);
    else byId.set(serviceId, decision);
  }
  // Keep the qualification's order so lists read the same everywhere.
  return recommended.filter((id) => byId.has(id)).map((id) => ({ serviceId: id, decision: byId.get(id) }));
};

const NEXT_DECISION = { save: null, needsReview: 'NEEDS_REVIEW', approve: 'APPROVED', reject: 'REJECTED' };
const ACTION_NAME = { save: 'UPDATED', needsReview: 'NEEDS_REVIEW', approve: 'APPROVED', reject: 'REJECTED' };

/**
 * Creates or changes a review. `expectedVersion` is the version the reviewer was looking
 * at (0 when no review exists yet); any other concurrent change makes this a 409, so two
 * reviewers can never overwrite each other. The reviewer always comes from the session.
 */
export const writeReview = async (target, admin, { action, expectedVersion, input }) => {
  const ctx = await loadContext(target);
  const { qualification, analysis, review } = ctx;
  const problem = qualificationProblem(ctx, target, { allowOutdated: action === 'reject' });
  if (problem) throw problem;

  const currentVersion = review?.version ?? 0;
  if (expectedVersion !== currentVersion) {
    throw conflict(
      'REVIEW_CONFLICT',
      review ? 'This review was changed by someone else. Reload it and try again.' : 'This review no longer exists in the expected state. Reload it and try again.',
      { currentVersion },
    );
  }
  if (action === 'approve' && review?.decision === 'APPROVED' && reviewIsCurrent(review, qualification)) {
    throw conflict('ALREADY_APPROVED', 'This business is already approved.', { currentVersion });
  }
  if (action === 'reject' && review?.decision === 'REJECTED') {
    throw conflict('ALREADY_REJECTED', 'This business is already rejected.', { currentVersion });
  }

  const serviceDecisions = mergeServiceDecisions(review?.serviceDecisions ?? [], input.serviceDecisions ?? [], qualification);
  const approvedServices = serviceDecisions.filter((d) => d.decision === 'APPROVED').map((d) => d.serviceId);
  const rejectedServices = serviceDecisions.filter((d) => d.decision === 'REJECTED').map((d) => d.serviceId);
  const pick = (key) => (key in input ? input[key] : (review?.[key] ?? null));
  const evidenceAcknowledged = 'evidenceAcknowledged' in input ? input.evidenceAcknowledged : (review?.evidenceAcknowledged ?? false);

  if (action === 'approve') {
    const errors = {};
    if (!evidenceAcknowledged) errors.evidenceAcknowledged = 'Confirm that you checked the supporting evidence.';
    if (approvedServices.length === 0) errors.serviceDecisions = 'Approve at least one recommended service.';
    if (Object.keys(errors).length) throw invalid(errors);
    const unsupported = servicesWithInvalidEvidence(qualification, approvedServices);
    if (unsupported.length) {
      throw new ApiError(422, 'Some approved services are not supported by the stored website evidence.', {
        code: 'EVIDENCE_INVALID',
        services: unsupported.join(', '),
      });
    }
  }

  const previousDecision = review?.decision ?? null;
  const newDecision = NEXT_DECISION[action] ?? (previousDecision === 'APPROVED' || previousDecision === 'REJECTED' ? 'PENDING' : (previousDecision ?? 'PENDING'));
  const now = new Date();
  const set = {
    prospectId: target.prospectId ?? null,
    salesLeadId: target.salesLeadId ?? null,
    qualificationId: qualification._id,
    qualificationCompletedAt: qualification.completedAt,
    analysisId: analysis?._id ?? null,
    decision: newDecision,
    serviceDecisions,
    approvedServices,
    rejectedServices,
    reviewNotes: pick('reviewNotes'),
    reviewerEditedSummary: pick('reviewerEditedSummary'),
    reviewerEditedNextAction: pick('reviewerEditedNextAction'),
    evidenceAcknowledged,
    reviewerId: admin._id,
    ...(newDecision !== previousDecision || action === 'approve' || action === 'reject' ? { reviewedAt: now } : {}),
  };
  const entry = {
    at: now,
    action: review ? ACTION_NAME[action] : action === 'save' ? 'CREATED' : ACTION_NAME[action],
    reviewerId: admin._id,
    reviewerEmail: admin.email ?? null,
    previousDecision,
    newDecision,
    approvedServices,
    rejectedServices,
    notes: set.reviewNotes ? set.reviewNotes.slice(0, 500) : null,
  };

  let saved;
  if (!review) {
    try {
      saved = await ProspectReview.create({ subjectKey: target.subjectKey, ...set, version: 1, history: [entry] });
    } catch (err) {
      if (err?.code === DUPLICATE_KEY) throw conflict('REVIEW_CONFLICT', 'A review was just created by someone else. Reload it and try again.');
      throw err;
    }
  } else {
    saved = await ProspectReview.findOneAndUpdate(
      { _id: review._id, version: expectedVersion },
      { $set: set, $inc: { version: 1 }, $push: { history: { $each: [entry], $slice: -MAX_REVIEW_HISTORY } } },
      { returnDocument: 'after', runValidators: true },
    );
    if (!saved) throw conflict('REVIEW_CONFLICT', 'This review was changed by someone else. Reload it and try again.');
  }

  if (newDecision === 'APPROVED') saved = await applyApprovedServicesToLead(saved, target, admin);
  return getReview(target);
};

/**
 * After an approval, adds the approved services (by catalogue name) to the linked sales
 * lead. Only adds: services a person put on the lead are never removed or reordered,
 * and nothing else on the lead changes. Without a linked lead nothing is created.
 */
const applyApprovedServicesToLead = async (review, target, admin) => {
  if (!target.salesLeadId) return review;
  const names = review.approvedServices.map((id) => serviceById.get(id)?.name).filter(Boolean);
  const lead = await SalesLead.findById(target.salesLeadId).select('potentialServices');
  if (!lead) return review;
  const missing = names.filter((n) => !lead.potentialServices.includes(n));
  const { maxServices } = leadWorkspaceConfig.limits;
  if (missing.length === 0 || lead.potentialServices.length + missing.length > maxServices) return review;

  const res = await SalesLead.updateOne(
    { _id: lead._id, [`potentialServices.${maxServices - missing.length}`]: { $exists: false } },
    { $addToSet: { potentialServices: { $each: missing } } },
  );
  if (res.modifiedCount !== 1) return review;
  const now = new Date();
  return (
    (await ProspectReview.findOneAndUpdate(
      { _id: review._id },
      {
        $set: { leadUpdate: { appliedAt: now, addedServices: missing } },
        $push: {
          history: {
            $each: [
              {
                at: now,
                action: 'LEAD_UPDATED',
                reviewerId: admin._id,
                reviewerEmail: admin.email ?? null,
                previousDecision: 'APPROVED',
                newDecision: 'APPROVED',
                approvedServices: review.approvedServices,
                rejectedServices: review.rejectedServices,
                addedLeadServices: missing,
                notes: null,
              },
            ],
            $slice: -MAX_REVIEW_HISTORY,
          },
        },
      },
      { returnDocument: 'after' },
    )) ?? review
  );
};

const evidenceDto = (e) => ({ id: e.id, type: e.type, severity: e.severity, evidence: e.evidence, source: e.source });

/**
 * Read-only outreach preview. Only services a reviewer approved appear, each with the
 * stored evidence behind it; nothing is generated, queued or sent.
 */
export const getOutreachPreview = async (target) => {
  const ctx = await loadContext(target);
  const { qualification, review } = ctx;
  const [lead, prospect] = await Promise.all([
    target.salesLeadId
      ? SalesLead.findById(target.salesLeadId).select('businessName category phone website city state country googleMapsUrl source').lean()
      : null,
    target.prospectId
      ? Prospect.findById(target.prospectId).select('businessName category phone website city state country googleMapsUrl source').lean()
      : null,
  ]);
  const pickBiz = (key) => lead?.[key] || prospect?.[key] || null;
  const approved = review?.decision === 'APPROVED' ? review.approvedServices : [];
  const evidenceById = new Map((qualification?.evidenceSnapshot ?? []).map((e) => [e.id, e]));
  if (review) await review.populate('reviewerId', 'email');

  return {
    readiness: computeReadiness(ctx, target),
    business: {
      name: pickBiz('businessName'),
      category: pickBiz('category'),
      phone: pickBiz('phone'),
      website: target.websiteUrl ?? pickBiz('website'),
      location: [pickBiz('city'), pickBiz('state'), pickBiz('country')].filter(Boolean).join(', ') || null,
      googleMapsUrl: pickBiz('googleMapsUrl'),
    },
    approvedServices: approved.map((id) => {
      const opp = (qualification?.opportunities ?? []).find((o) => o.serviceId === id);
      return {
        ...serviceRef(id),
        aiReason: opp?.reason ?? null,
        evidence: (opp?.evidenceReferences ?? []).map((ref) => evidenceById.get(ref)).filter(Boolean).map(evidenceDto),
      };
    }),
    summary: review?.reviewerEditedSummary
      ? { text: review.reviewerEditedSummary, source: 'REVIEWER' }
      : qualification?.summary
        ? { text: qualification.summary, source: 'AI' }
        : null,
    nextAction: review?.reviewerEditedNextAction
      ? { text: review.reviewerEditedNextAction, source: 'REVIEWER' }
      : qualification?.recommendedNextAction
        ? { text: qualification.recommendedNextAction, source: 'AI' }
        : null,
    reviewerNotes: review?.reviewNotes ?? null,
    reviewedBy: review?.reviewerId?.email ?? null,
    reviewedAt: review?.reviewedAt ?? null,
    // This phase only establishes readiness: there is no draft and no way to send.
    draftMessage: null,
    sending: { available: false, note: 'Message drafting and sending are not available. Any future message needs separate human approval.' },
  };
};
