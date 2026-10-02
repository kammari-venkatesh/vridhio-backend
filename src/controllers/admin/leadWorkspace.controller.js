import { previewImport, runImport } from '../../services/leadWorkspace/importService.js';
import * as salesLeads from '../../services/leadWorkspace/salesLead.service.js';
import { attachLeadQualificationSummaries } from '../../services/qualification/qualification.service.js';
import { attachLeadAnalysisSummaries } from '../../services/websiteAnalysis/websiteAnalysis.service.js';
import { ApiError } from '../../utils/ApiError.js';
import {
  validateBatchCreate,
  validateBulkRequest,
  validateImportRequest,
  validateLeadQuery,
} from '../../validators/salesLead.validator.js';

const validated = ({ value, errors, isValid }) => {
  if (!isValid) throw new ApiError(400, 'Validation failed', errors);
  return value;
};

const withSummaries = async (leads) => attachLeadQualificationSummaries(await attachLeadAnalysisSummaries(leads));

export const getMeta = async (_req, res) => {
  res.json({ success: true, data: await salesLeads.getWorkspaceMeta() });
};

export const listLeads = async (req, res) => {
  const { items, pagination } = await salesLeads.listLeads(validated(validateLeadQuery(req.query)));
  res.json({ success: true, data: await withSummaries(items), pagination });
};

export const getLead = async (req, res) => {
  const [lead] = await withSummaries([await salesLeads.getLead(req.params.leadId)]);
  res.json({ success: true, data: lead });
};

export const createLead = async (req, res) => {
  res.status(201).json({ success: true, data: await salesLeads.createLead(req.body, req.admin._id) });
};

export const createLeadsBatch = async (req, res) => {
  const { rows } = validated(validateBatchCreate(req.body));
  res.json({ success: true, data: await salesLeads.createLeadsBatch(rows, req.admin._id) });
};

export const updateLead = async (req, res) => {
  const [lead] = await withSummaries([await salesLeads.updateLead(req.params.leadId, req.body)]);
  res.json({ success: true, data: lead });
};

export const archiveLead = async (req, res) => {
  res.json({ success: true, data: await salesLeads.archiveLead(req.params.leadId) });
};

export const bulkUpdate = async (req, res) => {
  res.json({ success: true, data: await salesLeads.bulkUpdateLeads(validated(validateBulkRequest(req.body))) });
};

export const exportLeads = async (req, res) => {
  const query = validated(validateLeadQuery(req.query, { paginate: false }));
  const { csv, count, truncated } = await salesLeads.exportLeadsCsv(query);
  const date = new Date().toISOString().slice(0, 10);
  res
    .set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="sales-leads-${date}.csv"`,
      'X-Export-Count': String(count),
      'X-Export-Truncated': String(truncated),
    })
    .send(csv);
};

export const importPreview = async (req, res) => {
  const request = validated(validateImportRequest(req.body, { requireMapping: false }));
  res.json({ success: true, data: await previewImport(request) });
};

export const importLeads = async (req, res) => {
  const request = validated(validateImportRequest(req.body, { requireMapping: true }));
  res.json({ success: true, data: await runImport(request, req.admin._id) });
};

export const promoteProspect = async (req, res) => {
  const result = await salesLeads.promoteProspect(req.params.prospectId, req.admin._id);
  res.status(result.created ? 201 : 200).json({ success: true, data: result });
};
