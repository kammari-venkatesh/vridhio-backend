import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { buildQualificationConfig, selectQualificationProvider } from '../src/config/qualification.js';
import { AiUsageRecord } from '../src/models/aiUsageRecord.model.js';
import { Prospect } from '../src/models/prospect.model.js';
import { ProspectQualification } from '../src/models/prospectQualification.model.js';
import { ProspectWebsiteAnalysis } from '../src/models/prospectWebsiteAnalysis.model.js';
import { buildMessages, QUALIFICATION_SCHEMA } from '../src/services/qualification/prompt.js';
import { deterministicOutput } from '../src/services/qualification/providers/fakeProvider.js';
import {
  getQualificationProvider,
  qualificationProviderStatus,
  setQualificationProvider,
} from '../src/services/qualification/providers/index.js';
import { createNvidiaQualificationProvider } from '../src/services/qualification/providers/nvidiaProvider.js';
import { getAiStatus, getQualificationFor, requestQualification } from '../src/services/qualification/qualification.service.js';
import { createQualificationWorker } from '../src/services/qualification/worker.js';
import { analysedProspect } from './helpers/qualification.js';
import { clearDb, startTestDb, stopTestDb } from './helpers/testDb.js';

const FAKE_KEY = 'nvapi-test-not-a-real-key-0000000000';
const OPENAI_FAKE_KEY = 'sk-test-not-a-real-key-000000';

const nvidiaConfig = (overrides = {}) => ({
  ...buildQualificationConfig({ NVIDIA_ENABLED: 'true', NVIDIA_API_KEY: FAKE_KEY }).nvidia,
  timeoutMs: 200,
  ...overrides,
});

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const USAGE = { prompt_tokens: 1100, completion_tokens: 900, total_tokens: 2000 };
const completion = (content, { usage = USAGE, finish = 'stop', refusal = null } = {}) =>
  jsonResponse({ choices: [{ finish_reason: finish, message: { role: 'assistant', content, refusal } }], usage });

/** The payload exactly as sent in the user message (between the <data> delimiters). */
const sentPayload = (body) => JSON.parse(body.messages[1].content.split('<data>\n')[1].split('\n</data>')[0]);

/** A mocked NVIDIA endpoint: `respond(payload)` returns the model's JSON (or a Response). */
const mockNvidia = (respond = deterministicOutput) => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, init, body });
    const out = await respond(sentPayload(body));
    return out instanceof Response ? out : completion(JSON.stringify(out));
  };
  return { fetchImpl, calls };
};

const samplePayload = {
  prospect: { businessName: 'Sunrise Bakery' },
  websiteAnalysis: { hasWebsite: true, reachable: true, httpStatus: 200, https: true },
  evidence: [{ id: 'E1', type: 'SITEMAP_MISSING', severity: 'NOTICE', evidence: 'No XML sitemap was found.' }],
  candidateServices: [{ serviceId: 'seo', serviceName: 'SEO', supportingEvidenceIds: ['E1'] }],
};
const sampleMessages = buildMessages(samplePayload);

