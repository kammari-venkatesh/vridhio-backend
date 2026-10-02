import mongoose from 'mongoose';
import {
  leadWorkspaceConfig,
  SALES_LEAD_SOURCES,
  SALES_LEAD_STATUSES,
} from '../config/leadWorkspace.js';
import { DELIMITERS } from '../services/leadWorkspace/importParser.js';
import { canonicalService, canonicalStatus, normalizeTag } from '../services/leadWorkspace/leadFields.js';

const { pagination, sortFields, limits } = leadWorkspaceConfig;
const MAX_PAGE = 10_000;
const result = (value, errors) => ({ value, errors, isValid: Object.keys(errors).length === 0 });
const isObjectIdString = (id) => typeof id === 'string' && /^[a-f0-9]{24}$/i.test(id) && mongoose.isValidObjectId(id);

/** Query string for listing and exporting leads. Every value must be a single string. */
export const validateLeadQuery = (query = {}, { paginate = true } = {}) => {
  const errors = {};
  const text = (key, max = 100) => {
    const raw = query[key];
    if (raw === undefined || raw === '') return undefined;
    if (typeof raw !== 'string') {
      errors[key] = `${key} must be a single value.`;
      return undefined;
    }
    const value = raw.trim();
    if (value.length > max) errors[key] = `${key} must be at most ${max} characters.`;
    return value || undefined;
  };

  const value = {
    search: text('search', limits.searchMaxLength),
    category: text('category'),
    city: text('city'),
    sortOrder: text('sortOrder') ?? 'desc',
    sortBy: text('sortBy') ?? 'createdAt',
    archived: text('archived') ?? 'active',
  };

  const status = text('status');
  if (status) {
    value.status = SALES_LEAD_STATUSES.includes(status) ? status : undefined;
    if (!value.status) errors.status = 'Unknown status.';
  }
  const source = text('source');
  if (source) {
    value.source = SALES_LEAD_SOURCES.includes(source) ? source : undefined;
    if (!value.source) errors.source = 'Unknown source.';
  }
  const service = text('service');
  if (service) {
    value.service = canonicalService(service) ?? undefined;
    if (!value.service) errors.service = 'Unknown service.';
  }
  const tag = text('tag', limits.tagMaxLength);
  if (tag) value.tag = normalizeTag(tag);
  const assignedTo = text('assignedTo');
  if (assignedTo) {
    if (assignedTo === 'none' || isObjectIdString(assignedTo)) value.assignedTo = assignedTo;
    else errors.assignedTo = 'assignedTo must be an admin ID or "none".';
  }

  if (!Object.hasOwn(sortFields, value.sortBy)) errors.sortBy = `sortBy must be one of: ${Object.keys(sortFields).join(', ')}.`;
  if (!['asc', 'desc'].includes(value.sortOrder)) errors.sortOrder = 'sortOrder must be asc or desc.';
  if (!['active', 'only', 'all'].includes(value.archived)) errors.archived = 'archived must be active, only or all.';

  if (paginate) {
    value.page = query.page === undefined ? 1 : Number(query.page);
    value.limit = query.limit === undefined ? pagination.defaultLimit : Number(query.limit);
    if (!Number.isInteger(value.page) || value.page < 1 || value.page > MAX_PAGE) errors.page = 'page must be a positive whole number.';
    if (!Number.isInteger(value.limit) || value.limit < 1 || value.limit > pagination.maxLimit) {
      errors.limit = `limit must be a whole number from 1 to ${pagination.maxLimit}.`;
    }
  }
  return result(value, errors);
};

const BULK_OPERATIONS = ['status', 'addTag', 'removeTag', 'addService', 'removeService', 'assign', 'archive', 'unarchive'];

