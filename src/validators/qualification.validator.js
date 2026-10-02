import { qualificationConfig } from '../config/qualification.js';

const OBJECT_ID = /^[a-f0-9]{24}$/i;

export { validateAnalyzeBody as validateQualifyBody, validateStatusQuery } from './websiteAnalysis.validator.js';

export const validateBulkQualify = (body) => {
  const { bulkMaxIds } = qualificationConfig.policy;
  const ids = body?.ids;
  if (!Array.isArray(ids) || ids.length === 0) {
    return { value: null, errors: { ids: 'Provide a non-empty list of lead IDs.' }, isValid: false };
  }
  if (ids.length > bulkMaxIds) {
    return { value: null, errors: { ids: `At most ${bulkMaxIds} leads can be qualified at once.` }, isValid: false };
  }
  if (!ids.every((id) => typeof id === 'string' && OBJECT_ID.test(id))) {
    return { value: null, errors: { ids: 'Every ID must be a valid lead ID.' }, isValid: false };
  }
  const extra = Object.keys(body).filter((k) => k !== 'ids');
  if (extra.length > 0) return { value: null, errors: Object.fromEntries(extra.map((k) => [k, 'This field is not allowed.'])), isValid: false };
  return { value: { ids: [...new Set(ids)] }, errors: {}, isValid: true };
};
