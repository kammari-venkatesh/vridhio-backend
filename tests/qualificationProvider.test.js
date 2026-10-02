import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildQualificationConfig, selectQualificationProvider } from '../src/config/qualification.js';
import { buildMessages, QUALIFICATION_SCHEMA } from '../src/services/qualification/prompt.js';
import { createFakeQualificationProvider, deterministicOutput } from '../src/services/qualification/providers/fakeProvider.js';
import { qualificationProviderStatus } from '../src/services/qualification/providers/index.js';
import { createOpenAiQualificationProvider } from '../src/services/qualification/providers/openaiProvider.js';

const FAKE_KEY = 'sk-test-not-a-real-key-000000';
const payload = {
  prospect: { businessName: 'Sunrise Bakery' },
  websiteAnalysis: { hasWebsite: true, reachable: true, httpStatus: 200, https: true },
  evidence: [{ id: 'E1', type: 'SITEMAP_MISSING', severity: 'NOTICE', evidence: 'No XML sitemap was found.' }],
  candidateServices: [{ serviceId: 'seo', serviceName: 'SEO', supportingEvidenceIds: ['E1'] }],
};
const messages = buildMessages(payload);

const openaiConfig = (overrides = {}) => ({
  ...buildQualificationConfig({ OPENAI_API_KEY: FAKE_KEY }).openai,
  timeoutMs: 200,
  ...overrides,
});

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const completion = (content, { usage = { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200 }, finish = 'stop', refusal = null } = {}) =>
  jsonResponse({ choices: [{ finish_reason: finish, message: { content, refusal } }], usage });

const mockFetch = (handler) => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return handler(url, init);
  };
  return { fetchImpl, calls };
};

describe('Provider selection', () => {
  it('keeps paid AI off unless explicitly enabled; a key alone never enables it', () => {
    assert.equal(selectQualificationProvider({}), 'disabled');
    assert.equal(selectQualificationProvider({ OPENAI_API_KEY: FAKE_KEY }), 'disabled');
    assert.equal(selectQualificationProvider({ OPENAI_API_KEY: FAKE_KEY, OPENAI_ENABLED: 'yes' }), 'disabled');
    assert.equal(selectQualificationProvider({ OPENAI_ENABLED: 'true' }), 'openai');
    assert.equal(selectQualificationProvider({ QUALIFICATION_PROVIDER: 'fake', OPENAI_ENABLED: 'true' }), 'fake');
    assert.equal(selectQualificationProvider({ QUALIFICATION_PROVIDER: 'other' }), 'disabled');
  });

  it('reports configuration problems without exposing values', () => {
    const unconfigured = qualificationProviderStatus(buildQualificationConfig({ OPENAI_ENABLED: 'true' }));
    assert.equal(unconfigured.mode, 'unconfigured');
    const otherModel = qualificationProviderStatus(buildQualificationConfig({ OPENAI_ENABLED: 'true', OPENAI_API_KEY: FAKE_KEY, OPENAI_MODEL: 'gpt-x' }));
    assert.equal(otherModel.mode, 'unconfigured');
    assert.ok(otherModel.problems.some((p) => /prices/.test(p)));
    const live = qualificationProviderStatus(buildQualificationConfig({ OPENAI_ENABLED: 'true', OPENAI_API_KEY: FAKE_KEY }));
    assert.equal(live.mode, 'live');
    assert.equal(live.model, 'gpt-4o-mini');
    for (const status of [unconfigured, otherModel, live]) assert.ok(!JSON.stringify(status).includes(FAKE_KEY));
    assert.equal(qualificationProviderStatus(buildQualificationConfig({})).mode, 'disabled');
    assert.equal(qualificationProviderStatus(buildQualificationConfig({ QUALIFICATION_PROVIDER: 'fake' })).mode, 'test');
  });

  it('caps limits and rejects invalid prices', () => {
    const cfg = buildQualificationConfig({ OPENAI_MAX_OUTPUT_TOKENS: '999999', OPENAI_TIMEOUT_MS: '-5', OPENAI_INPUT_PRICE_PER_MTOK_USD: 'abc', QUALIFICATION_FRESH_DAYS: '3' });
    assert.equal(cfg.openai.maxOutputTokens, 4000);
    assert.equal(cfg.openai.timeoutMs, 30_000);
    assert.equal(cfg.openai.inputPerMTokUsd, null);
    assert.equal(cfg.policy.freshForMs, 3 * 86_400_000);
    assert.equal(cfg.budget.dailyUsd, 1);
    assert.equal(cfg.budget.monthlyUsd, 10);
    assert.equal(buildQualificationConfig({ LEAD_FINDER_AI_DAILY_BUDGET_USD: 'off' }).budget.dailyUsd, null);
  });
});

describe('Fake provider', () => {
  it('is deterministic, free and records what it was sent', async () => {
    const provider = createFakeQualificationProvider();
    const a = await provider.analyzeProspect({ payload, messages });
    const b = await provider.analyzeProspect({ payload, messages });
    assert.deepEqual(a.output, b.output);
    assert.deepEqual(a.output, deterministicOutput(payload));
    assert.equal(provider.costMicroUsd(a.usage), 0);
    assert.equal(provider.estimateMaxCostMicroUsd(messages), 0);
    assert.equal(provider.requests.length, 2);
    assert.equal(provider.paid, false);
  });
});

