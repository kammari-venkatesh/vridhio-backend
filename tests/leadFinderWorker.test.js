import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LeadFinderJob } from '../src/models/leadFinderJob.model.js';
import { Prospect } from '../src/models/prospect.model.js';
import { createFakeProvider } from '../src/services/leadFinder/fakeProvider.js';
import { cancelJob, createJob } from '../src/services/leadFinder/leadFinderJob.service.js';
import { listProspectsForJob } from '../src/services/leadFinder/prospect.service.js';
import { ProviderError } from '../src/services/leadFinder/provider.interface.js';
import { createLeadFinderWorker } from '../src/services/leadFinder/worker.js';
import { clearDb, createTestAdmin, startTestDb, stopTestDb } from './helpers/testDb.js';

const PARAMS = { location: 'Hyderabad', radius: 10, categories: ['Gyms', 'Yoga Studios'], maxBusinesses: 50 };
const silent = { error() {} };

let admin;
const queueJob = (params = PARAMS) => createJob(params, admin._id);

/** Wraps a provider so tests can see how it was called and what state the job was in. */
const spyProvider = (inner = createFakeProvider(), onCall = async () => {}) => {
  const calls = [];
  return {
    calls,
    provider: {
      name: inner.name,
      async discoverBusinesses(params) {
        calls.push(params);
        await onCall(params);
        return inner.discoverBusinesses(params);
      },
    },
  };
};

const workerWith = (provider, options = {}) =>
  createLeadFinderWorker({ resolveProvider: () => provider, logger: silent, ...options });

before(startTestDb);
after(stopTestDb);
beforeEach(async () => {
  await clearDb();
  admin = await createTestAdmin();
});

