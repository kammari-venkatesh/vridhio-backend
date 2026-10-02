import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import app from '../src/app.js';
import { Prospect } from '../src/models/prospect.model.js';
import { SalesLead } from '../src/models/salesLead.model.js';
import { createLeadFinderWorker } from '../src/services/leadFinder/worker.js';
import { clearDb, createTestAdmin, loginAgent, startTestDb, stopTestDb } from './helpers/testDb.js';

const JOBS = '/api/admin/lead-finder/jobs';
const promotePath = (id) => `/api/admin/lead-finder/prospects/${id}/promote`;

before(startTestDb);
after(stopTestDb);
beforeEach(async () => {
  await clearDb();
  await createTestAdmin();
});

/**
 * Runs a real fake-provider discovery job and returns its prospects. Automatic adding to
 * the workspace is off here so these tests cover manual promotion ("Add to Leads").
 */
const discover = async (agent) => {
  const { jobId } = (await agent.post(JOBS).send({ location: 'Hyderabad, Telangana', radius: 10, categories: ['Gyms'], maxBusinesses: 10 })).body.data;
  await createLeadFinderWorker({ logger: { error() {} }, addProspectsToLeads: false }).runOnce();
  const res = await agent.get(`${JOBS}/${jobId}/prospects?limit=100`);
  return { jobId, prospects: res.body.data.items };
};

describe('promoting a prospect to a sales lead', () => {
  it('creates a NEW AI_DISCOVERY lead linked to the prospect, copying its details', async () => {
    const { agent } = await loginAgent(app);
    const { jobId, prospects } = await discover(agent);
    const prospect = prospects.find((p) => p.website && p.phone);
    const before = await Prospect.findById(prospect.id).lean();

    const res = await agent.post(promotePath(prospect.id));
    assert.equal(res.status, 201);
    const { lead, created } = res.body.data;
    assert.equal(created, true);
    assert.equal(lead.prospectId, prospect.id);
    assert.equal(lead.source, 'AI_DISCOVERY');
    assert.equal(lead.status, 'NEW');
    assert.equal(lead.businessName, prospect.businessName);
    assert.equal(lead.category, prospect.category);
    assert.equal(lead.phone, prospect.phone);
    assert.equal(lead.website, prospect.website);
    assert.equal(lead.address, prospect.address);
    assert.equal(lead.googleMapsUrl, prospect.googleMapsUrl);
    assert.equal(lead.city, 'Hyderabad');
    assert.equal(lead.sourceId, before.sourceId);

    const stored = await SalesLead.findById(lead.id).lean();
    assert.equal(stored.sourceProvider, before.source, 'provider is preserved internally');

    assert.deepEqual(await Prospect.findById(prospect.id).lean(), before, 'prospect data is untouched');

    const detail = await agent.get(`/api/admin/leads/${lead.id}`);
    assert.deepEqual(detail.body.data.prospect, { id: prospect.id, jobId });
  });

  it("prefers the prospect's own city, state and country over the search location", async () => {
    const { agent } = await loginAgent(app);
    const { prospects } = await discover(agent);
    await Prospect.updateOne(
      { _id: prospects[0].id },
      { $set: { city: 'Secunderabad', state: 'Telangana', country: 'IN' } },
    );

    const { lead } = (await agent.post(promotePath(prospects[0].id))).body.data;
    assert.equal(lead.city, 'Secunderabad');
    assert.equal(lead.state, 'Telangana');
    assert.equal(lead.country, 'IN');
  });

  it('returns the existing lead on repeat promotion instead of creating another', async () => {
    const { agent } = await loginAgent(app);
    const { prospects } = await discover(agent);
    const first = (await agent.post(promotePath(prospects[0].id))).body.data.lead;

    const again = await agent.post(promotePath(prospects[0].id));
    assert.equal(again.status, 200);
    assert.equal(again.body.data.created, false);
    assert.equal(again.body.data.matchedOn, 'prospect');
    assert.equal(again.body.data.lead.id, first.id);
    assert.equal(await SalesLead.countDocuments(), 1);
  });

  it('handles concurrent promotions of the same prospect', async () => {
    const { agent } = await loginAgent(app);
    const { prospects } = await discover(agent);
    const results = await Promise.all(Array.from({ length: 4 }, () => agent.post(promotePath(prospects[1].id))));
    assert.ok(results.every((r) => r.status === 200 || r.status === 201));
    assert.equal(new Set(results.map((r) => r.body.data.lead.id)).size, 1);
    assert.equal(await SalesLead.countDocuments(), 1);
  });

  it('links an existing manual lead with the same website instead of duplicating it', async () => {
    const { agent } = await loginAgent(app);
    const { prospects } = await discover(agent);
    const prospect = prospects.find((p) => p.website);
    const manual = (await agent.post('/api/admin/leads').send({ businessName: 'Known Already', website: prospect.website })).body.data;

    const res = await agent.post(promotePath(prospect.id));
    assert.equal(res.status, 200);
    assert.equal(res.body.data.lead.id, manual.id);
    assert.equal(res.body.data.matchedOn, 'website');
    assert.equal((await SalesLead.findById(manual.id)).prospectId.toString(), prospect.id);
    assert.equal(await SalesLead.countDocuments(), 1);
  });

  it('marks promoted prospects in the job prospect list', async () => {
    const { agent } = await loginAgent(app);
    const { jobId, prospects } = await discover(agent);
    assert.ok(prospects.every((p) => p.salesLeadId === null));
    const { lead } = (await agent.post(promotePath(prospects[0].id))).body.data;

    const items = (await agent.get(`${JOBS}/${jobId}/prospects?limit=100`)).body.data.items;
    assert.equal(items.find((p) => p.id === prospects[0].id).salesLeadId, lead.id);
    assert.equal(items.filter((p) => p.salesLeadId).length, 1, 'with automatic adding off, other prospects are not converted');
  });

  it('returns 404 for unknown prospects', async () => {
    const { agent } = await loginAgent(app);
    assert.equal((await agent.post(promotePath(new mongoose.Types.ObjectId().toString()))).status, 404);
    assert.equal((await agent.post(promotePath('not-an-id'))).status, 404);
  });
});
