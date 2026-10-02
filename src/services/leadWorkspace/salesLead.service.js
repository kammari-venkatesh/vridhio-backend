import mongoose from 'mongoose';
import {
  leadWorkspaceConfig,
  SALES_LEAD_SOURCES,
  SALES_LEAD_STATUSES,
  SALES_SERVICES,
} from '../../config/leadWorkspace.js';
import { AdminUser } from '../../models/adminUser.model.js';
import { LeadFinderJob } from '../../models/leadFinderJob.model.js';
import { Prospect } from '../../models/prospect.model.js';
import { SalesLead } from '../../models/salesLead.model.js';
import { ApiError } from '../../utils/ApiError.js';
import { computeDedupeKeys, LEAD_FIELDS, normalizeCustomFields, normalizeFieldValue } from './leadFields.js';

const NOT_FOUND = 'Lead not found';
const DUPLICATE_KEY = 11000;
const CASE_INSENSITIVE = { locale: 'en', strength: 2 };

const customFieldsObject = (value) =>
  value instanceof Map ? Object.fromEntries(value) : { ...(value ?? {}) };

/** Public shape of a sales lead; duplicate keys and provider internals stay server-side. */
export const toSalesLeadDto = (lead) => {
  const assigned = lead.assignedTo;
  return {
    id: lead._id.toString(),
    businessName: lead.businessName,
    category: lead.category,
    contactName: lead.contactName,
    phone: lead.phone,
    email: lead.email,
    website: lead.website,
    address: lead.address,
    city: lead.city,
    state: lead.state,
    country: lead.country,
    googleMapsUrl: lead.googleMapsUrl,
    source: lead.source,
    sourceDetail: lead.sourceDetail,
    sourceId: lead.sourceId,
    prospectId: lead.prospectId ? lead.prospectId.toString() : null,
    potentialServices: [...lead.potentialServices],
    status: lead.status,
    tags: [...lead.tags],
    notes: lead.notes,
    customFields: customFieldsObject(lead.customFields),
    assignedTo: assigned?.email
      ? { id: assigned._id.toString(), email: assigned.email }
      : assigned
        ? { id: assigned.toString(), email: null }
        : null,
    archived: lead.archived,
    createdAt: lead.createdAt,
    updatedAt: lead.updatedAt,
  };
};

const isObjectId = (id) => typeof id === 'string' && mongoose.isValidObjectId(id) && /^[a-f0-9]{24}$/i.test(id);

export const findLeadOrThrow = async (leadId) => {
  const lead = isObjectId(leadId) ? await SalesLead.findById(leadId).populate('assignedTo', 'email') : null;
  if (!lead) throw new ApiError(404, NOT_FOUND);
  return lead;
};

/**
 * Finds an existing lead that is an obvious duplicate of `candidate`, checking in priority
 * order: prospectId, provider sourceId, website, phone, then business name + city.
 * Returns { lead, matchedOn } or null. Archived leads count, so they are not re-created.
 */
export const findDuplicate = async (candidate, { excludeId } = {}) => {
  const keys = computeDedupeKeys(candidate);
  // With no website, phone or city there is nothing else to compare, so the same business
  // name on another lead that also has none of them is treated as the same business.
  const nameOnly = !keys.website && !keys.phone && !keys.nameCity && candidate.businessName;
  const checks = [
    candidate.prospectId && ['prospect', { prospectId: candidate.prospectId }],
    candidate.sourceId && ['sourceId', { sourceProvider: candidate.sourceProvider ?? null, sourceId: candidate.sourceId }],
    keys.website && ['website', { 'dedupe.website': keys.website }],
    keys.phone && ['phone', { 'dedupe.phone': keys.phone }],
    keys.nameCity && ['businessName+city', { 'dedupe.nameCity': keys.nameCity }],
    nameOnly && [
      'businessName',
      { businessName: candidate.businessName, 'dedupe.website': null, 'dedupe.phone': null, 'dedupe.nameCity': null },
    ],
  ].filter(Boolean);

  for (const [matchedOn, filter] of checks) {
    const query = excludeId ? { ...filter, _id: { $ne: excludeId } } : filter;
    const find = SalesLead.findOne(query);
    if (matchedOn === 'businessName') find.collation(CASE_INSENSITIVE);
    const lead = await find.populate('assignedTo', 'email');
    if (lead) return { lead, matchedOn };
  }
  return null;
};

const MATCH_WORDING = { 'businessName+city': 'business name and city', businessName: 'business name' };

