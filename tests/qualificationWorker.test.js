import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import mongoose from 'mongoose';
import { AiUsageRecord } from '../src/models/aiUsageRecord.model.js';
import { Prospect } from '../src/models/prospect.model.js';
import { ProspectQualification } from '../src/models/prospectQualification.model.js';
import { ProspectWebsiteAnalysis } from '../src/models/prospectWebsiteAnalysis.model.js';
import { checkAiBudget, getAiSpendSince, getAiSpendSummary } from '../src/services/qualification/aiBudget.service.js';
import { createFakeQualificationProvider, deterministicOutput } from '../src/services/qualification/providers/fakeProvider.js';
import { setQualificationProvider } from '../src/services/qualification/providers/index.js';
import { QualificationError } from '../src/services/qualification/qualificationErrors.js';
import { getQualificationFor, requestQualification } from '../src/services/qualification/qualification.service.js';
import { createQualificationWorker } from '../src/services/qualification/worker.js';
import { startOfUtcDay } from '../src/services/leadFinder/cost.service.js';
import { analysedProspect } from './helpers/qualification.js';
import { clearDb, startTestDb, stopTestDb } from './helpers/testDb.js';

const silent = { error() {}, warn() {} };

/** A fake provider that behaves like a paid one: an estimate, and cost from tokens. */
const paidFake = ({ estimate = 300_000, respond, usage } = {}) => ({
  ...createFakeQualificationProvider({ respond, usage }),
  name: 'openai',
  model: 'gpt-4o-mini',
  paid: true,
  estimateMaxCostMicroUsd: () => estimate,
  costMicroUsd: (u) => (u ? Math.ceil(u.inputTokens * 0.15 + u.outputTokens * 0.6) : null),
});

let provider;
const useProvider = (p) => {
  provider = p;
  setQualificationProvider(p);
};
const worker = () => createQualificationWorker({ logger: silent });

before(startTestDb);
after(stopTestDb);
beforeEach(async () => {
  await clearDb();
  useProvider(createFakeQualificationProvider());
});
afterEach(() => setQualificationProvider(null));

const queue = async (kind = 'B', overrides) => {
  const { prospect, target } = await analysedProspect(kind, overrides);
  const { qualification, outcome } = await requestQualification(target);
  assert.equal(outcome, 'queued');
  return { prospect, target, id: qualification.id };
};
const record = (id) => ProspectQualification.findById(id);
const ledger = (id) => AiUsageRecord.findOne({ qualificationId: id }).sort({ createdAt: -1 });

