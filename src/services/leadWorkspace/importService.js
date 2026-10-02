import { leadWorkspaceConfig } from '../../config/leadWorkspace.js';
import { SalesLead } from '../../models/salesLead.model.js';
import { ApiError } from '../../utils/ApiError.js';
import { parseImportContent, suggestMapping } from './importParser.js';
import {
  computeDedupeKeys,
  LEAD_FIELD_KEYS,
  LEAD_FIELDS,
  normalizeFieldValue,
  sanitizeCustomFieldKey,
} from './leadFields.js';
/**
 * Shared import pipeline for spreadsheet paste and CSV upload:
 * parse → map columns → normalise rows → detect duplicates → (import only) write.
 * Preview runs every step except the write.
 */

const config = leadWorkspaceConfig.import;
const { maxCustomFields, customFieldValueMaxLength } = leadWorkspaceConfig.limits;
const FIELD_LABELS = new Map(LEAD_FIELDS.map((f) => [f.key, f.label]));
const IMPORT_SOURCE_DETAIL = { paste: 'Spreadsheet paste', csv: 'CSV upload' };

const parseOrThrow = (request) => {
  const parsed = parseImportContent(request);
  if (parsed.rows.length === 0) {
    throw new ApiError(400, 'No data rows found. Paste a header row followed by at least one row.');
  }
  if (parsed.rows.length > config.maxRows) {
    throw new ApiError(413, `Too many rows (${parsed.rows.length}). Import at most ${config.maxRows} rows at a time.`);
  }
  if (parsed.headers.length > config.maxColumns) {
    throw new ApiError(413, `Too many columns (${parsed.headers.length}). At most ${config.maxColumns} are supported.`);
  }
  return parsed;
};

/** Checks a column mapping against the parsed headers. Returns an errors object. */
export const validateMapping = (mapping, headers) => {
  const errors = {};
  if (!Array.isArray(mapping) || mapping.length !== headers.length) {
    return { mapping: `Provide a mapping for each of the ${headers.length} columns.` };
  }
  const seen = new Map();
  mapping.forEach((entry, i) => {
    const target = entry?.target;
    if (target === 'ignore') return;
    if (target === 'custom') {
      if (!sanitizeCustomFieldKey(entry.customName ?? headers[i])) errors[`column${i}`] = 'Custom field name is required.';
      return;
    }
    if (!LEAD_FIELD_KEYS.includes(target)) {
      errors[`column${i}`] = `Unknown target for column "${headers[i]}".`;
      return;
    }
    if (seen.has(target)) {
      errors[`column${i}`] = `${FIELD_LABELS.get(target)} is already mapped to column "${headers[seen.get(target)]}".`;
    }
    seen.set(target, i);
  });
  if (!seen.has('businessName')) errors.businessName = 'Map a column to Business Name.';
  return errors;
};

/**
 * Converts one row into lead values using the mapping. Invalid optional values are kept
 * as custom fields (with a warning) so nothing typed by the user is lost.
 */
const mapRow = (cells, headers, mapping) => {
  const values = {};
  const customFields = {};
  const warnings = [];

  for (let i = 0; i < cells.length; i += 1) {
    const raw = cells[i];
    const { target, customName } = mapping[i];
    if (target === 'ignore' || raw === '') continue;
    if (raw.length > config.maxCellLength) {
      return { error: `Value in "${headers[i]}" is longer than ${config.maxCellLength} characters.` };
    }
    if (target === 'custom') {
      customFields[sanitizeCustomFieldKey(customName ?? headers[i])] = raw;
      continue;
    }
    const { value, error } = normalizeFieldValue(target, raw);
    if (error && target === 'businessName') return { error };
    if (error) {
      warnings.push(`${FIELD_LABELS.get(target)}: ${error} Kept as custom field "${headers[i]}".`);
      customFields[sanitizeCustomFieldKey(headers[i])] = raw;
      // Recognised services from a partly-valid list are still applied.
      if (Array.isArray(value) && value.length > 0) values[target] = value;
      continue;
    }
    values[target] = value;
  }

  if (!values.businessName) return { error: 'Business Name is empty.' };
  if (Object.keys(customFields).length > maxCustomFields) {
    return { error: `More than ${maxCustomFields} custom fields in one row.` };
  }
  if (Object.values(customFields).some((v) => v.length > customFieldValueMaxLength)) {
    return { error: `A custom field value is longer than ${customFieldValueMaxLength} characters.` };
  }
  return { values: { ...values, customFields }, warnings };
};

