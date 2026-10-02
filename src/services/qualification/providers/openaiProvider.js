import { QUALIFICATION_SCHEMA } from '../prompt.js';
import { QUALIFICATION_ERROR_CODES as C, QualificationError } from '../qualificationErrors.js';

// Rough upper bound for tokens in a prompt (about 3 characters per token for JSON).
export const estimateInputTokens = (messages) =>
  Math.ceil(messages.reduce((n, m) => n + m.content.length, 0) / 3) + 20 * messages.length + 50;

export const toUsage = (raw) => {
  const input = Number.isInteger(raw?.prompt_tokens) ? raw.prompt_tokens : null;
  const output = Number.isInteger(raw?.completion_tokens) ? raw.completion_tokens : null;
  if (input === null || output === null) return null;
  return { inputTokens: input, outputTokens: output, totalTokens: Number.isInteger(raw.total_tokens) ? raw.total_tokens : input + output };
};

/**
 * OpenAI Chat Completions with strict JSON-schema structured output. Only the
 * evidence payload is sent; responses are not stored by OpenAI (`store: false`) and
 * are never returned to admins or logged. Prices are USD per 1M tokens, which equals
 * micro-USD per token.
 */
export const createOpenAiQualificationProvider = ({ config, fetchImpl = fetch }) => {
  const { apiKey, model, baseUrl, maxOutputTokens, timeoutMs, inputPerMTokUsd, outputPerMTokUsd } = config;
  const costMicroUsd = (usage) =>
    usage ? Math.ceil(usage.inputTokens * inputPerMTokUsd + usage.outputTokens * outputPerMTokUsd) : null;

  return {
    name: 'openai',
    model,
    paid: true,
    costMicroUsd,
    estimateMaxCostMicroUsd: (messages) =>
      Math.max(1, Math.ceil(estimateInputTokens(messages) * inputPerMTokUsd + maxOutputTokens * outputPerMTokUsd)),

    async analyzeProspect({ messages, signal }) {
      const timeout = AbortSignal.timeout(timeoutMs);
      let res;
      try {
        res = await fetchImpl(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            messages,
            max_completion_tokens: maxOutputTokens,
            store: false,
            response_format: {
              type: 'json_schema',
              json_schema: { name: 'prospect_qualification', strict: true, schema: QUALIFICATION_SCHEMA },
            },
          }),
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
      } catch (err) {
        // The request may have reached the provider, so its cost is unknown.
        const code = timeout.aborted ? C.PROVIDER_TIMEOUT : C.PROVIDER_ERROR;
        throw new QualificationError(code, { detail: err?.name ?? 'network error', providerCalled: true });
      }

      let body;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      if (!res.ok) {
        // Rejected requests (4xx) are not processed; server errors may have been.
        throw new QualificationError(C.PROVIDER_ERROR, {
          detail: `HTTP ${res.status}${body?.error?.type ? ` ${body.error.type}` : ''}`,
          providerCalled: res.status >= 500,
        });
      }

      const usage = toUsage(body?.usage);
      const choice = body?.choices?.[0];
      if (choice?.message?.refusal) {
        throw new QualificationError(C.PROVIDER_REFUSED, { detail: 'refusal', providerCalled: true, usage });
      }
      if (choice?.finish_reason === 'length') {
        throw new QualificationError(C.INVALID_AI_OUTPUT, { detail: 'output truncated', providerCalled: true, usage });
      }
      let output;
      try {
        output = JSON.parse(choice?.message?.content ?? '');
      } catch {
        throw new QualificationError(C.INVALID_AI_OUTPUT, { detail: 'output is not JSON', providerCalled: true, usage });
      }
      return { output, usage };
    },
  };
};
