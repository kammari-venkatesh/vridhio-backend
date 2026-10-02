import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import request from 'supertest';
import app from '../src/app.js';
import { AdminUser } from '../src/models/adminUser.model.js';
import { LeadFinderJob } from '../src/models/leadFinderJob.model.js';
import { createLeadFinderWorker } from '../src/services/leadFinder/worker.js';
import { clearDb, createTestAdmin, loginAgent, startTestDb, stopTestDb, TEST_ADMIN } from './helpers/testDb.js';

const JOBS = '/api/admin/lead-finder/jobs';
const VALID_JOB = { location: 'Hyderabad', radius: 10, categories: ['Gyms', 'Salons'], maxBusinesses: 50 };
const missingId = () => new mongoose.Types.ObjectId().toString();
const quietWorker = () => createLeadFinderWorker({ logger: { error() {} } });

before(startTestDb);
after(stopTestDb);
beforeEach(async () => {
  await clearDb();
  await createTestAdmin();
});

describe('Lead Finder API access control', () => {
  it('rejects unauthenticated requests to every endpoint', async () => {
    const id = missingId();
    const responses = await Promise.all([
      request(app).post(JOBS).send(VALID_JOB),
      request(app).get(JOBS),
      request(app).get(`${JOBS}/${id}`),
      request(app).get(`${JOBS}/${id}/prospects`),
      request(app).post(`${JOBS}/${id}/cancel`),
    ]);
    for (const res of responses) assert.equal(res.status, 401);
    assert.equal(await LeadFinderJob.countDocuments(), 0);
  });

  it('rejects non-admin accounts', async () => {
    const { agent } = await loginAgent(app);
    await AdminUser.collection.updateOne({ email: TEST_ADMIN.email }, { $set: { role: 'viewer' } });

    for (const res of [await agent.post(JOBS).send(VALID_JOB), await agent.get(JOBS)]) {
      assert.equal(res.status, 403);
    }
    assert.equal(await LeadFinderJob.countDocuments(), 0);
  });
});

describe('POST /api/admin/lead-finder/jobs', () => {
  const expectInvalid = async (body, field) => {
    const { agent } = await loginAgent(app);
    const res = await agent.post(JOBS).send(body);
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
    assert.ok(res.body.details[field], `expected an error for ${field}`);
  };

  it('rejects an invalid location', async () => {
    await expectInvalid({ ...VALID_JOB, location: undefined }, 'location');
    await expectInvalid({ ...VALID_JOB, location: ' a ' }, 'location');
    await expectInvalid({ ...VALID_JOB, location: '<script>alert(1)</script>' }, 'location');
    await expectInvalid({ ...VALID_JOB, location: 'x'.repeat(101) }, 'location');
  });

  it('rejects an invalid radius', async () => {
    for (const radius of [0, -5, 51, '10', null, Number.NaN]) {
      await expectInvalid({ ...VALID_JOB, radius }, 'radius');
    }
  });

  it('rejects empty or invalid categories', async () => {
    await expectInvalid({ ...VALID_JOB, categories: [] }, 'categories');
    await expectInvalid({ ...VALID_JOB, categories: undefined }, 'categories');
    await expectInvalid({ ...VALID_JOB, categories: 'Gyms' }, 'categories');
    await expectInvalid({ ...VALID_JOB, categories: [''] }, 'categories');
    await expectInvalid({ ...VALID_JOB, categories: Array.from({ length: 11 }, (_, i) => `Category ${i}`) }, 'categories');
  });

  it('rejects an excessive or invalid maxBusinesses', async () => {
    for (const maxBusinesses of [101, 10_000, 0, 2.5, '50']) {
      await expectInvalid({ ...VALID_JOB, maxBusinesses }, 'maxBusinesses');
    }
  });

  it('creates a queued job and returns immediately', async () => {
    const { agent } = await loginAgent(app);
    const started = Date.now();
    const res = await agent.post(JOBS).send({ ...VALID_JOB, categories: ['Gyms', ' gyms ', 'Salons'] });

    assert.equal(res.status, 202);
    assert.equal(res.body.data.status, 'queued');
    assert.ok(mongoose.isValidObjectId(res.body.data.jobId));
    assert.ok(Date.now() - started < 2000);

    const stored = await LeadFinderJob.findById(res.body.data.jobId);
    assert.equal(stored.provider, 'fake');
    assert.deepEqual([...stored.params.categories], ['Gyms', 'Salons']);
    assert.equal(stored.createdBy.toString(), (await AdminUser.findOne()).id);

    const { job } = res.body.data;
    assert.equal(job.provider, 'test');
    assert.equal(job.providerMode, 'test');
    for (const internal of ['lockedBy', 'heartbeatAt', 'createdBy', 'providerRun', 'costCapMicroUsd']) {
      assert.equal(job[internal], undefined, `${internal} must not be exposed`);
    }
  });

  it('applies the default maxBusinesses and rejects unknown fields', async () => {
    const { agent } = await loginAgent(app);
    const res = await agent.post(JOBS).send({ ...VALID_JOB, maxBusinesses: undefined });
    assert.equal(res.status, 202);
    const stored = await LeadFinderJob.findById(res.body.data.jobId);
    assert.equal(stored.params.maxBusinesses, 25);
    assert.equal(stored.status, 'queued');
    assert.equal(stored.provider, 'fake');

    const extra = await agent.post(JOBS).send({ ...VALID_JOB, status: 'completed' });
    assert.equal(extra.status, 400);
    assert.equal(extra.body.details.status, 'This field is not allowed.');
    assert.equal(await LeadFinderJob.countDocuments(), 1);
  });

  it('limits the number of simultaneously active jobs', async () => {
    const { agent } = await loginAgent(app);
    for (let i = 0; i < 3; i += 1) assert.equal((await agent.post(JOBS).send(VALID_JOB)).status, 202);

    const blocked = await agent.post(JOBS).send(VALID_JOB);
    assert.equal(blocked.status, 429);
    assert.match(blocked.body.message, /Up to 3 searches/);
    assert.equal(await LeadFinderJob.countDocuments(), 3);
  });
});

