import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import mongoose from 'mongoose';
import request from 'supertest';
import app from '../src/app.js';
import { AdminUser } from '../src/models/adminUser.model.js';
import { AiUsageRecord } from '../src/models/aiUsageRecord.model.js';
import { ProspectQualification } from '../src/models/prospectQualification.model.js';
import { ProspectWebsiteAnalysis } from '../src/models/prospectWebsiteAnalysis.model.js';
import { SalesLead } from '../src/models/salesLead.model.js';
import { createFakeQualificationProvider, deterministicOutput } from '../src/services/qualification/providers/fakeProvider.js';
import { setQualificationProvider } from '../src/services/qualification/providers/index.js';
import { SYSTEM_PROMPT } from '../src/services/qualification/prompt.js';
import { createQualificationWorker } from '../src/services/qualification/worker.js';
import { analyseProspect, analysedProspect, newProspect } from './helpers/qualification.js';
import { clearDb, createTestAdmin, loginAgent, startTestDb, stopTestDb, TEST_ADMIN } from './helpers/testDb.js';

const LF = '/api/admin/lead-finder';
const LEADS = '/api/admin/leads';
const qualifyPath = (id) => `${LF}/prospects/${id}/qualify`;
const qualificationPath = (id) => `${LF}/prospects/${id}/qualification`;
const silent = { error() {}, warn() {} };
const FORBIDDEN_KEYS = ['lockedBy', 'heartbeatAt', 'requestedBy', 'usageRecordId', 'messages', 'prompt', 'rawResponse', 'apiKey'];

let agent;
let provider;
const useProvider = (p) => {
  provider = p;
  setQualificationProvider(p);
};
const runWorker = async () => {
  const w = createQualificationWorker({ logger: silent });
  const outcomes = [];
  for (let r = await w.runOnce(); r; r = await w.runOnce()) outcomes.push(r.outcome);
  return outcomes;
};
const keysDeep = (value, out = new Set()) => {
  if (Array.isArray(value)) value.forEach((v) => keysDeep(v, out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) out.add(k) && keysDeep(v, out);
  return out;
};
const assertNoInternals = (body) => {
  const keys = keysDeep(body);
  for (const k of FORBIDDEN_KEYS) assert.ok(!keys.has(k), `response must not include ${k}`);
  const json = JSON.stringify(body);
  assert.ok(!json.includes(SYSTEM_PROMPT.slice(0, 60)), 'response must not include the prompt');
};

before(startTestDb);
after(stopTestDb);
beforeEach(async () => {
  await clearDb();
  await createTestAdmin();
  useProvider(createFakeQualificationProvider());
  ({ agent } = await loginAgent(app));
});
afterEach(() => setQualificationProvider(null));

describe('Qualification API: access and availability', () => {
  it('requires an authenticated admin for every endpoint', async () => {
    const { prospect } = await analysedProspect('B');
    const lead = await SalesLead.create({ businessName: 'Manual Co' });
    const anon = request(app);
    for (const res of [
      await anon.post(qualifyPath(prospect.id)),
      await anon.post(`${qualifyPath(prospect.id)}/refresh`),
      await anon.get(qualificationPath(prospect.id)),
      await anon.post(`${LEADS}/${lead.id}/qualify`),
      await anon.post(`${LEADS}/${lead.id}/qualify/refresh`),
      await anon.get(`${LEADS}/${lead.id}/qualification`),
      await anon.post(`${LEADS}/qualification/bulk`).send({ ids: [lead.id] }),
      await anon.get(`${LEADS}/qualification-status?ids=${lead.id}`),
      await anon.get(`${LF}/ai/status`),
    ]) {
      assert.equal(res.status, 401);
    }
    await AdminUser.collection.updateOne({ email: TEST_ADMIN.email }, { $set: { role: 'viewer' } });
    assert.equal((await agent.post(qualifyPath(prospect.id))).status, 403);
    assert.equal(await ProspectQualification.countDocuments(), 0);
  });

  it('validates IDs and bodies', async () => {
    const { prospect } = await analysedProspect('B');
    assert.equal((await agent.post(qualifyPath('nope'))).status, 404);
    assert.equal((await agent.get(qualificationPath(new mongoose.Types.ObjectId().toString()))).status, 404);
    assert.equal((await agent.post(qualifyPath(prospect.id)).send({ refresh: 'yes' })).status, 400);
    assert.equal((await agent.post(qualifyPath(prospect.id)).send({ model: 'gpt-4o' })).status, 400);
    const tooMany = Array.from({ length: 11 }, () => new mongoose.Types.ObjectId().toString());
    assert.equal((await agent.post(`${LEADS}/qualification/bulk`).send({ ids: tooMany })).status, 400);
    assert.equal((await agent.post(`${LEADS}/qualification/bulk`).send({ ids: ['x'] })).status, 400);
  });

  it('reports AI as disabled by default and refuses to queue', async () => {
    setQualificationProvider(null);
    const { prospect } = await analysedProspect('B');
    const res = await agent.post(qualifyPath(prospect.id));
    assert.equal(res.status, 503);
    assert.equal(res.body.message, 'AI qualification is turned off on this server.');
    assert.equal(res.body.details.code, 'AI_DISABLED');
    const get = await agent.get(qualificationPath(prospect.id));
    assert.equal(get.body.data.status, 'NOT_ANALYZED');
    assert.equal(get.body.data.ai.mode, 'disabled');
    const status = await agent.get(`${LF}/ai/status`);
    assert.equal(status.body.data.mode, 'disabled');
    assert.equal(await ProspectQualification.countDocuments(), 0);
    assert.equal(await AiUsageRecord.countDocuments(), 0);
  });

  it('exposes provider mode and spend, never credentials', async () => {
    const res = await agent.get(`${LF}/ai/status`);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.mode, 'test');
    assert.equal(res.body.data.promptVersion, 'v2');
    assert.equal(res.body.data.spend.today.budgetUsd, 1);
    assert.equal(res.body.data.spend.month.budgetUsd, 10);
    assert.ok(!/sk-|apiKey|OPENAI_API_KEY=/.test(JSON.stringify(res.body)));
  });
});

