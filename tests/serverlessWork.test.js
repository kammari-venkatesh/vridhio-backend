import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LeadFinderJob } from '../src/models/leadFinderJob.model.js';
import { Prospect } from '../src/models/prospect.model.js';
import { createJob } from '../src/services/leadFinder/leadFinderJob.service.js';
import { drainQueues } from '../src/services/serverlessWork.js';
import { clearDb, createTestAdmin, startTestDb, stopTestDb } from './helpers/testDb.js';

const PARAMS = { location: 'Hyderabad', radius: 10, categories: ['Gyms'], maxBusinesses: 5 };

let admin;

before(startTestDb);
after(stopTestDb);
beforeEach(async () => {
  await clearDb();
  admin = await createTestAdmin();
});

describe('serverless queue drain', () => {
  it('runs every queued search to completion without a polling worker', async () => {
    const first = await createJob(PARAMS, admin._id);
    const second = await createJob({ ...PARAMS, location: 'Pune' }, admin._id);

    await drainQueues({ logger: { error() {} } });

    for (const job of [first, second]) {
      const stored = await LeadFinderJob.findById(job._id ?? job.id).lean();
      assert.equal(stored.status, 'completed');
    }
    assert.ok((await Prospect.countDocuments()) > 0);
  });

  it('returns promptly when nothing is queued', async () => {
    const started = Date.now();
    await drainQueues();
    assert.ok(Date.now() - started < 5000);
  });
});