describe('job status, listing and prospects', () => {
  it('returns job status with params and progress', async () => {
    const { agent } = await loginAgent(app);
    const { jobId } = (await agent.post(JOBS).send(VALID_JOB)).body.data;

    const res = await agent.get(`${JOBS}/${jobId}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.id, jobId);
    assert.deepEqual(res.body.data.params, VALID_JOB);
    assert.deepEqual(res.body.data.progress, {
      total: 0,
      invalid: 0,
      closed: 0,
      outsideRadius: 0,
      missingCoordinates: 0,
      discovered: 0,
      processed: 0,
      newProspects: 0,
      qualified: 0,
    });
    assert.equal(res.body.data.providerMode, 'test');
    assert.deepEqual(res.body.data.cost, { status: 'test', totalUsd: null, perNewProspectUsd: null });
    assert.equal(res.body.data.error, null);
  });

  it('returns 404 for unknown or malformed job IDs', async () => {
    const { agent } = await loginAgent(app);
    for (const path of [`${JOBS}/${missingId()}`, `${JOBS}/not-an-id`, `${JOBS}/${missingId()}/prospects`]) {
      const res = await agent.get(path);
      assert.equal(res.status, 404);
      assert.equal(res.body.message, 'Lead Finder job not found');
    }
  });

  it('lists jobs newest first with pagination', async () => {
    const { agent } = await loginAgent(app);
    const ids = [];
    for (const location of ['Pune', 'Chennai', 'Kochi']) {
      ids.push((await agent.post(JOBS).send({ ...VALID_JOB, location })).body.data.jobId);
    }

    const page1 = await agent.get(`${JOBS}?page=1&limit=2`);
    assert.equal(page1.status, 200);
    assert.deepEqual(page1.body.data.items.map((j) => j.id), [ids[2], ids[1]]);
    assert.equal(page1.body.data.total, 3);
    assert.equal(page1.body.data.totalPages, 2);

    const page2 = await agent.get(`${JOBS}?page=2&limit=2`);
    assert.deepEqual(page2.body.data.items.map((j) => j.id), [ids[0]]);
  });

  it('rejects invalid pagination', async () => {
    const { agent } = await loginAgent(app);
    for (const query of ['limit=1000', 'limit=0', 'page=0', 'page=abc']) {
      assert.equal((await agent.get(`${JOBS}?${query}`)).status, 400, query);
    }
  });

  it('lists prospects for a processed job with pagination', async () => {
    const { agent } = await loginAgent(app);
    const { jobId } = (await agent.post(JOBS).send(VALID_JOB)).body.data;
    await quietWorker().runOnce();

    const job = (await agent.get(`${JOBS}/${jobId}`)).body.data;
    assert.equal(job.status, 'completed');

    const res = await agent.get(`${JOBS}/${jobId}/prospects?limit=4`);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.items.length, 4);
    assert.equal(res.body.data.total, job.progress.discovered);

    const names = res.body.data.items.map((p) => p.businessName);
    assert.deepEqual(names, [...names].sort());
    const [first] = res.body.data.items;
    for (const field of ['businessName', 'category', 'address', 'phone', 'website', 'status']) {
      assert.ok(field in first, `prospect should include ${field}`);
    }
    assert.equal(first.jobIds, undefined);
  });
});

describe('POST /api/admin/lead-finder/jobs/:jobId/cancel', () => {
  it('cancels a queued job', async () => {
    const { agent } = await loginAgent(app);
    const { jobId } = (await agent.post(JOBS).send(VALID_JOB)).body.data;

    const res = await agent.post(`${JOBS}/${jobId}/cancel`);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.status, 'cancelled');
    assert.ok(res.body.data.finishedAt);
    assert.equal(await quietWorker().runOnce(), null, 'a cancelled job must not be picked up');
  });

  it('refuses to cancel a completed job', async () => {
    const { agent } = await loginAgent(app);
    const { jobId } = (await agent.post(JOBS).send(VALID_JOB)).body.data;
    await quietWorker().runOnce();

    const res = await agent.post(`${JOBS}/${jobId}/cancel`);
    assert.equal(res.status, 409);
    assert.equal((await LeadFinderJob.findById(jobId)).status, 'completed');
  });

  it('returns 404 for an unknown job', async () => {
    const { agent } = await loginAgent(app);
    assert.equal((await agent.post(`${JOBS}/${missingId()}/cancel`)).status, 404);
  });
});