describe('NVIDIA configuration and provider selection', () => {
  it('defaults to the NIM endpoint and model, disabled, unpriced', () => {
    const { nvidia } = buildQualificationConfig({});
    assert.equal(nvidia.enabled, false);
    assert.equal(nvidia.apiKey, null);
    assert.equal(nvidia.baseUrl, 'https://integrate.api.nvidia.com/v1');
    assert.equal(nvidia.model, 'openai/gpt-oss-20b');
    assert.equal(nvidia.maxOutputTokens, 4000);
    assert.equal(nvidia.timeoutMs, 60_000);
    assert.equal(nvidia.inputPerMTokUsd, null);
    assert.equal(nvidia.outputPerMTokUsd, null);
    assert.equal(buildQualificationConfig({ NVIDIA_MAX_OUTPUT_TOKENS: '999999' }).nvidia.maxOutputTokens, 8000);
  });

  it('is selected only explicitly; a key alone never enables it', () => {
    assert.equal(selectQualificationProvider({ NVIDIA_API_KEY: FAKE_KEY }), 'disabled');
    assert.equal(selectQualificationProvider({ NVIDIA_ENABLED: 'yes' }), 'disabled');
    assert.equal(selectQualificationProvider({ NVIDIA_ENABLED: 'true' }), 'nvidia');
    assert.equal(selectQualificationProvider({ QUALIFICATION_PROVIDER: 'nvidia' }), 'nvidia');
    assert.equal(selectQualificationProvider({ QUALIFICATION_PROVIDER: 'openai', NVIDIA_ENABLED: 'true' }), 'openai');
    assert.equal(selectQualificationProvider({ OPENAI_ENABLED: 'true', NVIDIA_ENABLED: 'true' }), 'conflict');
  });

  it('stays disabled when selected but NVIDIA_ENABLED is not true, with no fallback to OpenAI', () => {
    const config = buildQualificationConfig({
      QUALIFICATION_PROVIDER: 'nvidia',
      NVIDIA_API_KEY: FAKE_KEY,
      OPENAI_ENABLED: 'true',
      OPENAI_API_KEY: OPENAI_FAKE_KEY,
    });
    const status = qualificationProviderStatus(config);
    assert.equal(status.provider, 'nvidia');
    assert.equal(status.mode, 'disabled');
    assert.equal(getQualificationProvider(config), null);
  });

  it('refuses to choose when both providers are enabled', () => {
    const config = buildQualificationConfig({
      OPENAI_ENABLED: 'true',
      OPENAI_API_KEY: OPENAI_FAKE_KEY,
      NVIDIA_ENABLED: 'true',
      NVIDIA_API_KEY: FAKE_KEY,
    });
    const status = qualificationProviderStatus(config);
    assert.equal(status.mode, 'unconfigured');
    assert.ok(status.problems.some((p) => /QUALIFICATION_PROVIDER/.test(p)));
    assert.equal(getQualificationProvider(config), null);
  });

  it('reports a missing key or invalid prices as unconfigured, without exposing values', () => {
    const missingKey = qualificationProviderStatus(buildQualificationConfig({ NVIDIA_ENABLED: 'true' }));
    assert.equal(missingKey.mode, 'unconfigured');
    assert.ok(missingKey.problems.includes('NVIDIA_API_KEY is not set'));
    const halfPriced = qualificationProviderStatus(
      buildQualificationConfig({ NVIDIA_ENABLED: 'true', NVIDIA_API_KEY: FAKE_KEY, NVIDIA_INPUT_PRICE_PER_MTOK_USD: '0.1' }),
    );
    assert.equal(halfPriced.mode, 'unconfigured');
    const badPrice = qualificationProviderStatus(
      buildQualificationConfig({
        NVIDIA_ENABLED: 'true',
        NVIDIA_API_KEY: FAKE_KEY,
        NVIDIA_INPUT_PRICE_PER_MTOK_USD: 'abc',
        NVIDIA_OUTPUT_PRICE_PER_MTOK_USD: '0.2',
      }),
    );
    assert.equal(badPrice.mode, 'unconfigured');
    const live = qualificationProviderStatus(buildQualificationConfig({ NVIDIA_ENABLED: 'true', NVIDIA_API_KEY: FAKE_KEY }));
    assert.deepEqual(live, { provider: 'nvidia', mode: 'live', model: 'openai/gpt-oss-20b', problems: [] });
    for (const s of [missingKey, halfPriced, badPrice, live]) assert.ok(!JSON.stringify(s).includes(FAKE_KEY));
  });
});