describe('Qualification API: ANALYSIS_REQUIRED', () => {
  it('never starts a website analysis', async () => {
    const prospect = await newProspect();
    const get = await agent.get(qualificationPath(prospect.id));
    assert.equal(get.status, 200);
    assert.equal(get.body.data.status, 'ANALYSIS_REQUIRED');
    assert.equal(get.body.data.errorMessage, 'Run the website analysis for this business first.');
    const post = await agent.post(qualifyPath(prospect.id));
    assert.equal(post.status, 409);
    assert.equal(post.body.details.code, 'ANALYSIS_REQUIRED');
    assert.equal(await ProspectWebsiteAnalysis.countDocuments(), 0);
    assert.equal(await ProspectQualification.countDocuments(), 0);
  });

  it('applies to analyses that are queued, interrupted, or for a different website', async () => {
    const { prospect, target } = await analysedProspect('B');
    await ProspectWebsiteAnalysis.updateOne({ subjectKey: target.subjectKey }, { $set: { status: 'FAILED', errorCode: 'INTERRUPTED' } });
    assert.equal((await agent.post(qualifyPath(prospect.id))).status, 409);
    await ProspectWebsiteAnalysis.updateOne({ subjectKey: target.subjectKey }, { $set: { status: 'QUEUED', errorCode: null } });
    assert.equal((await agent.post(qualifyPath(prospect.id))).status, 409);
    await ProspectWebsiteAnalysis.updateOne({ subjectKey: target.subjectKey }, { $set: { status: 'COMPLETED', 'website.websiteUrl': 'https://old-site.example/' } });
    assert.equal((await agent.post(qualifyPath(prospect.id))).status, 409);
  });
});

