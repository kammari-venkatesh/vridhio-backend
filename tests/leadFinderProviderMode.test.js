import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import app from '../src/app.js';
import { leadFinderConfig } from '../src/config/leadFinder.js';
import { LeadFinderJob } from '../src/models/leadFinderJob.model.js';
import { Prospect } from '../src/models/prospect.model.js';
import { getSpendSummary } from '../src/services/leadFinder/cost.service.js';
import { createFakeProvider } from '../src/services/leadFinder/fakeProvider.js';
import { createJob, getJob } from '../src/services/leadFinder/leadFinderJob.service.js';
import { createLeadFinderWorker } from '../src/services/leadFinder/worker.js';
import { clearDb, createTestAdmin, loginAgent, startTestDb, stopTestDb } from './helpers/testDb.js';
import { FAKE_TOKEN, mockApify, placeItem, testApifyProvider } from './helpers/mockApify.js';

const JOBS = '/api/admin/lead-finder/jobs';
const SEARCH = { location: 'Gachibowli, Hyderabad', radius: 3, categories: ['Gyms'], maxBusinesses: 5 };
const silent = { error() {}, warn() {}, info() {} };
const noArea = async () => null;

let admin;
const savedBudget = { ...leadFinderConfig.budget };

/** Resolves provider names the way the registry does, recording every name asked for. */
const registryOf = (byName) => {
  const asked = [];
  const resolve = (name) => {
    asked.push(name);
    return byName[name];
  };
  return { resolve, asked };
};

const spyOn = (provider) => {
  const calls = [];
  return {
    calls,
    provider: {
      ...provider,
      name: provider.name,
      discoverBusinesses: async (...args) => {
        calls.push(args[0]);
        return provider.discoverBusinesses(...args);
      },
    },
  };
};

const createRealJob = (provider = testApifyProvider({ mock: mockApify() }), params = SEARCH, options = {}) =>
  createJob(params, admin._id, { provider: 'apify', apifyEnabled: true, resolveProvider: () => provider, geocode: noArea, ...options });

before(startTestDb);
after(stopTestDb);
beforeEach(async () => {
  await clearDb();
  admin = await createTestAdmin();
});
afterEach(() => {
  Object.assign(leadFinderConfig.budget, savedBudget);
});

describe('search mode: API', () => {
  it('requires an admin session for every search mode', async () => {
    for (const body of [SEARCH, { ...SEARCH, provider: 'test' }, { ...SEARCH, provider: 'apify', confirmRealSearch: true }]) {
      assert.equal((await request(app).post(JOBS).send(body)).status, 401);
    }
    assert.equal(await LeadFinderJob.countDocuments(), 0);
  });

  it('uses test data by default', async () => {
    const { agent } = await loginAgent(app);
    const res = await agent.post(JOBS).send(SEARCH);
    assert.equal(res.status, 202);
    assert.equal(res.body.data.job.provider, 'test');
    assert.equal(res.body.data.job.providerMode, 'test');
    assert.equal((await LeadFinderJob.findById(res.body.data.jobId)).provider, 'fake');
  });

  it('runs an explicit test search without any confirmation', async () => {
    const { agent } = await loginAgent(app);
    const res = await agent.post(JOBS).send({ ...SEARCH, provider: 'test' });
    assert.equal(res.status, 202);
    assert.equal(res.body.data.job.provider, 'test');
    assert.equal((await LeadFinderJob.findById(res.body.data.jobId)).provider, 'fake');
  });

  it('requires explicit confirmation for a real search', async () => {
    const { agent } = await loginAgent(app);
    for (const confirmRealSearch of [undefined, false]) {
      const res = await agent.post(JOBS).send({ ...SEARCH, provider: 'apify', confirmRealSearch });
      assert.equal(res.status, 400);
      assert.match(res.body.details.confirmRealSearch, /Apify credits/);
    }
    const stringly = await agent.post(JOBS).send({ ...SEARCH, provider: 'apify', confirmRealSearch: 'true' });
    assert.equal(stringly.status, 400);
    assert.equal(await LeadFinderJob.countDocuments(), 0);
  });

  it('rejects a real search with REAL_APIFY_DISABLED and never falls back to test data', async () => {
    const { agent } = await loginAgent(app);
    const res = await agent.post(JOBS).send({ ...SEARCH, provider: 'apify', confirmRealSearch: true });
    assert.equal(res.status, 503);
    assert.equal(res.body.details.code, 'REAL_APIFY_DISABLED');
    assert.match(res.body.message, /disabled on this server/);
    assert.equal(await LeadFinderJob.countDocuments(), 0, 'no job of any kind is queued');
    assert.equal(await Prospect.countDocuments(), 0);
  });

  it('rejects unknown search modes, including internal provider names', async () => {
    const { agent } = await loginAgent(app);
    for (const provider of ['fake', 'other', 'Apify', 'APIFY', '', null, 1]) {
      const res = await agent.post(JOBS).send({ ...SEARCH, provider, confirmRealSearch: true });
      assert.equal(res.status, 400, `provider ${JSON.stringify(provider)}`);
      assert.ok(res.body.details.provider);
    }
    assert.equal(await LeadFinderJob.countDocuments(), 0);
  });

  it('never accepts provider credentials or settings from the client', async () => {
    const { agent } = await loginAgent(app);
    for (const field of ['apifyToken', 'token', 'APIFY_TOKEN', 'actorId', 'maxTotalChargeUsd', 'costCapMicroUsd', 'apifyEnabled']) {
      const res = await agent.post(JOBS).send({ ...SEARCH, provider: 'apify', confirmRealSearch: true, [field]: FAKE_TOKEN });
      assert.equal(res.status, 400, field);
      assert.equal(res.body.details[field], 'This field is not allowed.');
      assert.doesNotMatch(JSON.stringify(res.body), new RegExp(FAKE_TOKEN));
    }
    assert.equal(await LeadFinderJob.countDocuments(), 0);
  });
});