describe('Lead Finder worker', () => {
  it('claims a queued job, marks it running and calls the provider with the job params', async () => {
    const job = await queueJob();
    let statusDuringCall;
    const spy = spyProvider(createFakeProvider(), async () => {
      statusDuringCall = (await LeadFinderJob.findById(job.id)).status;
    });

    const result = await workerWith(spy.provider).runOnce();

    assert.deepEqual(result, { jobId: job.id, outcome: 'completed' });
    assert.equal(statusDuringCall, 'running');
    assert.equal(spy.calls.length, 1);
    assert.deepEqual(spy.calls[0], PARAMS);
  });

  it('creates de-duplicated prospects, tracks progress and completes the job', async () => {
    const job = await queueJob();
    const raw = await createFakeProvider().discoverBusinesses(PARAMS);
    const uniqueIds = new Set(raw.map((r) => r.sourceId));
    assert.ok(uniqueIds.size < raw.length, 'fixture must contain duplicates');

    await workerWith(createFakeProvider()).runOnce();

    const done = await LeadFinderJob.findById(job.id);
    assert.equal(done.status, 'completed');
    assert.ok(done.startedAt && done.finishedAt);
    assert.equal(done.error, null);
    assert.equal(done.progress.total, raw.length);
    assert.equal(done.progress.discovered, uniqueIds.size);
    assert.equal(done.progress.processed, uniqueIds.size);
    assert.equal(done.progress.newProspects, uniqueIds.size);
    assert.equal(done.progress.qualified, 0);

    const prospects = await Prospect.find({ jobIds: done._id });
    assert.equal(prospects.length, uniqueIds.size);
    assert.ok(prospects.every((p) => p.source === 'fake' && p.status === 'new'));
  });

  it('updates progress after every batch', async () => {
    await queueJob();
    const snapshots = [];
    const worker = workerWith(createFakeProvider(), {
      batchSize: 2,
      onProgress: (progress) => snapshots.push(progress),
    });
    await worker.runOnce();

    const processedSteps = snapshots.filter((s) => 'processed' in s).map((s) => s.processed);
    assert.ok(processedSteps.length > 1);
    assert.deepEqual(processedSteps, [...processedSteps].sort((a, b) => a - b));
    assert.equal(processedSteps[0], 2);
  });

  it('never duplicates a business found by a later job', async () => {
    const first = await queueJob();
    await workerWith(createFakeProvider()).runOnce();
    const countAfterFirst = await Prospect.countDocuments();

    const second = await queueJob();
    await workerWith(createFakeProvider()).runOnce();

    assert.equal(await Prospect.countDocuments(), countAfterFirst);
    const secondJob = await LeadFinderJob.findById(second.id);
    assert.equal(secondJob.progress.newProspects, 0);
    assert.equal(secondJob.progress.processed, countAfterFirst);

    const listed = await listProspectsForJob(second.id, { page: 1, limit: 100 });
    assert.equal(listed.total, countAfterFirst, 'known businesses are still listed for the new job');
    const sample = await Prospect.findOne();
    assert.deepEqual(sample.jobIds.map(String).sort(), [first.id, second.id].sort());
    assert.equal(sample.jobId.toString(), first.id);
  });

  it('marks the job failed with the provider message on a provider error', async () => {
    const job = await queueJob();
    const provider = { name: 'fake', discoverBusinesses: async () => { throw new ProviderError('Provider quota exceeded.'); } };

    const result = await workerWith(provider).runOnce();

    assert.equal(result.outcome, 'failed');
    const failed = await LeadFinderJob.findById(job.id);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error, 'Provider quota exceeded.');
    assert.ok(failed.finishedAt);
  });

  it('hides internal error details from the stored job error', async () => {
    const job = await queueJob();
    const provider = { name: 'fake', discoverBusinesses: async () => { throw new Error('token=SECRET123 at internal.js:42'); } };

    await workerWith(provider).runOnce();

    const failed = await LeadFinderJob.findById(job.id);
    assert.equal(failed.status, 'failed');
    assert.doesNotMatch(failed.error, /SECRET123|internal\.js/);
  });

  it('fails jobs whose provider returns an invalid response or is unknown', async () => {
    const badResponse = await queueJob();
    await workerWith({ name: 'fake', discoverBusinesses: async () => ({ not: 'an array' }) }).runOnce();
    assert.equal((await LeadFinderJob.findById(badResponse.id)).status, 'failed');

    const unknown = await queueJob();
    await LeadFinderJob.updateOne({ _id: unknown.id }, { $set: { provider: 'does-not-exist' } });
    assert.equal(await createLeadFinderWorker({ logger: silent }).runOnce(), null, 'a provider it cannot run is never claimed');
    assert.equal((await LeadFinderJob.findById(unknown.id)).status, 'queued');
  });

  it('does not let two workers claim the same job', async () => {
    await queueJob();
    const [a, b] = await Promise.all([
      workerWith(createFakeProvider(), { workerId: 'worker-a' }).claimNextJob(),
      workerWith(createFakeProvider(), { workerId: 'worker-b' }).claimNextJob(),
    ]);
    assert.equal([a, b].filter(Boolean).length, 1);
  });

  it('lets concurrent workers process different jobs', async () => {
    const jobs = [await queueJob(), await queueJob({ ...PARAMS, location: 'Pune' })];
    const results = await Promise.all([
      workerWith(createFakeProvider(), { workerId: 'worker-a' }).runOnce(),
      workerWith(createFakeProvider(), { workerId: 'worker-b' }).runOnce(),
    ]);

    assert.deepEqual(results.map((r) => r.jobId).sort(), jobs.map((j) => j.id).sort());
    const statuses = await LeadFinderJob.find().distinct('status');
    assert.deepEqual(statuses, ['completed']);
  });

  it('returns null when there is nothing to do', async () => {
    assert.equal(await workerWith(createFakeProvider()).runOnce(), null);
  });

  it('fails running jobs whose worker stopped sending heartbeats', async () => {
    const job = await queueJob();
    await LeadFinderJob.updateOne(
      { _id: job.id },
      { $set: { status: 'running', lockedBy: 'dead-worker', heartbeatAt: new Date(Date.now() - 60 * 60 * 1000) } },
    );

    await workerWith(createFakeProvider()).recoverStaleJobs();

    const stale = await LeadFinderJob.findById(job.id);
    assert.equal(stale.status, 'failed');
    assert.match(stale.error, /stopped unexpectedly/);
  });
});

describe('Lead Finder cancellation', () => {
  it('stops a running job cancelled during discovery without completing it', async () => {
    const job = await queueJob();
    const spy = spyProvider(createFakeProvider(), () => cancelJob(job.id));

    const result = await workerWith(spy.provider).runOnce();

    assert.equal(result.outcome, 'cancelled');
    const cancelled = await LeadFinderJob.findById(job.id);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.progress.processed, 0);
    assert.equal(await Prospect.countDocuments(), 0);
  });

  it('stops between batches when cancelled mid-run', async () => {
    const job = await queueJob();
    let cancelled = false;
    const worker = workerWith(createFakeProvider(), {
      batchSize: 2,
      onProgress: async (progress) => {
        if (!cancelled && progress.processed === 2) {
          cancelled = true;
          await cancelJob(job.id);
        }
      },
    });

    const result = await worker.runOnce();

    assert.equal(result.outcome, 'cancelled');
    const stored = await LeadFinderJob.findById(job.id);
    assert.equal(stored.status, 'cancelled');
    assert.equal(stored.progress.processed, 2);
    assert.equal(await Prospect.countDocuments(), 2);
  });

  it('refuses to cancel a completed job', async () => {
    const job = await queueJob();
    await workerWith(createFakeProvider()).runOnce();
    await assert.rejects(cancelJob(job.id), (err) => err.statusCode === 409);
  });
});
