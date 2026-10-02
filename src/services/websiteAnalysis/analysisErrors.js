/**
 * Failure codes stored on an analysis. Messages are written for admins and never
 * include resolved IP addresses, internal hostnames or stack traces.
 */
export const ANALYSIS_ERROR_CODES = Object.freeze({
  NO_WEBSITE: 'NO_WEBSITE',
  INVALID_URL: 'INVALID_URL',
  UNSAFE_URL: 'UNSAFE_URL',
  DNS_ERROR: 'DNS_ERROR',
  TIMEOUT: 'TIMEOUT',
  CONNECTION_ERROR: 'CONNECTION_ERROR',
  TLS_ERROR: 'TLS_ERROR',
  HTTP_ERROR: 'HTTP_ERROR',
  NON_HTML: 'NON_HTML',
  BLOCKED: 'BLOCKED',
  TOO_MANY_REDIRECTS: 'TOO_MANY_REDIRECTS',
  REDIRECT_LOOP: 'REDIRECT_LOOP',
  RESPONSE_TOO_LARGE: 'RESPONSE_TOO_LARGE',
  INVALID_RESPONSE: 'INVALID_RESPONSE',
  INTERRUPTED: 'INTERRUPTED',
  ANALYSIS_ERROR: 'ANALYSIS_ERROR',
});

const C = ANALYSIS_ERROR_CODES;

export const SAFE_ERROR_MESSAGES = Object.freeze({
  [C.NO_WEBSITE]: 'No website is recorded for this business.',
  [C.INVALID_URL]: 'The recorded website is not a valid http(s) address.',
  [C.UNSAFE_URL]: 'The website address points to a private, local or reserved network and was not fetched.',
  [C.DNS_ERROR]: 'The website domain could not be resolved (DNS lookup failed).',
  [C.TIMEOUT]: 'The website did not respond within the time limit.',
  [C.CONNECTION_ERROR]: 'A connection to the website could not be established or was interrupted.',
  [C.TLS_ERROR]: 'The website’s HTTPS certificate or TLS connection could not be verified.',
  [C.HTTP_ERROR]: 'The website responded with an HTTP error status.',
  [C.NON_HTML]: 'The website address did not return an HTML page.',
  [C.BLOCKED]: 'The website refused automated access (bot protection or rate limiting).',
  [C.TOO_MANY_REDIRECTS]: 'The website redirected too many times.',
  [C.REDIRECT_LOOP]: 'The website redirects in a loop.',
  [C.RESPONSE_TOO_LARGE]: 'The website’s response was larger than the analysis size limit.',
  [C.INVALID_RESPONSE]: 'The website returned a response that could not be read.',
  [C.INTERRUPTED]: 'The analysis stopped unexpectedly (the worker restarted). Run it again.',
  [C.ANALYSIS_ERROR]: 'The analysis failed because of an internal error.',
});

export class AnalysisError extends Error {
  /**
   * @param {string} code one of ANALYSIS_ERROR_CODES
   * @param {{ httpStatus?: number, detail?: string }} [extra] detail is for server logs only
   */
  constructor(code, { httpStatus = null, detail = null } = {}) {
    super(SAFE_ERROR_MESSAGES[code] ?? SAFE_ERROR_MESSAGES[C.ANALYSIS_ERROR]);
    this.name = 'AnalysisError';
    this.code = code in SAFE_ERROR_MESSAGES ? code : C.ANALYSIS_ERROR;
    this.httpStatus = httpStatus;
    this.detail = detail;
  }
}

export const safeErrorMessage = (code, httpStatus) => {
  const base = SAFE_ERROR_MESSAGES[code] ?? SAFE_ERROR_MESSAGES[C.ANALYSIS_ERROR];
  return code === C.HTTP_ERROR && Number.isInteger(httpStatus) ? `${base} (HTTP ${httpStatus})` : base;
};
