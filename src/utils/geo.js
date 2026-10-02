const EARTH_RADIUS_KM = 6371.0088; // mean Earth radius (IUGG)

const toRadians = (degrees) => (degrees * Math.PI) / 180;

const isNumberInRange = (value, limit) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= limit;

/** True for a finite latitude in [-90, 90] and longitude in [-180, 180]. Missing values are never valid. */
export const isValidCoordinate = (latitude, longitude) => isNumberInRange(latitude, 90) && isNumberInRange(longitude, 180);

/**
 * Great-circle distance in kilometres (Haversine formula). Returns null when either
 * point is missing or invalid, so callers cannot mistake bad data for a distance.
 */
export const haversineKm = (latitude1, longitude1, latitude2, longitude2) => {
  if (!isValidCoordinate(latitude1, longitude1) || !isValidCoordinate(latitude2, longitude2)) return null;
  const dLat = toRadians(latitude2 - latitude1);
  const dLon = toRadians(longitude2 - longitude1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRadians(latitude1)) * Math.cos(toRadians(latitude2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
};

const COORDINATE_PAIR = /^\s*(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;

/** Parses "17.385, 78.4867" (latitude, longitude). Returns null for anything else or out-of-range values. */
export const parseCoordinatePair = (text) => {
  const match = typeof text === 'string' ? COORDINATE_PAIR.exec(text) : null;
  if (!match) return null;
  const latitude = Number(match[1]);
  const longitude = Number(match[2]);
  return isValidCoordinate(latitude, longitude) ? { latitude, longitude } : null;
};