/** { ids, operation, value } for PATCH /leads/bulk. Admin existence for "assign" is checked by the controller. */
export const validateBulkRequest = (body = {}) => {
  const errors = {};
  const { ids, operation } = body ?? {};
  let value = body?.value;

  if (!Array.isArray(ids) || ids.length === 0) errors.ids = 'Select at least one lead.';
  else if (ids.length > limits.bulkMaxIds) errors.ids = `At most ${limits.bulkMaxIds} leads per bulk update.`;
  else if (!ids.every(isObjectIdString)) errors.ids = 'ids must be valid lead IDs.';

  if (!BULK_OPERATIONS.includes(operation)) {
    errors.operation = `operation must be one of: ${BULK_OPERATIONS.join(', ')}.`;
  } else if (operation === 'status') {
    value = typeof value === 'string' ? canonicalStatus(value) : null;
    if (!value) errors.value = 'Choose a valid status.';
  } else if (operation === 'addTag' || operation === 'removeTag') {
    value = typeof value === 'string' ? normalizeTag(value) : '';
    if (!value || value.length > limits.tagMaxLength) errors.value = `Tag must be 1–${limits.tagMaxLength} characters.`;
  } else if (operation === 'addService' || operation === 'removeService') {
    value = typeof value === 'string' ? canonicalService(value) : null;
    if (!value) errors.value = 'Choose a valid service.';
  } else if (operation === 'assign') {
    if (value === null || value === '') value = null;
    else if (!isObjectIdString(value)) errors.value = 'Choose a valid admin user.';
  } else {
    value = undefined;
  }

  return result({ ids: Array.isArray(ids) ? [...new Set(ids)] : [], operation, value }, errors);
};

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** { rows: [{ clientId, values }] } for POST /leads/batch. Row values are validated per row by the service. */
export const validateBatchCreate = (body = {}) => {
  const errors = {};
  const rows = body?.rows;
  if (!Array.isArray(rows) || rows.length === 0) errors.rows = 'Provide at least one row.';
  else if (rows.length > limits.batchMaxRows) {
    errors.rows = `At most ${limits.batchMaxRows} rows at a time. Use Import for larger sets.`;
  } else if (
    !rows.every(
      (r) =>
        isPlainObject(r) &&
        typeof r.clientId === 'string' &&
        r.clientId.length > 0 &&
        r.clientId.length <= 64 &&
        isPlainObject(r.values),
    )
  ) {
    errors.rows = 'Each row needs a clientId and a values object.';
  } else if (new Set(rows.map((r) => r.clientId)).size !== rows.length) {
    errors.rows = 'Row clientIds must be unique.';
  }
  return result({ rows: Array.isArray(rows) ? rows.map(({ clientId, values }) => ({ clientId, values })) : [] }, errors);
};

const FORMATS = ['auto', ...Object.keys(DELIMITERS)];

/** Body for import preview and import. Content is re-parsed server-side every time. */
export const validateImportRequest = (body = {}, { requireMapping }) => {
  const errors = {};
  const { content, format = 'auto', hasHeader = 'auto', mapping, duplicateMode = 'skip', method = 'paste', fileName } = body ?? {};
  const { maxContentLength, maxColumns } = leadWorkspaceConfig.import;

  if (typeof content !== 'string' || content.trim() === '') errors.content = 'Paste or upload some data to import.';
  else if (content.length > maxContentLength) {
    errors.content = `Data is too large (max ${Math.round(maxContentLength / 1_000_000)} MB). Split it into smaller imports.`;
  }
  if (!FORMATS.includes(format)) errors.format = `format must be one of: ${FORMATS.join(', ')}.`;
  if (!['auto', true, false].includes(hasHeader)) errors.hasHeader = 'hasHeader must be auto, true or false.';
  if (!['skip', 'update'].includes(duplicateMode)) errors.duplicateMode = 'duplicateMode must be skip or update.';
  if (!['paste', 'csv'].includes(method)) errors.method = 'method must be paste or csv.';
  if (fileName !== undefined && (typeof fileName !== 'string' || fileName.length > 200)) {
    errors.fileName = 'fileName must be at most 200 characters.';
  }

  if (mapping !== undefined || requireMapping) {
    const valid =
      Array.isArray(mapping) &&
      mapping.length <= maxColumns &&
      mapping.every(
        (m) =>
          m &&
          typeof m === 'object' &&
          typeof m.target === 'string' &&
          (m.customName === undefined || (typeof m.customName === 'string' && m.customName.length <= 100)),
      );
    if (!valid) errors.mapping = 'mapping must be a list of { target, customName } entries, one per column.';
  }

  return result(
    {
      content,
      format,
      hasHeader,
      mapping: Array.isArray(mapping) ? mapping.map((m) => ({ target: m?.target, customName: m?.customName })) : undefined,
      duplicateMode,
      method,
      fileName: fileName?.replace(/[^\w .()-]/g, '_'),
    },
    errors,
  );
};
