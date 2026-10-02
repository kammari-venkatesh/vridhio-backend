import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import app from '../src/app.js';
import { AdminUser } from '../src/models/adminUser.model.js';
import { Prospect } from '../src/models/prospect.model.js';
import { SalesLead } from '../src/models/salesLead.model.js';
import { createLeadFinderWorker } from '../src/services/leadFinder/worker.js';
import { addProspectsToWorkspace } from '../src/services/leadWorkspace/salesLead.service.js';
import { clearDb, createTestAdmin, loginAgent, startTestDb, stopTestDb, TEST_ADMIN } from './helpers/testDb.js';

const BATCH = '/api/admin/leads/batch';
const JOBS = '/api/admin/lead-finder/jobs';
const rows = (...values) => values.map((v, i) => ({ clientId: `row-${i}`, values: v }));

before(startTestDb);
after(stopTestDb);
beforeEach(async () => {
  await clearDb();
  await createTestAdmin();
});

describe('POST /api/admin/leads/batch (rows pasted into the table)', () => {
  it('requires an admin session', async () => {
    assert.equal((await request(app).post(BATCH).send({ rows: rows({ businessName: 'X' }) })).status, 401);
    const { agent } = await loginAgent(app);
    await AdminUser.collection.updateOne({ email: TEST_ADMIN.email }, { $set: { role: 'viewer' } });
    assert.equal((await agent.post(BATCH).send({ rows: rows({ businessName: 'X' }) })).status, 403);
    assert.equal(await SalesLead.countDocuments(), 0);
  });

  it('creates valid rows and reports invalid ones without blocking the rest', async () => {
    const { agent } = await loginAgent(app);
    const res = await agent.post(BATCH).send({
      rows: rows(
        { businessName: 'Iron Gym', city: 'Hyderabad', phone: '+91 90000 11111', potentialServices: 'SEO, Google Ads', tags: 'Hot', status: 'interested' },
        { businessName: '', city: 'Pune' },
        { businessName: 'Bad Email Cafe', email: 'not-an-email' },
        { businessName: 'Sneaky', source: 'AI_DISCOVERY' },
        { businessName: 'Zen Spa', website: 'zenspa.example' },
      ),
    });
    assert.equal(res.status, 200);
    const { results, created, invalid, duplicates } = res.body.data;
    assert.deepEqual([created, invalid, duplicates], [2, 3, 0]);
    assert.deepEqual(results.map((r) => [r.clientId, r.status]), [
      ['row-0', 'created'],
      ['row-1', 'invalid'],
      ['row-2', 'invalid'],
      ['row-3', 'invalid'],
      ['row-4', 'created'],
    ]);
    assert.equal(results[1].errors.businessName, 'Business name is required.');
    assert.match(results[2].errors.email, /valid email/);
    assert.equal(results[3].errors.source, 'This field cannot be set.', 'server-side validation is unchanged');

    const gym = results[0].lead;
    assert.deepEqual(gym.potentialServices, ['SEO', 'Google Ads']);
    assert.deepEqual(gym.tags, ['hot']);
    assert.equal(gym.status, 'INTERESTED');
    assert.equal(gym.source, 'MANUAL');
    assert.equal(gym.sourceDetail, 'Pasted into the lead table');
    assert.equal(results[4].lead.website, 'https://zenspa.example/');
    assert.equal(await SalesLead.countDocuments(), 2);
  });

  it('creates nothing new when the same rows are pasted again', async () => {
    const { agent } = await loginAgent(app);
    const pasted = rows(
      { businessName: 'Iron Gym', city: 'Hyderabad' },
      { businessName: 'Zen Spa', phone: '9000022222' },
      { businessName: 'Just A Name' },
    );
    assert.equal((await agent.post(BATCH).send({ rows: pasted })).body.data.created, 3);

    const again = (await agent.post(BATCH).send({ rows: pasted })).body.data;
    assert.equal(again.created, 0);
    assert.equal(again.duplicates, 3);
    assert.deepEqual(again.results.map((r) => r.matchedOn), ['businessName+city', 'phone', 'businessName']);
    assert.ok(again.results.every((r) => r.existingLead?.id && r.message));
    assert.equal(await SalesLead.countDocuments(), 3);
  });

  it('skips repeats within one paste', async () => {
    const { agent } = await loginAgent(app);
    const { results } = (
      await agent.post(BATCH).send({
        rows: rows(
          { businessName: 'Iron Gym', website: 'https://irongym.example' },
          { businessName: 'Iron Gym Branch', website: 'irongym.example/' },
          { businessName: 'only name' },
          { businessName: 'Only Name' },
        ),
      })
    ).body.data;
    assert.deepEqual(results.map((r) => r.status), ['created', 'duplicate', 'created', 'duplicate']);
    assert.equal(results[1].duplicateOfClientId, 'row-0');
    assert.equal(results[3].duplicateOfClientId, 'row-2');
    assert.equal(await SalesLead.countDocuments(), 2);
  });

  it('treats a same-named business in a different city as a different lead', async () => {
    const { agent } = await loginAgent(app);
    await agent.post(BATCH).send({ rows: rows({ businessName: 'Gold Gym', city: 'Pune' }) });
    const { created } = (await agent.post(BATCH).send({ rows: rows({ businessName: 'Gold Gym', city: 'Hyderabad' }) })).body.data;
    assert.equal(created, 1);
  });

  it('rejects malformed requests', async () => {
    const { agent } = await loginAgent(app);
    for (const body of [
      {},
      { rows: [] },
      { rows: [{ values: { businessName: 'X' } }] },
      { rows: [{ clientId: 'a', values: 'X' }] },
      { rows: [{ clientId: 'a', values: { businessName: 'X' } }, { clientId: 'a', values: { businessName: 'Y' } }] },
      { rows: Array.from({ length: 501 }, (_, i) => ({ clientId: `r${i}`, values: { businessName: `B${i}` } })) },
    ]) {
      const res = await agent.post(BATCH).send(body);
      assert.equal(res.status, 400, JSON.stringify(body).slice(0, 80));
    }
    assert.equal(await SalesLead.countDocuments(), 0);
  });

  it('accepts a large paste beyond the default 100kb body limit', async () => {
    const { agent } = await loginAgent(app);
    const big = Array.from({ length: 300 }, (_, i) => ({
      clientId: `r${i}`,
      values: { businessName: `Business ${i}`, city: 'Hyderabad', notes: 'n'.repeat(400) },
    }));
    const res = await agent.post(BATCH).send({ rows: big });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.created, 300);
  });
});

