export const REVIEW_LIMITS = Object.freeze({
  notesMaxLength: 2000,
  summaryMaxLength: 600,
  nextActionMaxLength: 200,
  maxServiceDecisions: 20,
});

const SERVICE_ID = /^[a-z0-9-]{1,60}$/;
const SERVICE_DECISION_VALUES = ['APPROVED', 'REJECTED', 'UNDECIDED'];

const TEXT_FIELDS = {
  reviewNotes: REVIEW_LIMITS.notesMaxLength,
  reviewerEditedSummary: REVIEW_LIMITS.summaryMaxLength,
  reviewerEditedNextAction: REVIEW_LIMITS.nextActionMaxLength,
};

// Removes control characters (keeps line breaks) so stored text renders predictably.
const cleanText = (value) =>
  value
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F\u200B-\u200F\u2028\u2029\uFEFF]/g, '')
    .trim();

/**
 * Review request bodies. The reviewer, decision timestamps, approved/rejected lists and
 * readiness are always derived on the server, so fields like reviewerId, approvedServices
 * or decision=APPROVED are rejected instead of ignored.
 *
 * `allowNeedsReview` permits { decision: "NEEDS_REVIEW" } (PATCH only).
 */
export const validateReviewBody = (body, { requireVersion = true, allowNeedsReview = false } = {}) => {
  const errors = {};
  const value = {};
  if (body === undefined || body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { value, errors: { body: 'Invalid request body.' }, isValid: false };
  }
  const allowed = new Set(['expectedVersion', 'serviceDecisions', 'evidenceAcknowledged', ...Object.keys(TEXT_FIELDS)]);
  if (allowNeedsReview) allowed.add('decision');
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) errors[key] = 'This field is not allowed.';
  }

  if ('expectedVersion' in body) {
    if (!Number.isInteger(body.expectedVersion) || body.expectedVersion < 0) errors.expectedVersion = 'expectedVersion must be a whole number.';
    else value.expectedVersion = body.expectedVersion;
  } else if (requireVersion) {
    errors.expectedVersion = 'expectedVersion is required (0 when no review exists yet).';
  }

  if ('serviceDecisions' in body) {
    const list = body.serviceDecisions;
    if (!Array.isArray(list) || list.length > REVIEW_LIMITS.maxServiceDecisions) {
      errors.serviceDecisions = `Provide at most ${REVIEW_LIMITS.maxServiceDecisions} service decisions.`;
    } else {
      const seen = new Set();
      list.forEach((item, i) => {
        const ok =
          item &&
          typeof item === 'object' &&
          Object.keys(item).every((k) => k === 'serviceId' || k === 'decision') &&
          typeof item.serviceId === 'string' &&
          SERVICE_ID.test(item.serviceId) &&
          SERVICE_DECISION_VALUES.includes(item.decision);
        if (!ok) errors[`serviceDecisions.${i}`] = 'Each decision needs a serviceId and a decision of APPROVED, REJECTED or UNDECIDED.';
        else if (seen.has(item.serviceId)) errors[`serviceDecisions.${i}`] = `Duplicate decision for ${item.serviceId}.`;
        else seen.add(item.serviceId);
      });
      if (!Object.keys(errors).some((k) => k.startsWith('serviceDecisions'))) {
        value.serviceDecisions = list.map(({ serviceId, decision }) => ({ serviceId, decision }));
      }
    }
  }

  if ('evidenceAcknowledged' in body) {
    if (typeof body.evidenceAcknowledged !== 'boolean') errors.evidenceAcknowledged = 'evidenceAcknowledged must be true or false.';
    else value.evidenceAcknowledged = body.evidenceAcknowledged;
  }

  for (const [key, max] of Object.entries(TEXT_FIELDS)) {
    if (!(key in body)) continue;
    const raw = body[key];
    if (raw === null) value[key] = null;
    else if (typeof raw !== 'string') errors[key] = 'Must be text.';
    else {
      const text = cleanText(raw);
      if (text.length > max) errors[key] = `At most ${max} characters.`;
      else value[key] = text || null;
    }
  }

  if (allowNeedsReview && 'decision' in body) {
    if (body.decision !== 'NEEDS_REVIEW') errors.decision = 'Only NEEDS_REVIEW can be set here; use approve or reject for decisions.';
    else value.needsReview = true;
  }

  return { value, errors, isValid: Object.keys(errors).length === 0 };
};