describe('Qualification worker', () => {
  it('B: stores a grounded qualification with model info and the evidence it used', async () => {
    const { id, target } = await queue('B');
    assert.deepEqual(await worker().runOnce(), { qualificationId: id, outcome: 'COMPLETED' });
    const doc = await record(id);
    assert.equal(doc.status, 'COMPLETED');
    assert.equal(doc.provider, 'fake');
    assert.equal(doc.model, 'fake-qualifier-1');
    assert.equal(doc.promptVersion, 'v2');
    assert.ok(doc.startedAt && doc.completedAt && doc.requestedAt);
    assert.equal(doc.lockedBy, null);
    assert.deepEqual(doc.opportunities.map((o) => o.serviceId).sort(), ['aeo', 'seo', 'social-media-marketing']);
    const snapshotIds = new Set(doc.evidenceSnapshot.map((e) => e.id));
    for (const o of doc.opportunities) assert.ok(o.evidenceReferences.every((r) => snapshotIds.has(r)));
    const analysis = await ProspectWebsiteAnalysis.findOne({ subjectKey: target.subjectKey });
    assert.equal(doc.analysisId.toString(), analysis.id);
    assert.equal(doc.analysisAnalyzedAt.getTime(), analysis.analyzedAt.getTime());
    assert.equal(doc.usage.costStatus, 'NONE');
    assert.equal((await ledger(id)).status, 'SETTLED');
  });

  it('A/C/D: no website, strong website and insufficient evidence', async () => {
    const a = await queue('A');
    const c = await queue('C');
    const d = await queue('D');
    const w = worker();
    while (await w.runOnce());
    assert.deepEqual((await record(a.id)).opportunities.map((o) => o.serviceId), ['website-development']);
    assert.deepEqual((await record(c.id)).opportunities, []);
    assert.deepEqual((await record(d.id)).opportunities, []);
    assert.equal((await record(d.id)).status, 'COMPLETED');
  });

  it('E: malformed output fails as INVALID_AI_OUTPUT and nothing is saved from it', async () => {
    useProvider(createFakeQualificationProvider({ respond: () => ({ summary: 42, opportunities: 'lots' }) }));
    const { id } = await queue('B');
    assert.equal((await worker().runOnce()).outcome, 'FAILED');
    const doc = await record(id);
    assert.equal(doc.errorCode, 'INVALID_AI_OUTPUT');
    assert.equal(doc.errorMessage, 'The AI response did not pass validation and was discarded.');
    assert.equal(doc.summary, null);
    assert.deepEqual(doc.opportunities, []);
    assert.ok(doc.failedAt);
  });

  it('F: nonexistent references are dropped and recorded in validation', async () => {
    useProvider(
      createFakeQualificationProvider({
        respond: (payload) => {
          const out = deterministicOutput(payload);
          out.opportunities[0].evidenceReferences = ['E404'];
          return out;
        },
      }),
    );
    const { id } = await queue('B');
    await worker().runOnce();
    const doc = await record(id);
    assert.equal(doc.status, 'COMPLETED');
    assert.equal(doc.opportunities.length, 2);
    assert.equal(doc.validation.droppedOpportunities, 1);
    assert.equal(doc.validation.droppedReferences, 1);
  });

  it('never modifies the prospect, sales lead or website analysis', async () => {
    const { id, prospect, target } = await queue('B');
    const before = {
      prospect: (await Prospect.findById(prospect.id).lean()),
      analysis: (await ProspectWebsiteAnalysis.findOne({ subjectKey: target.subjectKey }).lean()),
    };
    await worker().runOnce();
    assert.equal((await record(id)).status, 'COMPLETED');
    assert.deepEqual(await Prospect.findById(prospect.id).lean(), before.prospect);
    assert.deepEqual(await ProspectWebsiteAnalysis.findOne({ subjectKey: target.subjectKey }).lean(), before.analysis);
  });

  it('fails with ANALYSIS_REQUIRED if the analysis became unusable, without calling the provider', async () => {
    const { id, target } = await queue('B');
    await ProspectWebsiteAnalysis.deleteOne({ subjectKey: target.subjectKey });
    await worker().runOnce();
    assert.equal((await record(id)).errorCode, 'ANALYSIS_REQUIRED');
    assert.equal(provider.requests.length, 0);
    assert.equal((await ledger(id)).status, 'RELEASED');
  });

  it('discards the result if it lost ownership while running', async () => {
    useProvider(
      createFakeQualificationProvider({
        respond: async (payload) => {
          await ProspectQualification.updateMany({}, { $set: { lockedBy: 'someone-else' } });
          return deterministicOutput(payload);
        },
      }),
    );
    const { id } = await queue('B');
    assert.equal((await worker().runOnce()).outcome, 'LOST');
    assert.notEqual((await record(id)).status, 'COMPLETED');
  });

  it('recovers stale qualifications and settles their ledger entries', async () => {
    const one = await queue('B');
    const two = await queue('C');
    const old = new Date(Date.now() - 10 * 60 * 1000);
    await ProspectQualification.updateMany({}, { $set: { status: 'ANALYZING', heartbeatAt: old, lockedBy: 'dead-worker' } });
    await AiUsageRecord.updateOne({ qualificationId: one.id }, { $set: { providerCalledAt: old } });
    assert.equal(await worker().recoverStale(), 2);
    for (const q of [one, two]) {
      const doc = await record(q.id);
      assert.equal(doc.status, 'FAILED');
      assert.equal(doc.errorCode, 'INTERRUPTED');
    }
    assert.equal((await ledger(one.id)).status, 'UNAVAILABLE');
    assert.equal((await ledger(two.id)).status, 'RELEASED');
  });

  it('start/stop processes queued work in the background', async () => {
    const { id } = await queue('B');
    const w = createQualificationWorker({ logger: silent, pollIntervalMs: 10 });
    w.start();
    for (let i = 0; i < 100 && (await record(id)).status !== 'COMPLETED'; i++) await new Promise((r) => setTimeout(r, 20));
    await w.stop();
    assert.equal((await record(id)).status, 'COMPLETED');
  });
});

