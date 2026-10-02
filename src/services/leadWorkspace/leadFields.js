import {
  leadWorkspaceConfig,
  SALES_LEAD_STATUSES,
  SALES_SERVICES,
} from '../../config/leadWorkspace.js';

const { limits } = leadWorkspaceConfig;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Standard SalesLead fields that imports can map to and admins can edit.
 * `aliases` drive automatic column mapping (compared lowercase, punctuation-insensitive).
 */
export const LEAD_FIELDS = [
  {
    key: 'businessName',
    label: 'Business Name',
    required: true,
    maxLength: 200,
    aliases: ['business name', 'business', 'name', 'company', 'company name', 'shop', 'store', 'brand', 'organisation', 'organization'],
  },
  { key: 'category', label: 'Category', maxLength: 100, aliases: ['category', 'type', 'industry', 'business type', 'niche', 'sector'] },
  { key: 'contactName', label: 'Contact Name', maxLength: 120, aliases: ['contact name', 'contact person', 'contact', 'person'] },
  { key: 'phone', label: 'Phone', type: 'phone', maxLength: 40, aliases: ['phone', 'phone number', 'mobile', 'mobile number', 'contact number', 'tel', 'telephone', 'whatsapp', 'number'] },
  { key: 'email', label: 'Email', type: 'email', maxLength: 254, aliases: ['email', 'email address', 'e-mail', 'mail'] },
  { key: 'website', label: 'Website', type: 'url', maxLength: 500, aliases: ['website', 'website url', 'url', 'site', 'web', 'domain', 'web address'] },
  { key: 'address', label: 'Address', maxLength: 300, aliases: ['address', 'street address', 'full address', 'location address'] },
  { key: 'city', label: 'City', maxLength: 100, aliases: ['city', 'town'] },
  { key: 'state', label: 'State', maxLength: 100, aliases: ['state', 'province', 'region'] },
  { key: 'country', label: 'Country', maxLength: 100, aliases: ['country'] },
  { key: 'googleMapsUrl', label: 'Google Maps', type: 'url', maxLength: 1000, aliases: ['google maps', 'google maps url', 'maps', 'maps url', 'map link', 'gmaps'] },
  { key: 'potentialServices', label: 'Service Needed', type: 'services', aliases: ['service needed', 'services needed', 'potential services', 'services', 'service', 'potential service'] },
  { key: 'tags', label: 'Tags', type: 'tags', aliases: ['tags', 'tag', 'labels', 'label'] },
  { key: 'status', label: 'Status', type: 'status', aliases: ['status', 'stage', 'lead status'] },
  { key: 'notes', label: 'Notes', type: 'notes', aliases: ['notes', 'note', 'comments', 'comment', 'remarks'] },
];

export const LEAD_FIELD_KEYS = LEAD_FIELDS.map((f) => f.key);
const FIELD_BY_KEY = new Map(LEAD_FIELDS.map((f) => [f.key, f]));

const collapse = (value) => String(value).replace(/\s+/g, ' ').trim();
export const aliasKey = (text) => collapse(text).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const LIST_SEPARATOR = /[,;|\n]/;
const splitList = (value) =>
  (Array.isArray(value) ? value : String(value).split(LIST_SEPARATOR)).map((v) => collapse(v)).filter(Boolean);

const SERVICE_BY_KEY = new Map(SALES_SERVICES.map((s) => [aliasKey(s), s]));
const STATUS_BY_KEY = new Map(SALES_LEAD_STATUSES.map((s) => [aliasKey(s), s]));

export const canonicalService = (value) => SERVICE_BY_KEY.get(aliasKey(value)) ?? null;
export const canonicalStatus = (value) => STATUS_BY_KEY.get(aliasKey(value)) ?? null;

export const normalizeTag = (value) => collapse(value).toLowerCase();

/** Returns an absolute http(s) URL, adding https:// when the scheme is missing, or null. */
export const normalizeUrl = (raw) => {
  const text = collapse(raw);
  if (!text) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname.includes('.') && url.hostname !== 'localhost') return null;
    return url.href;
  } catch {
    return null;
  }
};