/** Loads existing leads matching any row's duplicate keys in three indexed queries. */
const loadExistingByKey = async (rows) => {
  const collect = (key) => [...new Set(rows.map((r) => r.keys?.[key]).filter(Boolean))];
  const [websites, phones, nameCities] = [collect('website'), collect('phone'), collect('nameCity')];
  const or = [
    websites.length && { 'dedupe.website': { $in: websites } },
    phones.length && { 'dedupe.phone': { $in: phones } },
    nameCities.length && { 'dedupe.nameCity': { $in: nameCities } },
  ].filter(Boolean);
  const existing = or.length ? await SalesLead.find({ $or: or }).select('businessName dedupe archived') : [];

  const index = { website: new Map(), phone: new Map(), nameCity: new Map() };
  for (const lead of existing) {
    for (const key of Object.keys(index)) {
      const value = lead.dedupe?.[key];
      if (value && !index[key].has(value)) index[key].set(value, lead);
    }
  }
  return index;
};

const MATCH_LABELS = { website: 'website', phone: 'phone', nameCity: 'businessName+city' };
const KEY_ORDER = ['website', 'phone', 'nameCity'];

/** Maps every row and classifies it as new, duplicate (existing lead or earlier row) or error. */
const analyzeRows = async (parsed, mapping) => {
  const rows = parsed.rows.map(({ line, cells }) => {
    const result = mapRow(cells, parsed.headers, mapping);
    return result.error
      ? { line, status: 'error', message: result.error }
      : { line, status: 'new', values: result.values, warnings: result.warnings, keys: computeDedupeKeys(result.values) };
  });

  const existing = await loadExistingByKey(rows);
  const seenInFile = { website: new Map(), phone: new Map(), nameCity: new Map() };

  for (const row of rows) {
    if (row.status === 'error') continue;
    const existingMatch = KEY_ORDER.find((k) => row.keys[k] && existing[k].has(row.keys[k]));
    if (existingMatch) {
      const lead = existing[existingMatch].get(row.keys[existingMatch]);
      Object.assign(row, {
        status: 'duplicate',
        matchedOn: MATCH_LABELS[existingMatch],
        existingLead: { id: lead._id.toString(), businessName: lead.businessName, archived: lead.archived },
      });
      continue;
    }
    const fileMatch = KEY_ORDER.find((k) => row.keys[k] && seenInFile[k].has(row.keys[k]));
    if (fileMatch) {
      Object.assign(row, {
        status: 'duplicate',
        matchedOn: MATCH_LABELS[fileMatch],
        duplicateOfRow: seenInFile[fileMatch].get(row.keys[fileMatch]),
      });
      continue;
    }
    for (const k of KEY_ORDER) if (row.keys[k]) seenInFile[k].set(row.keys[k], row.line);
  }
  return rows;
};

const previewRow = (row) => ({
  row: row.line,
  status: row.status,
  message: row.message ?? null,
  matchedOn: row.matchedOn ?? null,
  existingLead: row.existingLead ?? null,
  duplicateOfRow: row.duplicateOfRow ?? null,
  warnings: row.warnings ?? [],
  values: row.values
    ? Object.fromEntries(Object.entries(row.values).filter(([, v]) => v !== null && v !== '' && !(Array.isArray(v) && !v.length)))
    : null,
});

const countBy = (rows, status) => rows.filter((r) => r.status === status).length;