describe('NVIDIA provider (mocked fetch, no network)', () => {
  it('sends only the shared messages with the JSON schema; usage is recorded and cost is unknown', async () => {
    const { fetchImpl, calls } = mockNvidia();
    const provider = createNvidiaQualificationProvider({ config: nvidiaConfig(), fetchImpl });
    const result = await provider.analyzeProspect({ payload: samplePayload, messages: sampleMessages });
    assert.deepEqual(result.output, deterministicOutput(samplePayload));
    assert.deepEqual(result.usage, { inputTokens: 1100, outputTokens: 900, totalTokens: 2000 });
    assert.equal(provider.name, 'nvidia');
    assert.equal(provider.costMicroUsd(result.usage), null, 'unpriced: unknown, never 0');
    assert.equal(provider.estimateMaxCostMicroUsd(sampleMessages), 0);

    const [call] = calls;
    assert.equal(call.url, 'https://integrate.api.nvidia.com/v1/chat/completions');
    assert.equal(call.init.headers.Authorization, `Bearer ${FAKE_KEY}`);
    assert.equal(call.body.model, 'openai/gpt-oss-20b');
    assert.equal(call.body.max_tokens, 4000);
    assert.equal(call.body.stream, false);
    assert.equal(call.body.response_format.type, 'json_schema');
    assert.equal(call.body.response_format.json_schema.strict, true);
    assert.deepEqual(call.body.response_format.json_schema.schema, JSON.parse(JSON.stringify(QUALIFICATION_SCHEMA)));
    assert.deepEqual(call.body.messages, sampleMessages);
    assert.ok(!call.init.body.includes(FAKE_KEY), 'the key is only sent in the Authorization header');
  });

  it('prices usage only when both prices are configured', () => {
    const provider = createNvidiaQualificationProvider({
      config: nvidiaConfig({ inputPerMTokUsd: 0.1, outputPerMTokUsd: 0.5 }),
      fetchImpl: async () => {},
    });
    assert.equal(provider.costMicroUsd({ inputTokens: 1000, outputTokens: 200, totalTokens: 1200 }), 200);
    assert.ok(provider.estimateMaxCostMicroUsd(sampleMessages) >= 4000 * 0.5);
  });

  it('accepts JSON in a Markdown fence but rejects malformed, truncated or non-object output with usage kept', async () => {
    const fenced = createNvidiaQualificationProvider({
      config: nvidiaConfig(),
      fetchImpl: async () => completion('```json\n{"summary":"x"}\n```'),
    });
    assert.deepEqual((await fenced.analyzeProspect({ messages: sampleMessages })).output, { summary: 'x' });

    const cases = [
      completion('Sure! Here is the analysis.'),
      completion('{"summary": "cut', { finish: 'length' }),
      completion('[1, 2, 3]'),
      completion(null),
      completion(null, { refusal: 'I cannot help with that.' }),
    ];
    for (const response of cases) {
      const provider = createNvidiaQualificationProvider({ config: nvidiaConfig(), fetchImpl: async () => response.clone() });
      await assert.rejects(provider.analyzeProspect({ messages: sampleMessages }), (e) => {
        assert.ok(['INVALID_AI_OUTPUT', 'PROVIDER_REFUSED'].includes(e.code), e.code);
        assert.equal(e.providerCalled, true);
        assert.deepEqual(e.usage, { inputTokens: 1100, outputTokens: 900, totalTokens: 2000 });
        return true;
      });
    }
  });

  it('maps HTTP, network and timeout errors without leaking the key or the response body', async () => {
    const leaky = { status: 401, title: 'Unauthorized', detail: `Invalid key ${FAKE_KEY}` };
    const rejected = createNvidiaQualificationProvider({ config: nvidiaConfig(), fetchImpl: async () => jsonResponse(leaky, 401) });
    await assert.rejects(rejected.analyzeProspect({ messages: sampleMessages }), (e) => {
      assert.equal(e.code, 'PROVIDER_ERROR');
      assert.equal(e.providerCalled, false);
      assert.ok(!JSON.stringify({ message: e.message, detail: e.detail }).includes(FAKE_KEY));
      return true;
    });
    const serverError = createNvidiaQualificationProvider({ config: nvidiaConfig(), fetchImpl: async () => jsonResponse({}, 502) });
    await assert.rejects(serverError.analyzeProspect({ messages: sampleMessages }), (e) => e.code === 'PROVIDER_ERROR' && e.providerCalled === true);
    const network = createNvidiaQualificationProvider({
      config: nvidiaConfig(),
      fetchImpl: async () => {
        throw new TypeError('fetch failed');
      },
    });
    await assert.rejects(network.analyzeProspect({ messages: sampleMessages }), (e) => e.code === 'PROVIDER_ERROR' && e.providerCalled === true);
    const slow = createNvidiaQualificationProvider({
      config: nvidiaConfig({ timeoutMs: 30 }),
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) =>
          init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' }))),
        ),
    });
    await assert.rejects(slow.analyzeProspect({ messages: sampleMessages }), (e) => e.code === 'PROVIDER_TIMEOUT' && e.usage === null);
  });
});

