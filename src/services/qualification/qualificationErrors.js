export const QUALIFICATION_ERROR_CODES = Object.freeze({
  ANALYSIS_REQUIRED: 'ANALYSIS_REQUIRED',
  AI_DISABLED: 'AI_DISABLED',
  AI_UNCONFIGURED: 'AI_UNCONFIGURED',
  BUDGET_EXCEEDED: 'BUDGET_EXCEEDED',
  PROVIDER_TIMEOUT: 'PROVIDER_TIMEOUT',
  PROVIDER_ERROR: 'PROVIDER_ERROR',
  PROVIDER_REFUSED: 'PROVIDER_REFUSED',
  INVALID_AI_OUTPUT: 'INVALID_AI_OUTPUT',
  INTERRUPTED: 'INTERRUPTED',
  QUALIFICATION_ERROR: 'QUALIFICATION_ERROR',
});

const C = QUALIFICATION_ERROR_CODES;

// Shown to admins. Never includes provider responses, prompts, keys or stack traces.
export const SAFE_QUALIFICATION_MESSAGES = Object.freeze({
  [C.ANALYSIS_REQUIRED]: 'Run the website analysis for this business first.',
  [C.AI_DISABLED]: 'AI qualification is turned off on this server.',
  [C.AI_UNCONFIGURED]: 'AI qualification is not fully configured on this server.',
  [C.BUDGET_EXCEEDED]: 'The AI qualification budget has been reached.',
  [C.PROVIDER_TIMEOUT]: 'The AI provider did not respond in time.',
  [C.PROVIDER_ERROR]: 'The AI provider returned an error.',
  [C.PROVIDER_REFUSED]: 'The AI provider declined to answer this request.',
  [C.INVALID_AI_OUTPUT]: 'The AI response did not pass validation and was discarded.',
  [C.INTERRUPTED]: 'The qualification was interrupted before it finished.',
  [C.QUALIFICATION_ERROR]: 'The qualification could not be completed.',
});

export const safeQualificationMessage = (code) =>
  SAFE_QUALIFICATION_MESSAGES[code] ?? SAFE_QUALIFICATION_MESSAGES[C.QUALIFICATION_ERROR];

/** A failure with a safe code; `detail` is for server logs only. */
export class QualificationError extends Error {
  constructor(code, { detail, providerCalled = false, usage = null } = {}) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'QualificationError';
    this.code = code;
    this.providerCalled = providerCalled;
    this.usage = usage;
  }
}