/** Parses content and reports what an import would do. Never writes to the database. */
export const previewImport = async ({ content, format, hasHeader, mapping }) => {
  const parsed = parseOrThrow({ content, format, hasHeader });
  const suggestedMapping = suggestMapping(parsed.headers, parsed.hasHeader);
  const effectiveMapping = mapping ?? suggestedMapping;
  const mappingErrors = validateMapping(effectiveMapping, parsed.headers);

  const base = {
    delimiter: parsed.delimiter,
    hasHeader: parsed.hasHeader,
    rowCount: parsed.rows.length,
    columns: parsed.headers.map((header, index) => ({
      index,
      header,
      samples: parsed.rows.slice(0, 3).map((r) => r.cells[index]),
    })),
    suggestedMapping,
    mapping: effectiveMapping,
    mappingErrors,
    sampleRows: parsed.rows.slice(0, config.previewRows).map((r) => ({ row: r.line, cells: r.cells })),
    warnings: parsed.warnings,
  };
  if (Object.keys(mappingErrors).length > 0) return { ...base, analysis: null };

  const rows = await analyzeRows(parsed, effectiveMapping);
  return {
    ...base,
    analysis: {
      newRows: countBy(rows, 'new'),
      duplicates: countBy(rows, 'duplicate'),
      errors: countBy(rows, 'error'),
      warnings: rows.reduce((n, r) => n + (r.warnings?.length ?? 0), 0),
      rows: rows.slice(0, config.previewRows).map(previewRow),
      issues: rows.filter((r) => r.status !== 'new').slice(0, config.maxReportedIssues).map(previewRow),
    },
  };
};

/** Merges imported values into an existing lead: imported non-empty values win, lists are combined. */
const mergeInto = (lead, values) => {
  for (const [key, value] of Object.entries(values)) {
    if (key === 'customFields') {
      for (const [k, v] of Object.entries(value)) lead.customFields.set(k, v);
    } else if (key === 'tags' || key === 'potentialServices') {
      lead[key] = [...new Set([...lead[key], ...value])];
    } else if (key === 'notes') {
      if (value) lead.notes = lead.notes ? `${lead.notes}\n\n${value}` : value;
    } else if (value !== null && value !== '') {
      lead[key] = value;
    }
  }
};

/**
 * Imports rows. Duplicates of existing leads are skipped or merged (duplicateMode);
 * duplicates within the same import are always skipped. Every row is accounted for:
 * inserted + updated + skipped + errors = totalRows.
 */
export const runImport = async ({ content, format, hasHeader, mapping, duplicateMode, method, fileName }, adminId) => {
  const parsed = parseOrThrow({ content, format, hasHeader });
  const mappingErrors = validateMapping(mapping, parsed.headers);
  if (Object.keys(mappingErrors).length > 0) throw new ApiError(400, 'Invalid column mapping', mappingErrors);

  const rows = await analyzeRows(parsed, mapping);
  const sourceDetail = method === 'csv' && fileName ? `CSV file: ${fileName}` : IMPORT_SOURCE_DETAIL[method];

  const toInsert = rows.filter((r) => r.status === 'new');
  if (toInsert.length > 0) {
    await SalesLead.insertMany(
      toInsert.map((r) => ({
        ...r.values,
        status: r.values.status ?? 'NEW',
        source: 'CSV_IMPORT',
        sourceDetail,
        createdBy: adminId,
        dedupe: r.keys,
      })),
      { ordered: true },
    );
  }

  const mergeable = duplicateMode === 'update' ? rows.filter((r) => r.status === 'duplicate' && r.existingLead) : [];
  const updatedIds = new Set();
  for (const row of mergeable) {
    const lead = await SalesLead.findById(row.existingLead.id);
    if (!lead) continue;
    mergeInto(lead, row.values);
    await lead.save();
    row.action = 'updated';
    updatedIds.add(row.line);
  }

  const duplicates = rows.filter((r) => r.status === 'duplicate');
  const errors = rows.filter((r) => r.status === 'error');
  const limit = config.maxReportedIssues;
  return {
    totalRows: rows.length,
    inserted: toInsert.length,
    updated: updatedIds.size,
    skipped: duplicates.length - updatedIds.size,
    duplicates: duplicates.length,
    errorCount: errors.length,
    errors: errors.slice(0, limit).map((r) => ({ row: r.line, message: r.message })),
    duplicateRows: duplicates.slice(0, limit).map((r) => ({
      row: r.line,
      matchedOn: r.matchedOn,
      existingLead: r.existingLead ?? null,
      duplicateOfRow: r.duplicateOfRow ?? null,
      action: r.action ?? 'skipped',
    })),
    warnings: rows
      .flatMap((r) => (r.warnings ?? []).map((message) => ({ row: r.line, message })))
      .slice(0, limit),
  };
};