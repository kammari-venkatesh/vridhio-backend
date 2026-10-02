import { PROVIDER_ERROR_CODES as CODES, ProviderError, providerError } from '../provider.interface.js';

const codeForStatus = (status) => {
  if (status === 401 || status === 403) return CODES.PROVIDER_AUTH_ERROR;
  if (status === 429) return CODES.PROVIDER_RATE_LIMIT;
  // Unknown Actor, invalid input or unusable Actor options.
  if (status === 400 || status === 404 || status === 422) return CODES.CONFIGURATION_ERROR;
  // Usage or billing limit on the Apify account.
  if (status === 402) return CODES.PROVIDER_FAILED;
  return CODES.PROVIDER_UNAVAILABLE;
};

/**
 * Converts anything thrown by apify-client into a ProviderError with a safe,
 * generic message. Raw messages, responses and request details are never copied
 * (they can contain URLs, headers or account data).
 */
export const mapApifyError = (err) => {
  if (err instanceof ProviderError) return err;
  const status = Number.isInteger(err?.statusCode) ? err.statusCode : null;
  const error = providerError(status ? codeForStatus(status) : CODES.PROVIDER_UNAVAILABLE);
  error.httpStatus = status;
  return error;
};

/** One-line description for server logs: error code and HTTP status only. */
export const describeForLog = (err) =>
  err instanceof ProviderError
    ? `${err.code}${err.httpStatus ? ` (HTTP ${err.httpStatus})` : ''}`
    : (err?.name ?? 'Error');
