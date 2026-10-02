import { leadFinderConfig } from '../../config/leadFinder.js';
import { getSpendSummary } from '../../services/leadFinder/cost.service.js';
import * as jobService from '../../services/leadFinder/leadFinderJob.service.js';
import { listProspectsForJob } from '../../services/leadFinder/prospect.service.js';
import { getProviderStatus } from '../../services/leadFinder/providers.js';
import { attachSalesLeadIds } from '../../services/leadWorkspace/salesLead.service.js';
import { attachProspectAnalysisSummaries } from '../../services/websiteAnalysis/websiteAnalysis.service.js';
import { ApiError } from '../../utils/ApiError.js';
import { validateJobParams, validatePagination } from '../../validators/leadFinder.validator.js';

const parsePagination = (query, config) => {
  const { pagination, errors, isValid } = validatePagination(query, config);
  if (!isValid) throw new ApiError(400, 'Validation failed', errors);
  return pagination;
};

export const createJob = async (req, res) => {
  const { params, provider, errors, isValid } = validateJobParams(req.body);
  if (!isValid) throw new ApiError(400, 'Validation failed', errors);

  const job = await jobService.createJob(params, req.admin._id, { provider });
  res.status(202).json({ success: true, data: { jobId: job.id, status: job.status, job } });
};

export const listJobs = async (req, res) => {
  const pagination = parsePagination(req.query, leadFinderConfig.pagination.jobs);
  res.json({ success: true, data: await jobService.listJobs(pagination) });
};

export const getJob = async (req, res) => {
  res.json({ success: true, data: await jobService.getJob(req.params.jobId) });
};

export const listProspects = async (req, res) => {
  const pagination = parsePagination(req.query, leadFinderConfig.pagination.prospects);
  const result = await listProspectsForJob(req.params.jobId, pagination);
  const items = await attachProspectAnalysisSummaries(await attachSalesLeadIds(result.items));
  res.json({ success: true, data: { ...result, items } });
};

export const providerStatus = (req, res) => {
  res.json({ success: true, data: getProviderStatus() });
};

export const usageSummary = async (req, res) => {
  res.json({ success: true, data: await getSpendSummary() });
};

export const cancelJob = async (req, res) => {
  res.json({ success: true, data: await jobService.cancelJob(req.params.jobId) });
};