const duplicateMessage = ({ lead, matchedOn }) =>
  `A lead with the same ${MATCH_WORDING[matchedOn] ?? matchedOn} already exists: ${lead.businessName}${lead.archived ? ' (archived)' : ''}.`;

const duplicateError = (duplicate) =>
  new ApiError(409, duplicateMessage(duplicate), {
    existingLeadId: duplicate.lead._id.toString(),
    matchedOn: duplicate.matchedOn,
  });

const EDITABLE_FIELDS = new Set([...LEAD_FIELDS.map((f) => f.key), 'customFields', 'assignedTo']);

/**
 * Validates an edit/create payload strictly. Unknown keys are rejected so typos are not
 * silently ignored. Returns normalised values or throws a 400 with per-field errors.
 */
export const parseLeadInput = async (body, { partial }) => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'Invalid request body');
  const errors = {};
  const values = {};

  for (const key of Object.keys(body)) {
    if (!EDITABLE_FIELDS.has(key)) errors[key] = 'This field cannot be set.';
  }

  for (const field of LEAD_FIELDS) {
    if (!(field.key in body)) continue;
    const { value, error } = normalizeFieldValue(field.key, body[field.key]);
    if (error) errors[field.key] = error;
    else values[field.key] = value;
  }
  if ('status' in values && values.status === null) errors.status = 'Status is required.';
  if (!partial && !values.businessName) errors.businessName = 'Business name is required.';
  if (partial && 'businessName' in body && !values.businessName) errors.businessName = 'Business name is required.';

  if ('customFields' in body) {
    const { value, error } = normalizeCustomFields(body.customFields);
    if (error) errors.customFields = error;
    else values.customFields = value;
  }

  if ('assignedTo' in body) {
    if (body.assignedTo === null || body.assignedTo === '') values.assignedTo = null;
    else if (!isObjectId(body.assignedTo) || !(await AdminUser.exists({ _id: body.assignedTo, disabled: { $ne: true } }))) {
      errors.assignedTo = 'Choose a valid admin user.';
    } else values.assignedTo = body.assignedTo;
  }

  if (Object.keys(errors).length > 0) throw new ApiError(400, 'Validation failed', errors);
  return values;
};

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SEARCH_FIELDS = ['businessName', 'category', 'phone', 'email', 'website', 'city', 'state', 'address', 'contactName'];

/** Builds the MongoDB filter from validated list/export query parameters. */
export const buildLeadFilter = ({ search, status, source, category, tag, service, city, archived, assignedTo }) => {
  const filter = {};
  if (archived === 'only') filter.archived = true;
  else if (archived !== 'all') filter.archived = false;
  if (status) filter.status = status;
  if (source) filter.source = source;
  if (category) filter.category = category;
  if (city) filter.city = city;
  if (tag) filter.tags = tag;
  if (service) filter.potentialServices = service;
  if (assignedTo === 'none') filter.assignedTo = null;
  else if (assignedTo) filter.assignedTo = assignedTo;

  if (search) {
    const pattern = new RegExp(escapeRegex(search), 'i');
    const or = SEARCH_FIELDS.map((field) => ({ [field]: pattern }));
    const digits = search.replace(/\D/g, '');
    if (digits.length >= 4) or.push({ 'dedupe.phone': new RegExp(digits) });
    filter.$or = or;
  }
  return filter;
};

const sortSpec = ({ sortBy, sortOrder }) => {
  const field = leadWorkspaceConfig.sortFields[sortBy] ?? 'createdAt';
  const direction = sortOrder === 'asc' ? 1 : -1;
  return { [field]: direction, _id: direction };
};