describe('search mode: job creation', () => {
  it('stores an explicit Apify search as an Apify job with its cost cap', async () => {
    const job = await createRealJob();
    assert.equal(job.provider, 'apify');
    assert.equal(job.providerMode, 'live');
    assert.equal(job.cost.status, 'pending');

    const stored = await LeadFinderJob.findById(job.id);
    assert.equal(stored.provider, 'apify');
    assert.equal(stored.costCapMicroUsd, 500_000);
    const { today } = await getSpendSummary();
    assert.equal(today.reservedUsd, 0.5, 'the run cap is reserved against the budget');
  });

  it('rejects a real search when Apify is enabled but not configured', async () => {
    const provider = testApifyProvider({ mock: mockApify(), config: { actorId: '' } });
    await assert.rejects(createRealJob(provider), (err) => err.statusCode === 503 && err.details.code === 'REAL_APIFY_NOT_CONFIGURED');
    assert.equal(await LeadFinderJob.countDocuments(), 0);
  });

  it('rejects a real search when Apify is disabled, even with a configured provider', async () => {
    const mock = mockApify();
    await assert.rejects(
      createRealJob(testApifyProvider({ mock }), SEARCH, { apifyEnabled: false }),
      (err) => err.statusCode === 503 && err.details.code === 'REAL_APIFY_DISABLED',
    );
    assert.equal(await LeadFinderJob.countDocuments(), 0);
    assert.equal(mock.calls.start.length, 0);
  });

  it('rejects a real search over budget before queuing it', async () => {
    leadFinderConfig.budget.dailyUsd = 0.1; // below the 0.5 cap per run
    const mock = mockApify();
    await assert.rejects(createRealJob(testApifyProvider({ mock })), (err) => err.statusCode === 429);
    assert.equal(await LeadFinderJob.countDocuments(), 0);
    assert.equal(mock.calls.start.length, 0);
  });

  it('refuses a provider that does not match the requested mode', async () => {
    const configuredFake = { ...createFakeProvider(), getStatus: () => ({ configured: true }) };
    await assert.rejects(createRealJob(configuredFake), /Provider mismatch/);
    const apify = testApifyProvider({ mock: mockApify() });
    await assert.rejects(createJob(SEARCH, admin._id, { provider: 'test', resolveProvider: () => apify }), /Provider mismatch/);
    assert.equal(await LeadFinderJob.countDocuments(), 0);
  });

  it('never budgets test searches', async () => {
    leadFinderConfig.budget.dailyUsd = 0;
    const job = await createJob(SEARCH, admin._id, { provider: 'test' });
    assert.equal(job.cost.status, 'test');
    assert.equal((await LeadFinderJob.findById(job.id)).costCapMicroUsd, null);
  });
});

describe('search mode: worker', () => {
  it('never claims a real search on a server where Apify is disabled', async () => {
    const real = await createRealJob();
    const test = await createJob(SEARCH, admin._id, { provider: 'test' });
    const worker = createLeadFinderWorker({ logger: silent }); // test environment: Apify disabled
    assert.deepEqual(worker.providers, ['fake']);

    assert.equal((await worker.runOnce()).jobId, test.id);
    assert.equal(await worker.runOnce(), null);
    assert.equal((await LeadFinderJob.findById(real.id)).status, 'queued');
  });

  it('runs every job with the provider stored on it', async () => {
    const mock = mockApify({ items: [placeItem(1), placeItem(2)] });
    const apify = spyOn(testApifyProvider({ mock }));
    const fake = spyOn(createFakeProvider());
    const { resolve, asked } = registryOf({ apify: apify.provider, fake: fake.provider });
    const worker = createLeadFinderWorker({ resolveProvider: resolve, providers: ['fake', 'apify'], logger: silent });

    const real = await createRealJob();
    await worker.runOnce();
    assert.deepEqual(asked, ['apify']);
    assert.equal(apify.calls.length, 1);
    assert.equal(fake.calls.length, 0);
    assert.equal((await getJob(real.id)).provider, 'apify');
    assert.ok((await Prospect.find({ jobId: real.id })).every((p) => p.source === 'apify'));

    const test = await createJob(SEARCH, admin._id, { provider: 'test' });
    await worker.runOnce();
    assert.deepEqual(asked, ['apify', 'fake']);
    assert.equal(apify.calls.length, 1, 'a test search never calls Apify');
    assert.equal(fake.calls.length, 1);
    assert.equal(mock.calls.start.length, 1);
    assert.equal((await getJob(test.id)).provider, 'test');
  });

  it('fails a job instead of running it with a different provider', async () => {
    await createRealJob();
    const fake = spyOn(createFakeProvider());
    const worker = createLeadFinderWorker({ resolveProvider: () => fake.provider, providers: ['fake', 'apify'], logger: silent });

    const result = await worker.runOnce();
    assert.equal(result.outcome, 'failed');
    assert.equal(fake.calls.length, 0, 'test data is never returned for a real search');
    assert.equal(await Prospect.countDocuments(), 0);
  });

  it('only settles costs for providers it may run', async () => {
    const job = await createRealJob();
    await LeadFinderJob.updateOne(
      { _id: job.id },
      { $set: { status: 'completed', finishedAt: new Date(Date.now() - 120_000), 'providerRun.runId': 'run-1' } },
    );
    const asked = [];
    const worker = createLeadFinderWorker({
      resolveProvider: (name) => asked.push(name),
      logger: silent,
      costSettleDelayMs: 0,
    });
    assert.equal(await worker.settleCostsOnce(), null);
    assert.deepEqual(asked, []);
  });
});
