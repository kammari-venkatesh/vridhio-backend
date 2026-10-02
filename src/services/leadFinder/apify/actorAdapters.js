/**
 * Adapters translate between Lead Finder job params and a specific Apify Actor's
 * input/output contract. Swapping Actors means adding an adapter here and setting
 * APIFY_ACTOR_ADAPTER; nothing else in the system knows Actor field names.
 *
 * Adapter shape:
 *   buildInput(params, { limit }) -> Actor input object
 *   mapItem(item, params)         -> provider record (NormalizedBusiness shape) or null when malformed
 */

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const text = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return null;
  return value.trim() || null;
};

const coordinate = (value) => {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) ? number : null;
};

/**
 * Google Maps places Actor contract (Apify Store "Google Maps Scraper",
 * compass/crawler-google-places, and Actors with the same input/output schema).
 *
 * Input:  searchStringsArray, maxCrawledPlacesPerSearch, language, and the search area:
 *         - with a resolved centre: customGeolocation { type: 'Point', coordinates: [lng, lat], radiusKm }
 *           (locationQuery is omitted because it would take priority over the custom area);
 *         - without one: locationQuery (the named area; no radius).
 *         Every paid add-on is off, including skipClosedPlaces ($0.001/place "filter-applied" event):
 *         items carry permanentlyClosed anyway, so closed places are excluded by the worker instead.
 * Output: one item per place with placeId, title, categoryName, categories, searchString, address,
 *         city, state, countryCode, phone, phoneUnformatted, website, url, location { lat, lng },
 *         permanentlyClosed, temporarilyClosed.
 */
export const mapApifyBusiness = (item, { categories = [] } = {}) => {
  if (!isPlainObject(item)) return null;

  // Google Place IDs are stable across searches; without one the item cannot be deduplicated.
  const sourceId = text(item.placeId);
  const businessName = text(item.title);
  if (!sourceId || !businessName) return null;

  const searchString = text(item.searchString)?.toLowerCase();
  const matchedCategory = categories.find((c) => c.toLowerCase() === searchString) ?? null;
  const categoryName = text(item.categoryName);
  const itemCategories = Array.isArray(item.categories) ? item.categories.map(text).filter(Boolean) : [];
  const location = isPlainObject(item.location) ? item.location : {};

  return {
    sourceId,
    businessName,
    category: matchedCategory ?? categoryName ?? itemCategories[0] ?? null,
    categories: [...new Set([categoryName, ...itemCategories].filter(Boolean))],
    address: text(item.address),
    city: text(item.city),
    state: text(item.state),
    country: text(item.countryCode),
    phone: text(item.phone) ?? text(item.phoneUnformatted),
    website: text(item.website),
    googleMapsUrl: text(item.url),
    latitude: coordinate(location.lat),
    longitude: coordinate(location.lng),
    permanentlyClosed: typeof item.permanentlyClosed === 'boolean' ? item.permanentlyClosed : null,
  };
};

const searchArea = ({ location, radius, center }) =>
  center
    ? { customGeolocation: { type: 'Point', coordinates: [center.longitude, center.latitude], radiusKm: radius } }
    : { locationQuery: location };

const googleMapsAdapter = Object.freeze({
  id: 'google-maps',
  buildInput: (params, { limit }) => ({
    searchStringsArray: [...params.categories],
    ...searchArea(params),
    maxCrawledPlacesPerSearch: Math.max(1, Math.ceil(limit / Math.max(1, params.categories.length))),
    language: 'en',
    skipClosedPlaces: false,
    scrapePlaceDetailPage: false,
    scrapeContacts: false,
    scrapeDirectories: false,
    scrapeTableReservationProvider: false,
    scrapeOrderOnline: false,
    includeWebResults: false,
    maxReviews: 0,
    maxImages: 0,
    maxQuestions: 0,
    maximumLeadsEnrichmentRecords: 0,
    verifyLeadsEnrichmentEmails: false,
    enableCompetitorAnalysis: false,
  }),
  mapItem: mapApifyBusiness,
});

export const ACTOR_ADAPTERS = Object.freeze({ [googleMapsAdapter.id]: googleMapsAdapter });

export const getActorAdapter = (id) => ACTOR_ADAPTERS[id] ?? null;