describe('duplicate checks for single rows', () => {
  it('rejects a second lead with the same name when neither has a city, phone or website', async () => {
    const { agent } = await loginAgent(app);
    assert.equal((await agent.post('/api/admin/leads').send({ businessName: 'Corner Bakery' })).status, 201);
    const again = await agent.post('/api/admin/leads').send({ businessName: 'corner bakery' });
    assert.equal(again.status, 409);
    assert.equal(again.body.details.matchedOn, 'businessName');
    assert.equal((await agent.post('/api/admin/leads').send({ businessName: 'Corner Bakery', city: 'Pune' })).status, 201);
  });
});

describe('discovered businesses appear in the Lead Workspace', () => {
  const search = (agent) =>
    agent.post(JOBS).send({ location: 'Hyderabad, Telangana', radius: 10, categories: ['Gyms'], maxBusinesses: 10 });

  it('adds every discovered business as an AI Discovery lead, once', async () => {
    const { agent } = await loginAgent(app);
    await search(agent);
    await createLeadFinderWorker({ logger: { error() {} } }).runOnce();

    const prospects = await Prospect.countDocuments();
    assert.ok(prospects > 0);
    const leads = await SalesLead.find().lean();
    assert.equal(leads.length, prospects);
    assert.ok(leads.every((l) => l.source === 'AI_DISCOVERY' && l.prospectId && l.status === 'NEW'));
    assert.ok(leads.every((l) => l.tags.includes('test-data') && l.sourceDetail === 'Lead Finder test data'));

    const listed = await agent.get('/api/admin/leads?source=AI_DISCOVERY&limit=100');
    assert.equal(listed.body.pagination.total, prospects, 'shown in the same table as every other lead');

    await search(agent);
    await createLeadFinderWorker({ logger: { error() {} } }).runOnce();
    assert.equal(await SalesLead.countDocuments(), prospects, 're-discovered businesses are not duplicated');
  });

  it('links a discovered business to a lead that was already entered by hand', async () => {
    const { agent } = await loginAgent(app);
    await search(agent);
    await createLeadFinderWorker({ logger: { error() {} }, addProspectsToLeads: false }).runOnce();
    const prospect = await Prospect.findOne({ website: { $ne: null } });
    const manual = (await agent.post('/api/admin/leads').send({ businessName: 'Typed By Hand', website: prospect.website })).body.data;

    const result = await addProspectsToWorkspace(await Prospect.find(), null);
    assert.equal(result.linked, 1);
    assert.equal((await SalesLead.findById(manual.id)).prospectId.toString(), prospect._id.toString());
    assert.equal(await SalesLead.countDocuments(), await Prospect.countDocuments());
  });

  it('can be turned off', async () => {
    const { agent } = await loginAgent(app);
    await search(agent);
    await createLeadFinderWorker({ logger: { error() {} }, addProspectsToLeads: false }).runOnce();
    assert.ok((await Prospect.countDocuments()) > 0);
    assert.equal(await SalesLead.countDocuments(), 0);
  });
});
