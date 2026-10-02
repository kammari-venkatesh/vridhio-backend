import { QUALIFICATION_SCHEMA } from '../prompt.js';
import { QUALIFICATION_ERROR_CODES as C, QualificationError } from '../qualificationErrors.js';
import { estimateInputTokens, toUsage } from './openaiProvider.js';

const isPrice = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

// Some models wrap JSON in a Markdown fence despite the response format; nothing else is repaired.
const unfence = (text) => text.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, '$1');

/**
 * NVIDIA NIM through its OpenAI-compatible Chat Completions endpoint. Sends the same
 * messages and JSON schema as the OpenAI provider (`response_format: json_schema`);
 * the output is still parsed defensively and validated by the server like any other
 * provider's. Without configured prices, cost is unknown (null), never zero.
 */
export const createNvidiaQualificationProvider = ({ config, fetchImpl = fetch }) => {
  const { apiKey, model, baseUrl, maxOutputTokens, timeoutMs, inputPerMTokUsd, outputPerMTokUsd } = config;
  const priced = isPrice(inputPerMTokUsd) && isPrice(outputPerMTokUsd);
  const costMicroUsd = (usage) =>
    usage && priced ? Math.ceil(usage.inputTokens * inputPerMTokUsd + usage.outputTokens * outputPerMTokUsd) : null;

  return {
    name: 'nvidia',
    model,
    paid: true,
    costMicroUsd,
    estimateMaxCostMicroUsd: (messages) =>
      priced ? Math.max(1, Math.ceil(estimateInputTokens(messages) * inputPerMTokUsd + maxOutputTokens * outputPerMTokUsd)) : 0,

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
            max_tokens: maxOutputTokens,
            stream: false,
            response_format: {
              type: 'json_schema',
              json_schema: { name: 'prospect_qualification', strict: true, schema: QUALIFICATION_SCHEMA },
            },
          }),
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
      } catch (err) {
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
        // Only the status is kept: NVIDIA error bodies are free text and are never stored or logged.
        throw new QualificationError(C.PROVIDER_ERROR, { detail: `HTTP ${res.status}`, providerCalled: res.status >= 500 });
      }

      const usage = toUsage(body?.usage);
      const choice = body?.choices?.[0];
      if (choice?.message?.refusal) {
        throw new QualificationError(C.PROVIDER_REFUSED, { detail: 'refusal', providerCalled: true, usage });
      }
      if (choice?.finish_reason === 'length') {
        throw new QualificationError(C.INVALID_AI_OUTPUT, { detail: 'output truncated', providerCalled: true, usage });
      }
      const content = choice?.message?.content;
      let output;
      try {
        output = JSON.parse(typeof content === 'string' ? unfence(content) : '');
      } catch {
        throw new QualificationError(C.INVALID_AI_OUTPUT, { detail: 'output is not JSON', providerCalled: true, usage });
      }
      if (!output || typeof output !== 'object' || Array.isArray(output)) {
        throw new QualificationError(C.INVALID_AI_OUTPUT, { detail: 'output is not a JSON object', providerCalled: true, usage });
      }
      return { output, usage };
    },
  };
};