describe('Qualification API: lifecycle', () => {
  it('queues, processes and returns a qualification without internals', async () => {
    const { prospect } = await analysedProspect('B');
    const queued = await agent.post(qualifyPath(prospect.id));
    assert.equal(queued.status, 202);
    assert.equal(queued.body.data.outcome, 'queued');
    assert.equal(queued.body.data.qualification.status, 'QUEUED');
    assert.ok(queued.body.data.qualification.requestedAt);

    const again = await agent.post(qualifyPath(prospect.id));
    assert.equal(again.status, 200);
    assert.equal(again.body.data.outcome, 'in_progress');

    assert.deepEqual(await runWorker(), ['COMPLETED']);
    const res = await agent.get(qualificationPath(prospect.id));
    const q = res.body.data;
    assert.equal(q.status, 'COMPLETED');
    assert.equal(q.isTestProvider, true);
    assert.equal(q.fresh, true);
    assert.ok(q.summary.split(/\s+/).length <= 60);
    assert.ok(['HIGH', 'MEDIUM', 'LOW'].includes(q.confidence));
    assert.ok(q.opportunities.length > 0);
    for (const o of q.opportunities) {
      assert.deepEqual(Object.keys(o).sort(), ['confidence', 'evidenceReferences', 'priority', 'reason', 'serviceId', 'serviceName']);
      for (const ref of o.evidenceReferences) assert.ok(q.evidence.some((e) => e.id === ref));
    }
    assert.ok(q.recommendedNextAction.length <= 200);
    assert.ok(q.missingInformation.length <= 8);
    assert.equal(q.usage.costStatus, 'NONE');
    assertNoInternals(res.body);
  });

  it('reuses a fresh qualification and enforces the refresh cooldown', async () => {
    const { prospect } = await analysedProspect('B');
    await agent.post(qualifyPath(prospect.id));
    await runWorker();
    const reused = await agent.post(qualifyPath(prospect.id));
    assert.equal(reused.status, 200);
    assert.equal(reused.body.data.outcome, 'reused');
    assert.equal(await AiUsageRecord.countDocuments(), 1);

    const tooSoon = await agent.post(`${qualifyPath(prospect.id)}/refresh`);
    assert.equal(tooSoon.status, 429);
    assert.match(tooSoon.body.message, /less than 10 minutes ago/);

    await ProspectQualification.updateMany({}, { $set: { requestedAt: new Date(Date.now() - 11 * 60 * 1000) } });
    const refreshed = await agent.post(qualifyPath(prospect.id)).send({ refresh: true });
    assert.equal(refreshed.status, 202);
    await runWorker();
    assert.equal(await AiUsageRecord.countDocuments(), 2);
    assert.equal(await ProspectQualification.countDocuments(), 1);
  });

  it('re-qualifies after the freshness window', async () => {
    const { prospect } = await analysedProspect('B');
    await agent.post(qualifyPath(prospect.id));
    await runWorker();
    const old = new Date(Date.now() - 8 * 86_400_000);
    await ProspectQualification.updateMany({}, { $set: { completedAt: old, requestedAt: old } });
    assert.equal((await agent.get(qualificationPath(prospect.id))).body.data.fresh, false);
    assert.equal((await agent.post(qualifyPath(prospect.id))).status, 202);
  });

  it('marks a qualification STALE when the website is analysed again', async () => {
    const { prospect } = await analysedProspect('B');
    await agent.post(qualifyPath(prospect.id));
    await runWorker();
    await ProspectWebsiteAnalysis.updateMany({}, { $set: { analyzedAt: new Date(Date.now() + 1000) } });
    const stale = (await agent.get(qualificationPath(prospect.id))).body.data;
    assert.equal(stale.status, 'STALE');
    assert.match(stale.staleReason, /analysed again/);
    assert.equal(stale.fresh, false);
    assert.equal((await agent.post(qualifyPath(prospect.id))).status, 202);
  });

  it('shows failures with a safe message and reuses them during the cooldown', async () => {
    useProvider(createFakeQualificationProvider({ respond: () => ({ nonsense: true }) }));
    const { prospect } = await analysedProspect('B');
    await agent.post(qualifyPath(prospect.id));
    await runWorker();
    const failed = (await agent.get(qualificationPath(prospect.id))).body.data;
    assert.equal(failed.status, 'FAILED');
    assert.equal(failed.errorCode, 'INVALID_AI_OUTPUT');
    assert.equal(failed.summary, null);
    assert.equal((await agent.post(qualifyPath(prospect.id))).body.data.outcome, 'reused');
  });

  it('refuses new work when the queue is full', async () => {
    const { prospect } = await analysedProspect('B');
    await ProspectQualification.insertMany(
      Array.from({ length: 50 }, (_, i) => ({ subjectKey: `prospect:filler${i}`, status: 'QUEUED', requestedAt: new Date() })),
    );
    const res = await agent.post(qualifyPath(prospect.id));
    assert.equal(res.status, 429);
    assert.match(res.body.message, /queue is full/);
  });
});

