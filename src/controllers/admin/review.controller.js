import * as reviews from '../../services/review/review.service.js';
import { resolveLeadTarget, resolveProspectTarget } from '../../services/websiteAnalysis/websiteAnalysis.service.js';
import { ApiError } from '../../utils/ApiError.js';
import { validateReviewBody } from '../../validators/review.validator.js';

const validated = ({ value, errors, isValid }) => {
  if (!isValid) throw new ApiError(400, 'Validation failed', errors);
  return value;
};

const withoutVersion = ({ expectedVersion: _v, needsReview: _n, ...input }) => input;

const read = (resolveTarget, idParam) => async (req, res) => {
  const target = await resolveTarget(req.params[idParam]);
  res.json({ success: true, data: await reviews.getReview(target) });
};

// POST .../review: creates the review (409 if one already exists).
const create = (resolveTarget, idParam) => async (req, res) => {
  const value = validated(validateReviewBody(req.body ?? {}, { requireVersion: false }));
  const target = await resolveTarget(req.params[idParam]);
  const data = await reviews.writeReview(target, req.admin, { action: 'save', expectedVersion: 0, input: withoutVersion(value) });
  res.status(201).json({ success: true, data });
};

// PATCH .../review: saves changes, or marks it as needing more review.
const update = (resolveTarget, idParam) => async (req, res) => {
  const value = validated(validateReviewBody(req.body, { allowNeedsReview: true }));
  if (value.expectedVersion === 0) throw new ApiError(400, 'Validation failed', { expectedVersion: 'Create the review first.' });
  const target = await resolveTarget(req.params[idParam]);
  const action = value.needsReview ? 'needsReview' : 'save';
  res.json({ success: true, data: await reviews.writeReview(target, req.admin, { action, expectedVersion: value.expectedVersion, input: withoutVersion(value) }) });
};

// POST .../approve and .../reject. expectedVersion 0 creates the review with the decision.
const decide = (resolveTarget, idParam, action) => async (req, res) => {
  const value = validated(validateReviewBody(req.body));
  const target = await resolveTarget(req.params[idParam]);
  res.json({ success: true, data: await reviews.writeReview(target, req.admin, { action, expectedVersion: value.expectedVersion, input: withoutVersion(value) }) });
};

const preview = (resolveTarget, idParam) => async (req, res) => {
  const target = await resolveTarget(req.params[idParam]);
  res.json({ success: true, data: await reviews.getOutreachPreview(target) });
};

export const getProspectReview = read(resolveProspectTarget, 'prospectId');
export const createProspectReview = create(resolveProspectTarget, 'prospectId');
export const updateProspectReview = update(resolveProspectTarget, 'prospectId');
export const approveProspect = decide(resolveProspectTarget, 'prospectId', 'approve');
export const rejectProspect = decide(resolveProspectTarget, 'prospectId', 'reject');
export const prospectOutreachPreview = preview(resolveProspectTarget, 'prospectId');

export const getLeadReview = read(resolveLeadTarget, 'leadId');
export const createLeadReview = create(resolveLeadTarget, 'leadId');
export const updateLeadReview = update(resolveLeadTarget, 'leadId');
export const approveLead = decide(resolveLeadTarget, 'leadId', 'approve');
export const rejectLead = decide(resolveLeadTarget, 'leadId', 'reject');
export const leadOutreachPreview = preview(resolveLeadTarget, 'leadId');
