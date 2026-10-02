import { websiteAnalysisConfig } from '../config/websiteAnalysis.js';

const OBJECT_ID = /^[a-f0-9]{24}$/i;
const MAX_STATUS_IDS = 100;

/** Analyze requests accept an empty body or { refresh: boolean }. */
export const validateAnalyzeBody = (body) => {
  const value = { refresh: false };
  const errors = {};
  if (body === undefined || body === null) return { value, errors, isValid: true };
  if (typeof body !== 'object' || Array.isArray(body)) return { value, errors: { body: 'Invalid request body.' }, isValid: false };
  for (const key of Object.keys(body)) {
    if (key !== 'refresh') errors[key] = 'This field is not allowed.';
  }
  if ('refresh' in body) {
    if (typeof body.refresh !== 'boolean') errors.refresh = 'refresh must be true or false.';
    else value.refresh = body.refresh;
  }
  return { value, errors, isValid: Object.keys(errors).length === 0 };
};

export const validateBulkAnalyze = (body) => {
  const { bulkMaxIds } = websiteAnalysisConfig.policy;
  const ids = body?.ids;
  if (!Array.isArray(ids) || ids.length === 0) {
    return { value: null, errors: { ids: 'Provide a non-empty list of lead IDs.' }, isValid: false };
  }
  if (ids.length > bulkMaxIds) {
    return { value: null, errors: { ids: `At most ${bulkMaxIds} leads can be analysed at once.` }, isValid: false };
  }
  if (!ids.every((id) => typeof id === 'string' && OBJECT_ID.test(id))) {
    return { value: null, errors: { ids: 'Every ID must be a valid lead ID.' }, isValid: false };
  }
  const extra = Object.keys(body).filter((k) => k !== 'ids');
  if (extra.length > 0) return { value: null, errors: Object.fromEntries(extra.map((k) => [k, 'This field is not allowed.'])), isValid: false };
  return { value: { ids: [...new Set(ids)] }, errors: {}, isValid: true };
};

export const validateStatusQuery = (query) => {
  const raw = typeof query?.ids === 'string' ? query.ids : '';
  const ids = [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))];
  if (ids.length === 0) return { value: null, errors: { ids: 'Provide lead IDs.' }, isValid: false };
  if (ids.length > MAX_STATUS_IDS) return { value: null, errors: { ids: `At most ${MAX_STATUS_IDS} IDs.` }, isValid: false };
  if (!ids.every((id) => OBJECT_ID.test(id))) return { value: null, errors: { ids: 'Every ID must be a valid lead ID.' }, isValid: false };
  return { value: { ids }, errors: {}, isValid: true };
};
