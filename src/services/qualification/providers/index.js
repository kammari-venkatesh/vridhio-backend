import { qualificationConfig } from '../../../config/qualification.js';
import { createFakeQualificationProvider } from './fakeProvider.js';
import { createNvidiaQualificationProvider } from './nvidiaProvider.js';
import { createOpenAiQualificationProvider } from './openaiProvider.js';

/** What is missing before OpenAI can be used (names only; values are never reported). */
export const openAiConfigProblems = (openai) => {
  const problems = [];
  if (!openai.apiKey) problems.push('OPENAI_API_KEY is not set');
  if (!openai.model) problems.push('OPENAI_MODEL is not set');
  if (openai.inputPerMTokUsd == null || openai.outputPerMTokUsd == null) {
    problems.push('Token prices for this model are not configured (OPENAI_INPUT_PRICE_PER_MTOK_USD / OPENAI_OUTPUT_PRICE_PER_MTOK_USD)');
  }
  return problems;
};

/** What is missing before NVIDIA can be used (names only). Prices are optional but must be valid. */
export const nvidiaConfigProblems = (nvidia) => {
  const problems = [];
  if (!nvidia.apiKey) problems.push('NVIDIA_API_KEY is not set');
  if (!nvidia.model) problems.push('NVIDIA_MODEL is not set');
  const prices = [nvidia.inputPerMTokUsd, nvidia.outputPerMTokUsd];
  if (prices.some(Number.isNaN) || prices.filter((p) => p === null).length === 1) {
    problems.push('NVIDIA token prices must both be set to valid numbers, or both left unset (NVIDIA_INPUT_PRICE_PER_MTOK_USD / NVIDIA_OUTPUT_PRICE_PER_MTOK_USD)');
  }
  return problems;
};

let override = null;

/** Replaces the configured provider in this process (tests); null restores it. */
export const setQualificationProvider = (provider) => {
  override = provider;
  cached = null;
};

/**
 * Public description of the qualification provider: "live" (a real AI provider,
 * configured), "test" (fake provider), "disabled" or "unconfigured". Contains no
 * credentials. There is never a fallback from one provider to another.
 */
export const qualificationProviderStatus = (config = qualificationConfig) => {
  if (override) return { provider: override.name, mode: override.paid ? 'live' : 'test', model: override.model, problems: [] };
  if (config.provider === 'fake') return { provider: 'fake', mode: 'test', model: 'fake-qualifier-1', problems: [] };
  if (config.provider === 'openai') {
    const problems = openAiConfigProblems(config.openai);
    return { provider: 'openai', mode: problems.length ? 'unconfigured' : 'live', model: config.openai.model, problems };
  }
  if (config.provider === 'nvidia') {
    if (!config.nvidia.enabled) {
      return { provider: 'nvidia', mode: 'disabled', model: config.nvidia.model, problems: ['NVIDIA_ENABLED is not true'] };
    }
    const problems = nvidiaConfigProblems(config.nvidia);
    return { provider: 'nvidia', mode: problems.length ? 'unconfigured' : 'live', model: config.nvidia.model, problems };
  }
  if (config.provider === 'conflict') {
    return {
      provider: null,
      mode: 'unconfigured',
      model: null,
      problems: ['OPENAI_ENABLED and NVIDIA_ENABLED are both true; set QUALIFICATION_PROVIDER to choose one'],
    };
  }
  return { provider: 'disabled', mode: 'disabled', model: null, problems: [] };
};

let cached = null;

/** The configured provider, or null when qualification is disabled or unconfigured. */
export const getQualificationProvider = (config = qualificationConfig) => {
  if (override) return override;
  if (cached) return cached;
  const status = qualificationProviderStatus(config);
  if (status.mode === 'test') cached = createFakeQualificationProvider();
  else if (status.mode === 'live' && status.provider === 'openai') cached = createOpenAiQualificationProvider({ config: config.openai });
  else if (status.mode === 'live' && status.provider === 'nvidia') cached = createNvidiaQualificationProvider({ config: config.nvidia });
  return cached;
};