describe('Qualification API: sales leads', () => {
  it('shares one qualification between a prospect and the lead made from it', async () => {
    const { prospect } = await analysedProspect('B');
    await agent.post(qualifyPath(prospect.id));
    await runWorker();
    const promoted = await agent.post(`${LF}/prospects/${prospect.id}/promote`);
    assert.ok([200, 201].includes(promoted.status));
    const leadId = promoted.body.data.lead?.id ?? promoted.body.data.id;
    const fromLead = (await agent.get(`${LEADS}/${leadId}/qualification`)).body.data;
    const fromProspect = (await agent.get(qualificationPath(prospect.id))).body.data;
    assert.equal(fromLead.id, fromProspect.id);
    assert.equal(fromLead.status, 'COMPLETED');
    assert.equal((await agent.post(`${LEADS}/${leadId}/qualify`)).body.data.outcome, 'reused');

    const list = await agent.get(LEADS);
    const row = list.body.data.find((l) => l.id === leadId);
    assert.equal(row.qualification.status, 'COMPLETED');
    assert.deepEqual(row.qualification.serviceIds.sort(), fromProspect.opportunities.map((o) => o.serviceId).sort());
    assert.equal((await agent.get(`${LEADS}/${leadId}`)).body.data.qualification.status, 'COMPLETED');
  });

  it('qualifies a manual lead with no website from NO_WEBSITE evidence', async () => {
    const lead = await SalesLead.create({ businessName: 'Corner Tailor', city: 'Pune' });
    assert.equal((await agent.get(`${LEADS}/${lead.id}/qualification`)).body.data.status, 'ANALYSIS_REQUIRED');
    assert.equal((await agent.post(`${LEADS}/${lead.id}/analyze`)).status, 200);
    assert.equal((await agent.post(`${LEADS}/${lead.id}/qualify`)).status, 202);
    await runWorker();
    const q = (await agent.get(`${LEADS}/${lead.id}/qualification`)).body.data;
    assert.equal(q.status, 'COMPLETED');
    assert.deepEqual(q.opportunities.map((o) => o.serviceId), ['website-development']);
    assert.equal(q.evidence[0].type, 'NO_WEBSITE');
  });

  it('never changes the lead record, including potential services', async () => {
    const { prospect } = await analysedProspect('B');
    const promoted = await agent.post(`${LF}/prospects/${prospect.id}/promote`);
    const leadId = promoted.body.data.lead?.id ?? promoted.body.data.id;
    const before = await SalesLead.findById(leadId).lean();
    await agent.post(`${LEADS}/${leadId}/qualify`);
    await runWorker();
    assert.deepEqual(await SalesLead.findById(leadId).lean(), before);
  });

  it('bulk-queues leads with per-lead outcomes and reports statuses', async () => {
    const { prospect: a } = await analysedProspect('B', { businessName: 'Bakery A', phone: null });
    const { prospect: b } = await analysedProspect('C', { businessName: 'Dental B', phone: null });
    const leadA = (await agent.post(`${LF}/prospects/${a.id}/promote`)).body.data;
    const leadB = (await agent.post(`${LF}/prospects/${b.id}/promote`)).body.data;
    const noAnalysis = await SalesLead.create({ businessName: 'Unanalysed Co', website: 'https://weak.example/' });
    const ids = [leadA.lead?.id ?? leadA.id, leadB.lead?.id ?? leadB.id, noAnalysis.id, new mongoose.Types.ObjectId().toString()];
    const res = await agent.post(`${LEADS}/qualification/bulk`).send({ ids });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.queued, 2);
    assert.equal(res.body.data.analysisRequired, 1);
    assert.equal(res.body.data.rejected, 1);
    await runWorker();
    const statuses = (await agent.get(`${LEADS}/qualification-status?ids=${ids.slice(0, 3).join(',')}`)).body.data;
    assert.equal(statuses[ids[0]].status, 'COMPLETED');
    assert.equal(statuses[ids[1]].status, 'COMPLETED');
    assert.deepEqual(statuses[ids[1]].serviceIds, []);
    assert.equal(statuses[ids[2]].status, 'ANALYSIS_REQUIRED');
  });

  it('stops a bulk request at the budget limit', async () => {
    useProvider({ ...createFakeQualificationProvider(), name: 'openai', paid: true, estimateMaxCostMicroUsd: () => 600_000, costMicroUsd: () => 0 });
    const leads = [];
    for (const kind of ['B', 'C', 'A']) {
      const { prospect } = await analysedProspect(kind, { businessName: `Business ${kind}`, phone: null });
      const body = (await agent.post(`${LF}/prospects/${prospect.id}/promote`)).body.data;
      leads.push(body.lead?.id ?? body.id);
    }
    const res = await agent.post(`${LEADS}/qualification/bulk`).send({ ids: leads });
    assert.equal(res.body.data.queued, 1);
    assert.equal(res.body.data.rejected, 1);
    assert.equal(res.body.data.skipped, 1);
    assert.match(res.body.data.results[1].message, /budget/);
  });
});

