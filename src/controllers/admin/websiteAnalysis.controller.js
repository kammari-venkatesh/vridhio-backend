import * as analyses from '../../services/websiteAnalysis/websiteAnalysis.service.js';
import { ApiError } from '../../utils/ApiError.js';
import {
  validateAnalyzeBody,
  validateBulkAnalyze,
  validateStatusQuery,
} from '../../validators/websiteAnalysis.validator.js';

const validated = ({ value, errors, isValid }) => {
  if (!isValid) throw new ApiError(400, 'Validation failed', errors);
  return value;
};

// 202 when a fetch was queued; 200 when an existing or immediate result is returned.
const respond = (res, { analysis, outcome }) =>
  res.status(outcome === 'queued' ? 202 : 200).json({ success: true, data: { analysis, outcome, jobId: analysis.id } });

const analyze = (resolveTarget, idParam, { forceRefresh = false } = {}) => async (req, res) => {
  const { refresh } = validated(validateAnalyzeBody(req.body));
  const target = await resolveTarget(req.params[idParam]);
  respond(res, await analyses.requestAnalysis(target, { refresh: forceRefresh || refresh, adminId: req.admin._id }));
};

const read = (resolveTarget, idParam) => async (req, res) => {
  const target = await resolveTarget(req.params[idParam]);
  res.json({ success: true, data: await analyses.getAnalysisFor(target) });
};

export const analyzeProspect = analyze(analyses.resolveProspectTarget, 'prospectId');
export const refreshProspect = analyze(analyses.resolveProspectTarget, 'prospectId', { forceRefresh: true });
export const getProspectAnalysis = read(analyses.resolveProspectTarget, 'prospectId');

export const analyzeLead = analyze(analyses.resolveLeadTarget, 'leadId');
export const refreshLead = analyze(analyses.resolveLeadTarget, 'leadId', { forceRefresh: true });
export const getLeadAnalysis = read(analyses.resolveLeadTarget, 'leadId');

export const bulkAnalyzeLeads = async (req, res) => {
  const { ids } = validated(validateBulkAnalyze(req.body));
  res.json({ success: true, data: await analyses.requestBulkAnalysis(ids, req.admin._id) });
};

export const leadAnalysisStatuses = async (req, res) => {
  const { ids } = validated(validateStatusQuery(req.query));
  res.json({ success: true, data: await analyses.leadAnalysisStatuses(ids) });
};

export const getAnalysisJob = async (req, res) => {
  res.json({ success: true, data: await analyses.getAnalysisJob(req.params.jobId) });
};

export const cancelAnalysisJob = async (req, res) => {
  res.json({ success: true, data: await analyses.cancelAnalysis(req.params.jobId) });
};
