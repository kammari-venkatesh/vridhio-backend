import { budgetUsd } from './leadFinder.js';

const positiveInt = (raw, fallback, max) => {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? Math.min(value, max) : fallback;
};
const nonNegativeNumber = (raw, fallback) => {
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
};

/**
 * Which qualification provider runs. Real AI is opt-in: without an explicit
 * QUALIFICATION_PROVIDER, OpenAI is used only when OPENAI_ENABLED=true and NVIDIA only
 * when NVIDIA_ENABLED=true; both enabled is "conflict" (never a silent choice). An API
 * key on its own never enables anything. "fake" (deterministic, free) must be chosen
 * explicitly so test output never appears in a real workspace by accident.
 */
export const selectQualificationProvider = (env) => {
  const explicit = env.QUALIFICATION_PROVIDER?.trim().toLowerCase();
  if (explicit === 'fake' || explicit === 'openai' || explicit === 'nvidia') return explicit;
  const openai = env.OPENAI_ENABLED === 'true';
  const nvidia = env.NVIDIA_ENABLED === 'true';
  if (openai && nvidia) return 'conflict';
  if (openai) return 'openai';
  return nvidia ? 'nvidia' : 'disabled';
};

const DEFAULT_MODEL = 'gpt-4o-mini';
// USD per 1M tokens for DEFAULT_MODEL. Any other model needs its prices configured,
// otherwise its cost cannot be budgeted and OpenAI stays unavailable.
const DEFAULT_MODEL_PRICES = { inputPerMTokUsd: 0.15, outputPerMTokUsd: 0.6 };

const buildOpenAiConfig = (env) => {
  const model = env.OPENAI_MODEL?.trim() || DEFAULT_MODEL;
  const defaults = model === DEFAULT_MODEL ? DEFAULT_MODEL_PRICES : { inputPerMTokUsd: undefined, outputPerMTokUsd: undefined };
  return {
    apiKey: env.OPENAI_API_KEY?.trim() || null,
    model,
    baseUrl: (env.OPENAI_BASE_URL?.trim() || 'https://api.openai.com/v1').replace(/\/$/, ''),
    maxOutputTokens: positiveInt(env.OPENAI_MAX_OUTPUT_TOKENS, 1200, 4000),
    timeoutMs: positiveInt(env.OPENAI_TIMEOUT_MS, 30_000, 120_000),
    inputPerMTokUsd: nonNegativeNumber(env.OPENAI_INPUT_PRICE_PER_MTOK_USD, defaults.inputPerMTokUsd),
    outputPerMTokUsd: nonNegativeNumber(env.OPENAI_OUTPUT_PRICE_PER_MTOK_USD, defaults.outputPerMTokUsd),
  };
};

const NVIDIA_DEFAULT_MODEL = 'openai/gpt-oss-20b';

/** An optional price: absent is null (unpriced), anything else must be a non-negative number. */
const optionalPrice = (raw) => {
  if (raw === undefined || String(raw).trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : Number.NaN;
};

/**
 * NVIDIA NIM (OpenAI-compatible Chat Completions). It has no default prices: when none
 * are configured its calls are recorded with token usage and an unknown cost, never $0.
 * NVIDIA_ENABLED=true is required even when QUALIFICATION_PROVIDER=nvidia.
 */
const buildNvidiaConfig = (env) => ({
  enabled: env.NVIDIA_ENABLED === 'true',
  apiKey: env.NVIDIA_API_KEY?.trim() || null,
  model: env.NVIDIA_MODEL?.trim() || NVIDIA_DEFAULT_MODEL,
  baseUrl: (env.NVIDIA_BASE_URL?.trim() || 'https://integrate.api.nvidia.com/v1').replace(/\/$/, ''),
  // Reasoning models spend output tokens before the JSON, so the allowance is larger.
  maxOutputTokens: positiveInt(env.NVIDIA_MAX_OUTPUT_TOKENS, 4000, 8000),
  timeoutMs: positiveInt(env.NVIDIA_TIMEOUT_MS, 60_000, 120_000),
  inputPerMTokUsd: optionalPrice(env.NVIDIA_INPUT_PRICE_PER_MTOK_USD),
  outputPerMTokUsd: optionalPrice(env.NVIDIA_OUTPUT_PRICE_PER_MTOK_USD),
});

export const buildQualificationConfig = (env = process.env) => ({
  provider: selectQualificationProvider(env),
  workerEnabled: env.QUALIFICATION_WORKER_ENABLED !== 'false',
  openai: buildOpenAiConfig(env),
  nvidia: buildNvidiaConfig(env),

  // AI spending limits per UTC day / UTC month. Daily defaults to $1; "off" disables a limit.
  budget: {
    dailyUsd: budgetUsd(env.LEAD_FINDER_AI_DAILY_BUDGET_USD, 1),
    monthlyUsd: budgetUsd(env.LEAD_FINDER_AI_MONTHLY_BUDGET_USD, 10),
  },

  worker: {
    pollIntervalMs: 2000,
    // One paid call at a time keeps spend predictable.
    concurrency: 1,
    heartbeatIntervalMs: 15_000,
    staleAfterMs: 3 * 60 * 1000,
  },

  policy: {
    freshForMs: positiveInt(env.QUALIFICATION_FRESH_DAYS, 7, 90) * 24 * 60 * 60 * 1000,
    failedCooldownMs: 15 * 60 * 1000,
    refreshCooldownMs: 10 * 60 * 1000,
    maxQueued: 50,
    bulkMaxIds: 10,
  },

  limits: {
    summaryMaxWords: 60,
    maxOpportunities: 5,
    maxEvidencePerOpportunity: 5,
    maxMissingInformation: 8,
    nextActionMaxChars: 200,
    reasonMaxChars: 400,
    missingItemMaxChars: 200,
  },
});

export const qualificationConfig = buildQualificationConfig();