describe('AI budget and cost tracking', () => {
  it('sums settled, reserved and unavailable spend; released attempts count nothing', async () => {
    const qualificationId = new mongoose.Types.ObjectId();
    await AiUsageRecord.create([
      { qualificationId, provider: 'openai', status: 'SETTLED', reservedMicroUsd: 900, costMicroUsd: 300 },
      { qualificationId, provider: 'openai', status: 'RESERVED', reservedMicroUsd: 1000 },
      { qualificationId, provider: 'openai', status: 'UNAVAILABLE', reservedMicroUsd: 2000 },
      { qualificationId, provider: 'openai', status: 'RELEASED', reservedMicroUsd: 5000 },
    ]);
    assert.deepEqual(await getAiSpendSince(startOfUtcDay()), { settledMicroUsd: 300, reservedMicroUsd: 1000, unavailableMicroUsd: 2000 });
    const summary = await getAiSpendSummary();
    assert.equal(summary.today.committedUsd, 0.0033);
    assert.equal(summary.today.unavailableUsd, 0.002);
    assert.equal(summary.today.budgetUsd, 1);
  });

  it('refuses work that would exceed the daily or monthly budget', async () => {
    const qualificationId = new mongoose.Types.ObjectId();
    await AiUsageRecord.create({ qualificationId, provider: 'openai', status: 'SETTLED', costMicroUsd: 900_000 });
    assert.equal(await checkAiBudget({ estimateMicroUsd: 100_000 }), null);
    assert.match(await checkAiBudget({ estimateMicroUsd: 100_001 }), /Today's AI qualification budget/);
    assert.match(await checkAiBudget({ estimateMicroUsd: 1, budget: { dailyUsd: null, monthlyUsd: 0.5 } }), /This month's/);
    assert.equal(await checkAiBudget({ estimateMicroUsd: 10_000_000, budget: { dailyUsd: null, monthlyUsd: null } }), null);
  });

  it('reserves the estimate at request time and rejects requests beyond the budget', async () => {
    useProvider(paidFake({ estimate: 400_000 }));
    await queue('B');
    await queue('C');
    const { target } = await analysedProspect('A');
    await assert.rejects(requestQualification(target), (e) => e.statusCode === 429 && e.details.code === 'BUDGET_EXCEEDED');
    assert.equal(await AiUsageRecord.countDocuments({ status: 'RESERVED' }), 2);
    assert.equal(await ProspectQualification.countDocuments(), 2);
  });

  it('settles the actual cost from reported tokens', async () => {
    useProvider(paidFake({ estimate: 400_000, usage: { inputTokens: 1000, outputTokens: 200 } }));
    const { id, target } = await queue('B');
    await worker().runOnce();
    const entry = await ledger(id);
    assert.equal(entry.status, 'SETTLED');
    assert.equal(entry.costMicroUsd, 270);
    assert.equal(entry.totalTokens, 1200);
    assert.ok(entry.providerCalledAt && entry.settledAt);
    const dto = await getQualificationFor(target);
    assert.deepEqual(dto.usage, { inputTokens: 1000, outputTokens: 200, totalTokens: 1200, costUsd: 0.00027, costStatus: 'SETTLED' });
    assert.deepEqual(await getAiSpendSince(startOfUtcDay()), { settledMicroUsd: 270, reservedMicroUsd: 0, unavailableMicroUsd: 0 });
  });

  it('re-checks the budget before calling the provider and releases the reservation if over', async () => {
    useProvider(paidFake({ estimate: 400_000 }));
    const { id } = await queue('B');
    await AiUsageRecord.create({ qualificationId: new mongoose.Types.ObjectId(), provider: 'openai', status: 'SETTLED', costMicroUsd: 700_000 });
    await worker().runOnce();
    assert.equal((await record(id)).errorCode, 'BUDGET_EXCEEDED');
    assert.equal(provider.requests.length, 0);
    assert.equal((await ledger(id)).status, 'RELEASED');
  });

  it('keeps the full reservation when the provider was called but usage is unknown', async () => {
    useProvider(
      paidFake({
        estimate: 5000,
        respond: () => {
          throw new QualificationError('PROVIDER_TIMEOUT', { providerCalled: true });
        },
      }),
    );
    const { id, target } = await queue('B');
    await worker().runOnce();
    const doc = await record(id);
    assert.equal(doc.errorCode, 'PROVIDER_TIMEOUT');
    assert.equal(doc.usage.costStatus, 'UNAVAILABLE');
    assert.equal((await ledger(id)).status, 'UNAVAILABLE');
    assert.equal((await getAiSpendSince(startOfUtcDay())).unavailableMicroUsd, 5000);
    const dto = await getQualificationFor(target);
    assert.equal(dto.usage.costUsd, null, 'unknown cost is never shown as $0');
    assert.equal(dto.usage.costStatus, 'UNAVAILABLE');
  });

  it('charges reported tokens for rejected output', async () => {
    useProvider(
      paidFake({
        respond: () => {
          throw new QualificationError('INVALID_AI_OUTPUT', { providerCalled: true, usage: { inputTokens: 800, outputTokens: 1200, totalTokens: 2000 } });
        },
      }),
    );
    const { id } = await queue('B');
    await worker().runOnce();
    const entry = await ledger(id);
    assert.equal(entry.status, 'SETTLED');
    assert.equal(entry.costMicroUsd, Math.ceil(800 * 0.15 + 1200 * 0.6));
    assert.equal((await record(id)).usage.costStatus, 'SETTLED');
  });

  it('releases the reservation when the provider rejected the request before processing it', async () => {
    useProvider(
      paidFake({
        respond: () => {
          throw new QualificationError('PROVIDER_ERROR', { providerCalled: false, detail: 'HTTP 401' });
        },
      }),
    );
    const { id } = await queue('B');
    await worker().runOnce();
    assert.equal((await record(id)).errorCode, 'PROVIDER_ERROR');
    assert.equal((await ledger(id)).status, 'RELEASED');
  });

  it('keeps spend history when a qualification is refreshed', async () => {
    useProvider(paidFake({ estimate: 1000, usage: { inputTokens: 1000, outputTokens: 100 } }));
    const { id, target } = await queue('B');
    await worker().runOnce();
    await ProspectQualification.updateOne({ _id: id }, { $set: { requestedAt: new Date(Date.now() - 60 * 60 * 1000) } });
    const { outcome } = await requestQualification(target, { refresh: true });
    assert.equal(outcome, 'queued');
    await worker().runOnce();
    assert.equal(await AiUsageRecord.countDocuments({ qualificationId: id, status: 'SETTLED' }), 2);
    assert.equal((await getAiSpendSince(startOfUtcDay())).settledMicroUsd, 2 * Math.ceil(1000 * 0.15 + 100 * 0.6));
  });
});