export const websiteKey = (website) => {
  const href = website ? normalizeUrl(website) : null;
  if (!href) return null;
  const url = new URL(href);
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.hostname.replace(/^www\./, '')}${path}`.toLowerCase();
};

/** Last 10 digits, so "+91 90000 00101" and "9000000101" match. */
export const phoneKey = (phone) => {
  const digits = String(phone ?? '').replace(/\D/g, '');
  if (digits.length < 6) return null;
  return digits.length > 10 ? digits.slice(-10) : digits;
};

const nameKey = (text) => aliasKey(text ?? '').replace(/ /g, '');

export const computeDedupeKeys = ({ businessName, city, website, phone }) => ({
  website: websiteKey(website),
  phone: phoneKey(phone),
  nameCity: businessName && city ? `${nameKey(businessName)}|${nameKey(city)}` : null,
});

/**
 * Normalises one standard field value.
 * Returns { value } on success or { error } with an admin-readable message.
 * Empty input yields the field's empty value (null, [] or '').
 */
export const normalizeFieldValue = (key, raw) => {
  const field = FIELD_BY_KEY.get(key);
  if (!field) return { error: 'Unknown field.' };
  const isEmpty = raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '');

  switch (field.type) {
    case 'services': {
      if (isEmpty) return { value: [] };
      const items = splitList(raw);
      const services = [...new Set(items.map(canonicalService).filter(Boolean))];
      const unknown = items.filter((s) => !canonicalService(s));
      if (unknown.length > 0) return { error: `Unknown service: ${unknown.join(', ')}.`, value: services };
      if (services.length > limits.maxServices) return { error: `At most ${limits.maxServices} services.` };
      return { value: services };
    }
    case 'tags': {
      if (isEmpty) return { value: [] };
      const tags = [...new Set(splitList(raw).map(normalizeTag))];
      if (tags.some((t) => t.length > limits.tagMaxLength)) {
        return { error: `Tags must be at most ${limits.tagMaxLength} characters.` };
      }
      if (tags.length > limits.maxTags) return { error: `At most ${limits.maxTags} tags.` };
      return { value: tags };
    }
    case 'status': {
      if (isEmpty) return { value: null };
      const status = canonicalStatus(String(raw));
      return status ? { value: status } : { error: `Unknown status "${collapse(raw)}".` };
    }
    case 'notes': {
      if (isEmpty) return { value: '' };
      if (typeof raw !== 'string') return { error: 'Notes must be text.' };
      const notes = raw.trim();
      if (notes.length > limits.notesMaxLength) return { error: `Notes must be at most ${limits.notesMaxLength} characters.` };
      return { value: notes };
    }
    default:
      break;
  }

  if (isEmpty) return { value: null };
  if (typeof raw !== 'string' && typeof raw !== 'number') return { error: `${field.label} must be text.` };
  const text = collapse(raw);
  if (text.length > field.maxLength) return { error: `${field.label} must be at most ${field.maxLength} characters.` };

  if (field.type === 'url') {
    const url = normalizeUrl(text);
    return url ? { value: url } : { error: `${field.label} is not a valid web address.` };
  }
  if (field.type === 'email') {
    const email = text.toLowerCase();
    return EMAIL_PATTERN.test(email) ? { value: email } : { error: 'Email is not a valid email address.' };
  }
  if (field.type === 'phone') {
    return phoneKey(text) ? { value: text } : { error: 'Phone must contain at least 6 digits.' };
  }
  return { value: text };
};

/** Custom field names cannot contain "." or start with "$" (MongoDB map keys). */
export const sanitizeCustomFieldKey = (key) =>
  collapse(key).replace(/\./g, '_').replace(/^\$+/, '').slice(0, limits.customFieldKeyMaxLength);

/**
 * Validates a customFields object. Returns { value: Map-ready object } or { error }.
 * Empty values are dropped.
 */
export const normalizeCustomFields = (raw) => {
  if (raw === null || raw === undefined) return { value: {} };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { error: 'Custom fields must be an object.' };
  const result = {};
  for (const [rawKey, rawValue] of Object.entries(raw)) {
    const key = sanitizeCustomFieldKey(rawKey);
    if (!key) return { error: 'Custom field names cannot be empty.' };
    if (rawValue === null || rawValue === undefined || rawValue === '') continue;
    if (typeof rawValue !== 'string' && typeof rawValue !== 'number' && typeof rawValue !== 'boolean') {
      return { error: `Custom field "${key}" must be text.` };
    }
    const value = String(rawValue).trim();
    if (value.length > limits.customFieldValueMaxLength) {
      return { error: `Custom field "${key}" must be at most ${limits.customFieldValueMaxLength} characters.` };
    }
    if (value) result[key] = value;
  }
  if (Object.keys(result).length > limits.maxCustomFields) {
    return { error: `At most ${limits.maxCustomFields} custom fields.` };
  }
  return { value: result };
};