describe('Qualification API: fixtures through the full stack', () => {
  it('A-F produce grounded results or safe failures', async () => {
    const outcomes = {};
    for (const kind of ['A', 'C', 'D']) {
      const { prospect } = await analysedProspect(kind);
      await agent.post(qualifyPath(prospect.id));
      await runWorker();
      outcomes[kind] = (await agent.get(qualificationPath(prospect.id))).body.data;
    }
    assert.deepEqual(outcomes.A.opportunities.map((o) => o.serviceId), ['website-development']);
    assert.deepEqual(outcomes.C.opportunities, []);
    assert.deepEqual(outcomes.D.opportunities, []);

    useProvider(
      createFakeQualificationProvider({
        respond: (payload) => ({ ...deterministicOutput(payload), opportunities: [{ ...deterministicOutput(payload).opportunities[0], evidenceReferences: ['E77'] }] }),
      }),
    );
    const { prospect: f } = await analysedProspect('B');
    await agent.post(qualifyPath(f.id));
    await runWorker();
    const resultF = (await agent.get(qualificationPath(f.id))).body.data;
    assert.equal(resultF.status, 'COMPLETED');
    assert.deepEqual(resultF.opportunities, []);
    assert.equal(resultF.validation.droppedReferences, 1);

    useProvider(createFakeQualificationProvider({ respond: () => 'not json at all' }));
    const e = await newProspect({ website: 'https://strong.example/' });
    await analyseProspect(e);
    await agent.post(qualifyPath(e.id));
    await runWorker();
    assert.equal((await agent.get(qualificationPath(e.id))).body.data.errorCode, 'INVALID_AI_OUTPUT');
    assert.ok(provider.requests.length >= 1);
  });
});
