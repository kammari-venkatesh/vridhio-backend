import { leadFinderConfig } from '../../config/leadFinder.js';
import { isValidCoordinate, parseCoordinatePair } from '../../utils/geo.js';

export class GeocodingError extends Error {
  /** @param {'NOT_FOUND' | 'UNAVAILABLE'} code */
  constructor(code) {
    super(
      code === 'NOT_FOUND'
        ? 'We could not find that location. Try a more specific place (for example "Banjara Hills, Hyderabad") or enter coordinates as "17.385, 78.486".'
        : 'Location lookup is temporarily unavailable. Please try again shortly, or enter coordinates as "17.385, 78.486".',
    );
    this.name = 'GeocodingError';
    this.code = code;
  }
}

const MAX_CACHE_ENTRIES = 500;
const MAX_LABEL_LENGTH = 200;

/**
 * Resolves a search location to a centre point. Coordinates typed as "lat, lng" are
 * used as-is; anything else is looked up with OpenStreetMap Nominatim (the same
 * geolocation source the Google Maps Actor uses). Results are cached and requests
 * are spaced to respect Nominatim's one-request-per-second policy.
 *
 * @returns {Promise<{ latitude: number, longitude: number, label: string, source: 'coordinates' | 'geocoded' }>}
 */
export const createGeocoder = ({ config = leadFinderConfig.geocoding, fetchImpl = fetch, now = Date.now } = {}) => {
  const cache = new Map();
  let queue = Promise.resolve();
  let lastRequestAt = 0;

  const throttled = (task) => {
    const run = queue.then(async () => {
      const wait = lastRequestAt + config.minIntervalMs - now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      lastRequestAt = now();
      return task();
    });
    queue = run.catch(() => {});
    return run;
  };

  const lookup = async (query) => {
    const url = new URL(config.url);
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('limit', '1');

    let response;
    try {
      response = await fetchImpl(url, {
        headers: { 'User-Agent': config.userAgent, Accept: 'application/json' },
        signal: AbortSignal.timeout(config.timeoutMs),
      });
    } catch {
      throw new GeocodingError('UNAVAILABLE');
    }
    if (!response.ok) throw new GeocodingError('UNAVAILABLE');

    let results;
    try {
      results = await response.json();
    } catch {
      throw new GeocodingError('UNAVAILABLE');
    }
    const first = Array.isArray(results) ? results[0] : null;
    const latitude = Number(first?.lat);
    const longitude = Number(first?.lon);
    if (!first || !isValidCoordinate(latitude, longitude)) throw new GeocodingError('NOT_FOUND');
    const label = typeof first.display_name === 'string' ? first.display_name.slice(0, MAX_LABEL_LENGTH) : query;
    return { latitude, longitude, label, source: 'geocoded' };
  };

  return async (location) => {
    const coordinates = parseCoordinatePair(location);
    if (coordinates) {
      return { ...coordinates, label: `${coordinates.latitude}, ${coordinates.longitude}`, source: 'coordinates' };
    }
    if (!config.enabled) throw new GeocodingError('UNAVAILABLE');

    const key = location.trim().toLowerCase();
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now()) return cached.value;

    const value = await throttled(() => lookup(location.trim()));
    if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
    cache.set(key, { value, expiresAt: now() + config.cacheTtlMs });
    return value;
  };
};

let defaultGeocoder = null;

export const resolveSearchCenter = (location) => {
  defaultGeocoder ??= createGeocoder();
  return defaultGeocoder(location);
};
