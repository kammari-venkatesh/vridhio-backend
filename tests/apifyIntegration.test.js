import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import request from 'supertest';
import app from '../src/app.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { ApiError } from '../src/utils/ApiError.js';
import { LeadFinderJob } from '../src/models/leadFinderJob.model.js';
import { Prospect } from '../src/models/prospect.model.js';
import { cancelJob, createJob, getJob } from '../src/services/leadFinder/leadFinderJob.service.js';
import { listProspectsForJob } from '../src/services/leadFinder/prospect.service.js';
import { SAFE_PROVIDER_MESSAGES } from '../src/services/leadFinder/provider.interface.js';
import { createLeadFinderWorker } from '../src/services/leadFinder/worker.js';
import { clearDb, createTestAdmin, loginAgent, startTestDb, stopTestDb } from './helpers/testDb.js';
import { apiError, FAKE_TOKEN, mockApify, placeItem, testApifyProvider } from './helpers/mockApify.js';

const PARAMS = { location: 'Hyderabad', radius: 5, categories: ['Gyms'], maxBusinesses: 10 };
const silent = { error() {}, warn() {}, info() {} };

let admin;

const workerWith = (provider, options = {}) =>
  createLeadFinderWorker({ resolveProvider: () => provider, providers: ['fake', 'apify'], logger: silent, ...options });

// A real search as the API creates it: provider "apify" on a server where Apify is enabled and configured.
const createApifyJob = (params = PARAMS, provider = testApifyProvider({ mock: mockApify() })) =>
  createJob(params, admin._id, { provider: 'apify', apifyEnabled: true, resolveProvider: () => provider, geocode: async () => null });

before(startTestDb);
after(stopTestDb);
beforeEach(async () => {
  await clearDb();
  admin = await createTestAdmin();
});

describe('Apify discovery through the worker (mocked Apify)', () => {
  it('runs the job end to end: start, poll, dataset, normalisation, prospects', async () => {
    const job = await createApifyJob();
    let statusAtStart;
    const items = [
      placeItem(1),
      placeItem(2),
      placeItem(1, { searchString: 'fitness' }), // same place again
      placeItem(3, { website: 'javascript:alert(1)', location: { lat: 999, lng: 78.4 } }),
      { title: 'No place ID' },
      null,
      'garbage',
    ];
    const mock = mockApify({
      items,
      onStart: async () => {
        statusAtStart = (await LeadFinderJob.findById(job.id)).status;
      },
    });

    const result = await workerWith(testApifyProvider({ mock })).runOnce();

    assert.deepEqual(result, { jobId: job.id, outcome: 'completed' });
    assert.equal(statusAtStart, 'running');
    assert.equal(mock.calls.start.length, 1, 'the Actor is started exactly once');

    const stored = await LeadFinderJob.findById(job.id);
    assert.equal(stored.status, 'completed');
    assert.deepEqual(
      stored.toObject().progress,
      {
        total: 7,
        invalid: 3,
        closed: 0,
        outsideRadius: 0,
        missingCoordinates: 0,
        discovered: 3,
        processed: 3,
        newProspects: 3,
        qualified: 0,
      },
    );
    assert.equal(stored.providerRun.runId, 'run-test-1');
    assert.equal(stored.providerRun.datasetId, 'dataset-test-1');

    const prospects = await Prospect.find().sort({ sourceId: 1 });
    assert.deepEqual(prospects.map((p) => p.sourceId), ['ChIJtestPlace1', 'ChIJtestPlace2', 'ChIJtestPlace3']);
    assert.ok(prospects.every((p) => p.source === 'apify'));
    assert.equal(prospects[0].city, 'Hyderabad');
    assert.equal(prospects[0].country, 'IN');
    assert.equal(prospects[2].website, null, 'unsafe website dropped');
    assert.equal(prospects[2].latitude, null, 'out-of-range coordinate dropped');
  });

  it('never returns provider run IDs from the API', async () => {
    const job = await createApifyJob();
    await workerWith(testApifyProvider({ mock: mockApify({ items: [placeItem(1)] }) })).runOnce();

    const dto = await getJob(job.id);
    const listed = await listProspectsForJob(job.id, { page: 1, limit: 10 });
    const body = JSON.stringify({ dto, listed });
    assert.doesNotMatch(body, /run-test-1|dataset-test-1|providerRun|lockedBy/);
    assert.match(body, /"city":"Hyderabad"/);
  });

  it('does not duplicate businesses found again by a later search', async () => {
    await createApifyJob();
    await workerWith(testApifyProvider({ mock: mockApify({ items: [placeItem(1), placeItem(2)] }) })).runOnce();

    const second = await createApifyJob();
    await workerWith(testApifyProvider({ mock: mockApify({ items: [placeItem(2), placeItem(3)] }) })).runOnce();

    assert.equal(await Prospect.countDocuments(), 3);
    const stored = await LeadFinderJob.findById(second.id);
    assert.equal(stored.progress.newProspects, 1);
    assert.equal(stored.progress.processed, 2);
  });

  it('marks the job failed with a safe message when Apify rejects the request', async () => {
    const job = await createApifyJob();
    const errors = [];
    const mock = mockApify({ startError: apiError(401) });

    const result = await workerWith(testApifyProvider({ mock }), { logger: { error: (m) => errors.push(m) } }).runOnce();

    assert.equal(result.outcome, 'failed');
    const stored = await LeadFinderJob.findById(job.id);
    assert.equal(stored.error, SAFE_PROVIDER_MESSAGES.PROVIDER_AUTH_ERROR);
    assert.doesNotMatch(JSON.stringify({ stored, errors }), new RegExp(FAKE_TOKEN));
  });

  it('marks the job failed when the Actor run fails', async () => {
    const job = await createApifyJob();
    await workerWith(testApifyProvider({ mock: mockApify({ statuses: ['RUNNING', 'FAILED'] }) })).runOnce();
    const stored = await LeadFinderJob.findById(job.id);
    assert.equal(stored.status, 'failed');
    assert.equal(stored.error, SAFE_PROVIDER_MESSAGES.PROVIDER_FAILED);
    assert.equal(await Prospect.countDocuments(), 0);
  });

  it('cancels a running Apify job: stops waiting, aborts the run and never completes', async () => {
    const job = await createApifyJob();
    const mock = mockApify({
      statuses: ['RUNNING'],
      items: [placeItem(1)],
      onGet: async (n) => n === 1 && cancelJob(job.id),
    });
    const provider = testApifyProvider({ mock, config: { pollIntervalSeconds: 0.01 }, sleep: delay });

    const result = await workerWith(provider, { cancelCheckIntervalMs: 10 }).runOnce();
    await delay(20); // let the provider's abort request settle

    assert.equal(result.outcome, 'cancelled');
    const stored = await LeadFinderJob.findById(job.id);
    assert.equal(stored.status, 'cancelled');
    assert.deepEqual(mock.calls.abort, ['run-test-1']);
    assert.equal(mock.calls.listItems.length, 0);
    assert.equal(await Prospect.countDocuments(), 0);
  });

  it('never writes results that arrive after the job was cancelled', async () => {
    const job = await createApifyJob();
    const mock = mockApify({ items: [placeItem(1), placeItem(2)], onListItems: () => cancelJob(job.id) });

    const result = await workerWith(testApifyProvider({ mock })).runOnce();

    assert.equal(result.outcome, 'cancelled');
    assert.equal((await LeadFinderJob.findById(job.id)).status, 'cancelled');
    assert.equal(await Prospect.countDocuments(), 0);
  });

  it('fails a job that exceeds the provider time budget and aborts the run', async () => {
    const job = await createApifyJob();
    const mock = mockApify({ statuses: ['RUNNING'] });
    const provider = testApifyProvider({ mock, config: { pollIntervalSeconds: 0.01 }, sleep: delay });

    const result = await workerWith(provider, { providerTimeoutMs: 60 }).runOnce();
    await delay(20);

    assert.equal(result.outcome, 'failed');
    const stored = await LeadFinderJob.findById(job.id);
    assert.equal(stored.status, 'failed');
    assert.equal(stored.error, SAFE_PROVIDER_MESSAGES.PROVIDER_TIMEOUT);
    assert.deepEqual(mock.calls.abort, ['run-test-1']);
  });
});

