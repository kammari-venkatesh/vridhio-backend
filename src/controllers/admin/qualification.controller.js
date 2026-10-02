import * as qualifications from '../../services/qualification/qualification.service.js';
import { resolveLeadTarget, resolveProspectTarget } from '../../services/websiteAnalysis/websiteAnalysis.service.js';
import { ApiError } from '../../utils/ApiError.js';
import { validateBulkQualify, validateQualifyBody, validateStatusQuery } from '../../validators/qualification.validator.js';

const validated = ({ value, errors, isValid }) => {
  if (!isValid) throw new ApiError(400, 'Validation failed', errors);
  return value;
};

// 202 when a qualification was queued; 200 when an existing one is returned.
const respond = (res, { qualification, outcome }) =>
  res.status(outcome === 'queued' ? 202 : 200).json({ success: true, data: { qualification, outcome } });

const qualify = (resolveTarget, idParam, { forceRefresh = false } = {}) => async (req, res) => {
  const { refresh } = validated(validateQualifyBody(req.body));
  const target = await resolveTarget(req.params[idParam]);
  respond(res, await qualifications.requestQualification(target, { refresh: forceRefresh || refresh, adminId: req.admin._id }));
};

const read = (resolveTarget, idParam) => async (req, res) => {
  const target = await resolveTarget(req.params[idParam]);
  res.json({ success: true, data: await qualifications.getQualificationFor(target) });
};

export const qualifyProspect = qualify(resolveProspectTarget, 'prospectId');
export const refreshProspectQualification = qualify(resolveProspectTarget, 'prospectId', { forceRefresh: true });
export const getProspectQualification = read(resolveProspectTarget, 'prospectId');

export const qualifyLead = qualify(resolveLeadTarget, 'leadId');
export const refreshLeadQualification = qualify(resolveLeadTarget, 'leadId', { forceRefresh: true });
export const getLeadQualification = read(resolveLeadTarget, 'leadId');

export const bulkQualifyLeads = async (req, res) => {
  const { ids } = validated(validateBulkQualify(req.body));
  res.json({ success: true, data: await qualifications.requestBulkQualification(ids, req.admin._id) });
};

export const leadQualificationStatuses = async (req, res) => {
  const { ids } = validated(validateStatusQuery(req.query));
  res.json({ success: true, data: await qualifications.leadQualificationStatuses(ids) });
};

export const aiStatus = async (_req, res) => {
  res.json({ success: true, data: await qualifications.getAiStatus() });
};