describe('NVIDIA through the qualification pipeline (mocked endpoint)', () => {
  const logs = [];
  const logger = { error: (m) => logs.push(m), warn: (m) => logs.push(m) };
  const useNvidia = (respond) => {
    const mock = mockNvidia(respond);
    setQualificationProvider(createNvidiaQualificationProvider({ config: nvidiaConfig(), fetchImpl: mock.fetchImpl }));
    return mock;
  };
  const run = async (respond) => {
    const mock = useNvidia(respond);
    const { prospect, target } = await analysedProspect('B');
    const { qualification } = await requestQualification(target);
    const result = await createQualificationWorker({ logger }).runOnce();
    const doc = await ProspectQualification.findById(qualification.id);
    const ledger = await AiUsageRecord.findOne({ qualificationId: qualification.id });
    return { mock, prospect, target, result, doc, ledger };
  };

  before(startTestDb);
  after(stopTestDb);
  beforeEach(async () => {
    await clearDb();
    logs.length = 0;
  });
  afterEach(() => setQualificationProvider(null));

  it('stores a validated qualification; tokens are recorded and cost stays unknown (not $0)', async () => {
    const { mock, prospect, target, result, doc, ledger } = await run();
    const prospectBefore = JSON.stringify(await Prospect.findById(prospect._id).lean());
    const analysisBefore = JSON.stringify(await ProspectWebsiteAnalysis.findOne({ subjectKey: target.subjectKey }).lean());

    assert.equal(result.outcome, 'COMPLETED');
    assert.equal(mock.calls.length, 1);
    assert.equal(doc.provider, 'nvidia');
    assert.equal(doc.model, 'openai/gpt-oss-20b');
    assert.deepEqual(doc.opportunities.map((o) => o.serviceId).sort(), ['aeo', 'seo', 'social-media-marketing']);
    assert.equal(doc.usage.costStatus, 'UNAVAILABLE');
    assert.equal(doc.usage.costMicroUsd, null);
    assert.equal(doc.usage.totalTokens, 2000);
    assert.equal(ledger.status, 'UNAVAILABLE');
    assert.equal(ledger.reservedMicroUsd, 0);
    assert.equal(ledger.costMicroUsd ?? null, null);
    assert.deepEqual([ledger.inputTokens, ledger.outputTokens, ledger.totalTokens], [1100, 900, 2000]);

    const dto = await getQualificationFor(target);
    assert.equal(dto.status, 'COMPLETED');
    assert.equal(dto.usage.costUsd, null);
    assert.equal(dto.usage.costStatus, 'UNAVAILABLE');
    assert.equal(dto.isTestProvider, false);

    // A fresh result is reused: no second call.
    const again = await requestQualification(target);
    assert.equal(again.outcome, 'reused');
    assert.equal(mock.calls.length, 1);

    assert.equal(JSON.stringify(await Prospect.findById(prospect._id).lean()), prospectBefore);
    assert.equal(JSON.stringify(await ProspectWebsiteAnalysis.findOne({ subjectKey: target.subjectKey }).lean()), analysisBefore);
  });

  it('rejects malformed output and saves no qualification content', async () => {
    const { result, doc, ledger } = await run(() => completion('{"summary": "missing everything else"}'));
    assert.equal(result.outcome, 'FAILED');
    assert.equal(doc.errorCode, 'INVALID_AI_OUTPUT');
    assert.equal(doc.summary ?? null, null);
    assert.deepEqual(doc.opportunities ?? [], []);
    assert.equal(ledger.status, 'UNAVAILABLE');
    assert.equal(ledger.totalTokens, 2000);
  });

  it('drops opportunities with invalid evidence references, unknown services or unsupported claims', async () => {
    const { doc } = await run((payload) => {
      const out = deterministicOutput(payload);
      const [seo, aeo, social] = ['seo', 'aeo', 'social-media-marketing'].map((id) => out.opportunities.find((o) => o.serviceId === id));
      seo.evidenceReferences = ['E99'];
      aeo.reason = 'No structured data was found, so their Google rankings are poor.';
      social.reason = 'No Open Graph tags were found on the homepage.';
      out.opportunities.push({ ...social, serviceId: 'google-ads', serviceName: 'Google Ads' });
      return out;
    });
    assert.equal(doc.status, 'COMPLETED');
    assert.deepEqual(doc.opportunities.map((o) => o.serviceId), ['social-media-marketing']);
    assert.equal(doc.validation.droppedOpportunities, 3);
  });

  it('fails the whole output when the summary makes an unsupported claim', async () => {
    const { doc } = await run((payload) => ({ ...deterministicOutput(payload), summary: 'The bakery is losing customers to competitors.' }));
    assert.equal(doc.status, 'FAILED');
    assert.equal(doc.errorCode, 'INVALID_AI_OUTPUT');
  });

  it('releases the reservation on a rejected request and never leaks the key', async () => {
    const { result, doc, ledger } = await run(() => jsonResponse({ detail: `Invalid key ${FAKE_KEY}` }, 401));
    assert.equal(result.outcome, 'FAILED');
    assert.equal(doc.errorCode, 'PROVIDER_ERROR');
    assert.equal(ledger.status, 'RELEASED');
    const exposed = JSON.stringify([doc.toObject(), ledger.toObject(), logs, await getAiStatus()]);
    assert.ok(!exposed.includes(FAKE_KEY));
  });
});