describe('Job creation with the Apify provider', () => {
  it('rejects a search when Apify is not configured, without queuing it', async () => {
    const provider = testApifyProvider({ mock: mockApify(), config: { token: '' } });
    await assert.rejects(createApifyJob(PARAMS, provider), (err) => {
      assert.equal(err.statusCode, 503);
      assert.equal(err.details.code, 'REAL_APIFY_NOT_CONFIGURED');
      return true;
    });
    assert.equal(await LeadFinderJob.countDocuments(), 0);
  });

  it('rejects a search above the provider item limit, without queuing it', async () => {
    const mock = mockApify();
    const provider = testApifyProvider({ mock, config: { maxItems: 20 } });
    await assert.rejects(
      createApifyJob({ ...PARAMS, maxBusinesses: 50 }, provider),
      (err) => err.statusCode === 400 && /20 businesses/.test(err.message),
    );
    assert.equal(await LeadFinderJob.countDocuments(), 0);
    assert.equal(mock.calls.start.length, 0);
  });
});

describe('provider errors in API responses', () => {
  it('returns the safe message of a deliberate 503 without a stack trace', () => {
    let sent;
    const res = { status: (code) => ({ json: (body) => (sent = { code, body }) }) };
    errorHandler(new ApiError(503, SAFE_PROVIDER_MESSAGES.CONFIGURATION_ERROR), {}, res, () => {});
    assert.equal(sent.code, 503);
    assert.deepEqual(sent.body, { success: false, message: SAFE_PROVIDER_MESSAGES.CONFIGURATION_ERROR });
  });
});

describe('GET /api/admin/lead-finder/provider-status', () => {
  const URL = '/api/admin/lead-finder/provider-status';

  it('requires an admin session', async () => {
    assert.equal((await request(app).get(URL)).status, 401);
  });

  it('reports test as the default and real Apify as disabled, without secrets', async () => {
    const { agent } = await loginAgent(app);
    const res = await agent.get(URL);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data, {
      defaultProvider: 'test',
      providers: {
        test: { available: true },
        apify: { available: false, unavailableReason: 'REAL_APIFY_DISABLED', maxRunCostUsd: null },
      },
      dailyBudgetConfigured: true,
      monthlyBudgetConfigured: false,
    });
    assert.doesNotMatch(JSON.stringify(res.body), /token|actorId/i);
  });
});
