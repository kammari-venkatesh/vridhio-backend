import { leadFinderConfig } from '../config/leadFinder.js';

const { limits } = leadFinderConfig;
// Letters (any script), digits, spaces and common address punctuation.
const SAFE_TEXT = /^[\p{L}\p{N}\s.,'&()/-]+$/u;

const isSafeText = (value, min, max) =>
  typeof value === 'string' && value.trim().length >= min && value.trim().length <= max && SAFE_TEXT.test(value.trim());

const JOB_FIELDS = new Set(['location', 'radius', 'categories', 'maxBusinesses', 'provider', 'confirmRealSearch']);
export const SEARCH_PROVIDERS = ['test', 'apify'];

/**
 * `provider` defaults to "test". A real ("apify") search must also carry confirmRealSearch: true.
 * Anything else in the body (including credentials) is rejected; provider settings are server-side only.
 */
export const validateJobParams = (body = {}) => {
  const errors = {};

  for (const key of Object.keys(body ?? {})) {
    if (!JOB_FIELDS.has(key)) errors[key] = 'This field is not allowed.';
  }

  const provider = body.provider === undefined ? 'test' : body.provider;
  if (!SEARCH_PROVIDERS.includes(provider)) {
    errors.provider = 'Choose a search mode: "test" or "apify".';
  } else if (provider === 'apify' && body.confirmRealSearch !== true) {
    errors.confirmRealSearch = 'Confirm that this real search uses Apify credits.';
  }
  if (body.confirmRealSearch !== undefined && typeof body.confirmRealSearch !== 'boolean') {
    errors.confirmRealSearch = 'confirmRealSearch must be true or false.';
  }

  const location = typeof body.location === 'string' ? body.location.trim().replace(/\s+/g, ' ') : '';
  if (!isSafeText(location, 2, limits.locationMaxLength)) {
    errors.location = `Enter a location (2–${limits.locationMaxLength} characters, letters, numbers and basic punctuation).`;
  }

  const { radius } = body;
  if (typeof radius !== 'number' || !Number.isFinite(radius) || radius <= 0 || radius > limits.maxRadiusKm) {
    errors.radius = `Radius must be a number greater than 0 and at most ${limits.maxRadiusKm} km.`;
  }

  let categories = [];
  if (!Array.isArray(body.categories) || body.categories.length === 0) {
    errors.categories = 'Select at least one business category.';
  } else if (body.categories.length > limits.maxCategories) {
    errors.categories = `Select at most ${limits.maxCategories} categories.`;
  } else if (!body.categories.every((c) => isSafeText(c, 2, limits.categoryMaxLength))) {
    errors.categories = `Each category must be 2–${limits.categoryMaxLength} characters of letters, numbers and basic punctuation.`;
  } else {
    const seen = new Set();
    categories = body.categories
      .map((c) => c.trim().replace(/\s+/g, ' '))
      .filter((c) => !seen.has(c.toLowerCase()) && seen.add(c.toLowerCase()));
  }

  const maxBusinesses = body.maxBusinesses ?? limits.defaultMaxBusinesses;
  if (!Number.isInteger(maxBusinesses) || maxBusinesses < 1 || maxBusinesses > limits.maxBusinesses) {
    errors.maxBusinesses = `Maximum businesses must be a whole number from 1 to ${limits.maxBusinesses}.`;
  }

  return {
    params: { location, radius, categories, maxBusinesses },
    provider,
    errors,
    isValid: Object.keys(errors).length === 0,
  };
};

const MAX_PAGE = 10_000;

export const validatePagination = (query = {}, { defaultLimit, maxLimit }) => {
  const errors = {};
  const page = query.page === undefined ? 1 : Number(query.page);
  const limit = query.limit === undefined ? defaultLimit : Number(query.limit);

  if (!Number.isInteger(page) || page < 1 || page > MAX_PAGE) errors.page = 'page must be a positive whole number.';
  if (!Number.isInteger(limit) || limit < 1 || limit > maxLimit) {
    errors.limit = `limit must be a whole number from 1 to ${maxLimit}.`;
  }

  return { pagination: { page, limit }, errors, isValid: Object.keys(errors).length === 0 };
};