export const listLeads = async (query) => {
  const { page, limit } = query;
  const filter = buildLeadFilter(query);
  const [leads, total] = await Promise.all([
    SalesLead.find(filter)
      .collation(CASE_INSENSITIVE)
      .sort(sortSpec(query))
      .skip((page - 1) * limit)
      .limit(limit)
      .populate('assignedTo', 'email'),
    SalesLead.countDocuments(filter).collation(CASE_INSENSITIVE),
  ]);
  return {
    items: leads.map(toSalesLeadDto),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
};

export const getLead = async (leadId) => {
  const lead = await findLeadOrThrow(leadId);
  const prospect = lead.prospectId ? await Prospect.findById(lead.prospectId).select('jobId') : null;
  return {
    ...toSalesLeadDto(lead),
    prospect: prospect ? { id: prospect._id.toString(), jobId: prospect.jobId.toString() } : null,
  };
};

export const createLead = async (body, adminId) => {
  const values = await parseLeadInput(body, { partial: false });
  const duplicate = await findDuplicate(values);
  if (duplicate) throw duplicateError(duplicate);

  const lead = await SalesLead.create({
    ...values,
    status: values.status ?? 'NEW',
    source: 'MANUAL',
    sourceDetail: 'Added manually',
    createdBy: adminId,
  });
  return toSalesLeadDto(await lead.populate('assignedTo', 'email'));
};

/** Duplicate keys used to spot the same business twice within one batch. */
const batchKeys = (values) => {
  const keys = computeDedupeKeys(values);
  const list = Object.entries(keys)
    .filter(([, v]) => v)
    .map(([k, v]) => [k === 'nameCity' ? 'businessName+city' : k, `${k}:${v}`]);
  if (list.length === 0) list.push(['businessName', `name:${values.businessName.toLowerCase()}`]);
  return list;
};

/**
 * Creates leads from rows pasted into the workspace table. Each row is validated and
 * checked for duplicates on its own (against existing leads and earlier rows in the
 * batch), so one bad row never blocks the others, and pasting the same rows again
 * creates nothing new. Rows are processed in order; results keep each row's clientId.
 */
export const createLeadsBatch = async (rows, adminId) => {
  const seen = new Map();
  const results = [];
  for (const { clientId, values: body } of rows) {
    let values;
    try {
      values = await parseLeadInput(body, { partial: false });
    } catch (err) {
      if (!(err instanceof ApiError) || err.statusCode !== 400) throw err;
      results.push({ clientId, status: 'invalid', message: err.message, errors: err.details ?? {} });
      continue;
    }

    const keys = batchKeys(values);
    const repeat = keys.find(([, key]) => seen.has(key));
    if (repeat) {
      results.push({
        clientId,
        status: 'duplicate',
        matchedOn: repeat[0],
        duplicateOfClientId: seen.get(repeat[1]),
        message: 'Same business as an earlier pasted row.',
      });
      continue;
    }
    keys.forEach(([, key]) => seen.set(key, clientId));

    const duplicate = await findDuplicate(values);
    if (duplicate) {
      results.push({
        clientId,
        status: 'duplicate',
        matchedOn: duplicate.matchedOn,
        existingLead: {
          id: duplicate.lead._id.toString(),
          businessName: duplicate.lead.businessName,
          archived: duplicate.lead.archived,
        },
        message: duplicateMessage(duplicate),
      });
      continue;
    }

    const lead = await SalesLead.create({
      ...values,
      status: values.status ?? 'NEW',
      source: 'MANUAL',
      sourceDetail: 'Pasted into the lead table',
      createdBy: adminId,
    });
    results.push({ clientId, status: 'created', lead: toSalesLeadDto(lead) });
  }

  const count = (status) => results.filter((r) => r.status === status).length;
  return { results, created: count('created'), duplicates: count('duplicate'), invalid: count('invalid') };
};

export const updateLead = async (leadId, body) => {
  const lead = await findLeadOrThrow(leadId);
  const values = await parseLeadInput(body, { partial: true });

  const identityChanged = ['businessName', 'city', 'website', 'phone'].some((k) => k in values);
  if (identityChanged) {
    const merged = { ...lead.toObject(), ...values, prospectId: null, sourceId: null };
    const duplicate = await findDuplicate(merged, { excludeId: lead._id });
    if (duplicate) throw duplicateError(duplicate);
  }

  lead.set(values);
  await lead.save();
  return toSalesLeadDto(await lead.populate('assignedTo', 'email'));
};

export const archiveLead = async (leadId) => {
  const lead = await findLeadOrThrow(leadId);
  if (!lead.archived) {
    lead.archived = true;
    lead.archivedAt = new Date();
    await lead.save();
  }
  return toSalesLeadDto(lead);
};

/** One request for many leads. `value` has already been validated for the operation. */
export const bulkUpdateLeads = async ({ ids, operation, value }) => {
  const { maxTags, maxServices } = leadWorkspaceConfig.limits;
  if (operation === 'assign' && value !== null && !(await AdminUser.exists({ _id: value, disabled: { $ne: true } }))) {
    throw new ApiError(400, 'Validation failed', { value: 'Choose a valid admin user.' });
  }
  const base = { _id: { $in: ids } };
  const operations = {
    status: () => [base, { $set: { status: value } }],
    addTag: () => [{ ...base, [`tags.${maxTags - 1}`]: { $exists: false } }, { $addToSet: { tags: value } }],
    removeTag: () => [base, { $pull: { tags: value } }],
    addService: () => [
      { ...base, [`potentialServices.${maxServices - 1}`]: { $exists: false } },
      { $addToSet: { potentialServices: value } },
    ],
    removeService: () => [base, { $pull: { potentialServices: value } }],
    assign: () => [base, { $set: { assignedTo: value } }],
    archive: () => [base, { $set: { archived: true, archivedAt: new Date() } }],
    unarchive: () => [base, { $set: { archived: false, archivedAt: null } }],
  };
  const [filter, update] = operations[operation]();
  const [found, result] = [await SalesLead.countDocuments(base), await SalesLead.updateMany(filter, update)];
  return { requested: ids.length, found, matched: result.matchedCount, modified: result.modifiedCount };
};

const EXPORT_COLUMNS = [
  ['Business Name', 'businessName'],
  ['Category', 'category'],
  ['Contact Name', 'contactName'],
  ['Phone', 'phone'],
  ['Email', 'email'],
  ['Website', 'website'],
  ['Address', 'address'],
  ['City', 'city'],
  ['State', 'state'],
  ['Country', 'country'],
  ['Google Maps', 'googleMapsUrl'],
  ['Status', 'status'],
  ['Service Needed', (l) => l.potentialServices.join('; ')],
  ['Tags', (l) => l.tags.join('; ')],
  ['Source', 'source'],
  ['Source Detail', 'sourceDetail'],
  ['Assigned To', (l) => l.assignedTo?.email ?? ''],
  ['Notes', 'notes'],
  ['Archived', (l) => (l.archived ? 'yes' : 'no')],
  ['Created At', (l) => l.createdAt.toISOString()],
  ['Updated At', (l) => l.updatedAt.toISOString()],
];

const PHONE_LIKE = /^[+-][\d\s()-]+$/;
/** Quotes a CSV cell and neutralises spreadsheet formula injection. */
export const csvCell = (raw) => {
  let text = raw === null || raw === undefined ? '' : String(raw);
  if (/^[=@\t\r]/.test(text) || (/^[+-]/.test(text) && !PHONE_LIKE.test(text))) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/** CSV of every lead matching the filters (capped), including custom field columns. */
export const exportLeadsCsv = async (query) => {
  const { maxRows } = leadWorkspaceConfig.export;
  const leads = await SalesLead.find(buildLeadFilter(query))
    .collation(CASE_INSENSITIVE)
    .sort(sortSpec(query))
    .limit(maxRows + 1)
    .populate('assignedTo', 'email')
    .lean();
  const truncated = leads.length > maxRows;
  const rows = truncated ? leads.slice(0, maxRows) : leads;

  const customKeys = [...new Set(rows.flatMap((l) => Object.keys(l.customFields ?? {})))].sort();
  const header = [...EXPORT_COLUMNS.map(([label]) => label), ...customKeys];
  const lines = rows.map((lead) =>
    [
      ...EXPORT_COLUMNS.map(([, get]) => (typeof get === 'function' ? get(lead) : lead[get])),
      ...customKeys.map((k) => lead.customFields?.[k] ?? ''),
    ]
      .map(csvCell)
      .join(','),
  );
  return { csv: `\uFEFF${[header.map(csvCell).join(','), ...lines].join('\r\n')}\r\n`, count: rows.length, truncated };
};

const isDuplicateKeyError = (err) => err?.code === DUPLICATE_KEY;

/**
 * Turns a Lead Finder prospect into a sales lead, or returns the lead that already
 * represents it. The prospect itself is never modified.
 */
export const promoteProspect = async (prospectId, adminId) => {
  const prospect = isObjectId(prospectId) ? await Prospect.findById(prospectId) : null;
  if (!prospect) throw new ApiError(404, 'Prospect not found');
  return promoteProspectRecord(prospect, adminId);
};

// Businesses from the built-in test data provider are labelled so they are easy to filter out.
const TEST_DATA_SOURCE = 'fake';
const TEST_DATA_TAG = 'test-data';

const promoteProspectRecord = async (prospect, adminId, { searchLocation } = {}) => {
  let city = prospect.city;
  if (!city) {
    const location =
      searchLocation ?? (await LeadFinderJob.findById(prospect.jobId).select('params.location'))?.params?.location;
    city = location?.split(',')[0]?.trim() || null;
  }
  const isTestData = prospect.source === TEST_DATA_SOURCE;
  const candidate = {
    businessName: prospect.businessName,
    category: prospect.category,
    phone: prospect.phone,
    website: prospect.website,
    address: prospect.address,
    city,
    state: prospect.state ?? null,
    country: prospect.country ?? null,
    googleMapsUrl: prospect.googleMapsUrl,
    source: 'AI_DISCOVERY',
    sourceDetail: isTestData ? 'Lead Finder test data' : 'Lead Finder discovery',
    sourceProvider: prospect.source,
    sourceId: prospect.sourceId,
    prospectId: prospect._id,
  };

  const existing = await findDuplicate(candidate);
  if (existing) {
    const { lead, matchedOn } = existing;
    // Link a manually added or imported lead to the prospect it matches.
    if (!lead.prospectId && matchedOn !== 'prospect') {
      lead.prospectId = prospect._id;
      try {
        await lead.save();
      } catch (err) {
        if (!isDuplicateKeyError(err)) throw err;
      }
    }
    return { lead: toSalesLeadDto(lead), created: false, matchedOn };
  }

  try {
    const lead = await SalesLead.create({
      ...candidate,
      status: 'NEW',
      tags: isTestData ? [TEST_DATA_TAG] : [],
      createdBy: adminId,
    });
    return { lead: toSalesLeadDto(lead), created: true, matchedOn: null };
  } catch (err) {
    // Two promotions of the same prospect at once: the unique index lets only one win.
    if (!isDuplicateKeyError(err)) throw err;
    const lead = await SalesLead.findOne({ prospectId: prospect._id }).populate('assignedTo', 'email');
    if (!lead) throw err;
    return { lead: toSalesLeadDto(lead), created: false, matchedOn: 'prospect' };
  }
};

/**
 * Makes discovered businesses appear in the Lead Workspace: each prospect not yet
 * represented by a sales lead is promoted (or linked to the matching existing lead).
 * Idempotent, so re-discovering a business never creates a second lead.
 * Returns how many leads were created and linked.
 */
export const addProspectsToWorkspace = async (prospects, adminId, { searchLocation } = {}) => {
  if (prospects.length === 0) return { created: 0, linked: 0 };
  const represented = new Set(
    (await SalesLead.find({ prospectId: { $in: prospects.map((p) => p._id) } }).select('prospectId')).map((l) =>
      l.prospectId.toString(),
    ),
  );
  let created = 0;
  let linked = 0;
  for (const prospect of prospects) {
    if (represented.has(prospect._id.toString())) continue;
    const result = await promoteProspectRecord(prospect, adminId, { searchLocation });
    if (result.created) created += 1;
    else linked += 1;
  }
  return { created, linked };
};

/** Adds `salesLeadId` to prospect DTOs so the discovery UI can show "Added". */
export const attachSalesLeadIds = async (prospects) => {
  if (prospects.length === 0) return prospects;
  const leads = await SalesLead.find({ prospectId: { $in: prospects.map((p) => p.id) } }).select('prospectId');
  const byProspect = new Map(leads.map((l) => [l.prospectId.toString(), l._id.toString()]));
  return prospects.map((p) => ({ ...p, salesLeadId: byProspect.get(p.id) ?? null }));
};

/** Vocabulary and filter options for the workspace UI. */
export const getWorkspaceMeta = async () => {
  const active = { archived: false };
  const [admins, categories, cities, tags] = await Promise.all([
    AdminUser.find({ disabled: { $ne: true } }).select('email').sort({ email: 1 }),
    SalesLead.distinct('category', active),
    SalesLead.distinct('city', active),
    SalesLead.distinct('tags', active),
  ]);
  const clean = (values) => values.filter(Boolean).sort((a, b) => a.localeCompare(b));
  return {
    statuses: SALES_LEAD_STATUSES,
    sources: SALES_LEAD_SOURCES,
    services: SALES_SERVICES,
    fields: LEAD_FIELDS.map(({ key, label, required = false }) => ({ key, label, required })),
    sortFields: Object.keys(leadWorkspaceConfig.sortFields),
    admins: admins.map((a) => ({ id: a._id.toString(), email: a.email })),
    facets: { categories: clean(categories), cities: clean(cities), tags: clean(tags) },
    limits: { ...leadWorkspaceConfig.limits, ...leadWorkspaceConfig.import, pageSize: leadWorkspaceConfig.pagination },
  };
};