describe('OpenAI provider (mocked fetch, no network)', () => {
  it('sends only the messages with a strict JSON schema and reports token usage and cost', async () => {
    const output = deterministicOutput(payload);
    const { fetchImpl, calls } = mockFetch(() => completion(JSON.stringify(output)));
    const provider = createOpenAiQualificationProvider({ config: openaiConfig(), fetchImpl });
    const result = await provider.analyzeProspect({ payload, messages });
    assert.deepEqual(result.output, output);
    assert.deepEqual(result.usage, { inputTokens: 1000, outputTokens: 200, totalTokens: 1200 });
    // gpt-4o-mini: 1000 * $0.15/M + 200 * $0.60/M = $0.00027
    assert.equal(provider.costMicroUsd(result.usage), 270);

    const [call] = calls;
    assert.equal(call.url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(call.init.headers.Authorization, `Bearer ${FAKE_KEY}`);
    assert.equal(call.body.model, 'gpt-4o-mini');
    assert.equal(call.body.store, false);
    assert.equal(call.body.max_completion_tokens, 1200);
    assert.equal(call.body.response_format.type, 'json_schema');
    assert.equal(call.body.response_format.json_schema.strict, true);
    assert.deepEqual(call.body.response_format.json_schema.schema, JSON.parse(JSON.stringify(QUALIFICATION_SCHEMA)));
    assert.deepEqual(call.body.messages, messages);
    assert.ok(!call.init.body.includes(FAKE_KEY), 'the key is only sent in the Authorization header');
  });

  it('estimates a maximum cost covering prompt and full output allowance', () => {
    const provider = createOpenAiQualificationProvider({ config: openaiConfig(), fetchImpl: async () => {} });
    const estimate = provider.estimateMaxCostMicroUsd(messages);
    assert.ok(estimate >= 1200 * 0.6, 'covers the full output allowance');
    assert.ok(estimate < 5000, 'stays small for a compact payload');
  });

  it('maps a timeout to PROVIDER_TIMEOUT with unknown usage', async () => {
    const fetchImpl = (_url, init) =>
      new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' }))));
    const provider = createOpenAiQualificationProvider({ config: openaiConfig({ timeoutMs: 30 }), fetchImpl });
    await assert.rejects(provider.analyzeProspect({ payload, messages }), (e) => e.code === 'PROVIDER_TIMEOUT' && e.providerCalled && e.usage === null);
  });

  it('maps HTTP errors without leaking the response body', async () => {
    const body = { error: { type: 'invalid_request_error', message: `Incorrect API key provided: ${FAKE_KEY}` } };
    const rejected = createOpenAiQualificationProvider({ config: openaiConfig(), fetchImpl: async () => jsonResponse(body, 401) });
    await assert.rejects(rejected.analyzeProspect({ payload, messages }), (e) => {
      assert.equal(e.code, 'PROVIDER_ERROR');
      assert.equal(e.providerCalled, false);
      assert.ok(!e.message.includes(FAKE_KEY));
      return true;
    });
    const serverError = createOpenAiQualificationProvider({ config: openaiConfig(), fetchImpl: async () => jsonResponse({}, 503) });
    await assert.rejects(serverError.analyzeProspect({ payload, messages }), (e) => e.code === 'PROVIDER_ERROR' && e.providerCalled === true);
    const network = createOpenAiQualificationProvider({ config: openaiConfig(), fetchImpl: async () => { throw new TypeError('fetch failed'); } });
    await assert.rejects(network.analyzeProspect({ payload, messages }), (e) => e.code === 'PROVIDER_ERROR' && e.providerCalled === true);
  });

  it('handles refusals, truncated output and non-JSON content, keeping reported usage', async () => {
    const cases = [
      [completion(null, { refusal: 'I cannot help with that.' }), 'PROVIDER_REFUSED'],
      [completion('{"summary": "cut', { finish: 'length' }), 'INVALID_AI_OUTPUT'],
      [completion('Sure! Here is the analysis.'), 'INVALID_AI_OUTPUT'],
    ];
    for (const [response, code] of cases) {
      const provider = createOpenAiQualificationProvider({ config: openaiConfig(), fetchImpl: async () => response });
      await assert.rejects(provider.analyzeProspect({ payload, messages }), (e) => {
        assert.equal(e.code, code);
        assert.equal(e.providerCalled, true);
        assert.deepEqual(e.usage, { inputTokens: 1000, outputTokens: 200, totalTokens: 1200 });
        return true;
      });
    }
  });

  it('treats missing usage as unknown, never as zero', async () => {
    const provider = createOpenAiQualificationProvider({
      config: openaiConfig(),
      fetchImpl: async () => completion(JSON.stringify(deterministicOutput(payload)), { usage: null }),
    });
    const result = await provider.analyzeProspect({ payload, messages });
    assert.equal(result.usage, null);
    assert.equal(provider.costMicroUsd(result.usage), null);
  });
});
