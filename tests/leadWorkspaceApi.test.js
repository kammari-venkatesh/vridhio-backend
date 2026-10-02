import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import request from 'supertest';
import app from '../src/app.js';
import { AdminUser } from '../src/models/adminUser.model.js';
import { SalesLead } from '../src/models/salesLead.model.js';
import { clearDb, createTestAdmin, loginAgent, startTestDb, stopTestDb, TEST_ADMIN } from './helpers/testDb.js';

const LEADS = '/api/admin/leads';
let admin;

const seed = () =>
  SalesLead.insertMany(
    [
      { businessName: 'Alpha Gym', category: 'Gym', city: 'Hyderabad', status: 'NEW', source: 'AI_DISCOVERY', tags: ['hot'], potentialServices: ['SEO'], phone: '+91 90000 00001' },
      { businessName: 'beta Salon', category: 'Salon', city: 'Hyderabad', status: 'INTERESTED', source: 'CSV_IMPORT', potentialServices: ['Website Redesign'], email: 'hello@beta.example' },
      { businessName: 'Gamma Cafe', category: 'Cafe', city: 'Pune', status: 'INTERESTED', source: 'MANUAL', website: 'https://gamma.example/' },
      { businessName: 'Delta Dental', category: 'Dental', city: 'Pune', status: 'WON', source: 'MANUAL', tags: ['hot', 'vip'] },
      { businessName: 'Old Archived Shop', city: 'Hyderabad', status: 'LOST', archived: true },
    ].map((lead, i) => ({ ...lead, createdAt: new Date(Date.UTC(2026, 0, i + 1)) })),
  );

const names = (res) => res.body.data.map((l) => l.businessName);

before(startTestDb);
after(stopTestDb);
beforeEach(async () => {
  await clearDb();
  admin = await createTestAdmin();
});

describe('Lead Workspace access control', () => {
  it('rejects unauthenticated requests to every endpoint', async () => {
    const id = new mongoose.Types.ObjectId().toString();
    const calls = [
      request(app).get(LEADS),
      request(app).post(LEADS).send({ businessName: 'X' }),
      request(app).get(`${LEADS}/export`),
      request(app).patch(`${LEADS}/bulk`).send({}),
      request(app).get(`${LEADS}/${id}`),
      request(app).patch(`${LEADS}/${id}`).send({}),
      request(app).delete(`${LEADS}/${id}`),
      request(app).get('/api/admin/lead-workspace/meta'),
      request(app).post(`/api/admin/lead-finder/prospects/${id}/promote`),
    ];
    for (const res of await Promise.all(calls)) {
      assert.equal(res.status, 401);
      assert.equal(res.headers['cache-control'], 'no-store');
    }
  });

  it('rejects non-admin accounts', async () => {
    const { agent } = await loginAgent(app);
    await AdminUser.collection.updateOne({ email: TEST_ADMIN.email }, { $set: { role: 'viewer' } });
    assert.equal((await agent.get(LEADS)).status, 403);
    assert.equal((await agent.post(LEADS).send({ businessName: 'X' })).status, 403);
    assert.equal(await SalesLead.countDocuments(), 0);
  });

  it('keeps inbound contact-form leads separate', async () => {
    const res = await request(app)
      .post('/api/leads')
      .send({ name: 'Website Visitor', email: 'v@example.com', phone: '9000000000', services: ['SEO'], message: 'Hello there' });
    assert.equal(res.status, 201);
    assert.equal(await SalesLead.countDocuments(), 0);
  });
});

describe('creating and editing leads', () => {
  it('adds a manual lead', async () => {
    const { agent } = await loginAgent(app);
    const res = await agent.post(LEADS).send({
      businessName: '  New Bakery ',
      website: 'newbakery.example',
      potentialServices: ['seo', 'Website Development'],
      tags: ['Warm'],
      customFields: { Instagram: '@newbakery' },
    });

    assert.equal(res.status, 201);
    const lead = res.body.data;
    assert.equal(lead.businessName, 'New Bakery');
    assert.equal(lead.website, 'https://newbakery.example/');
    assert.equal(lead.source, 'MANUAL');
    assert.equal(lead.status, 'NEW');
    assert.deepEqual(lead.potentialServices, ['SEO', 'Website Development']);
    assert.deepEqual(lead.tags, ['warm']);
    assert.deepEqual(lead.customFields, { Instagram: '@newbakery' });
    for (const internal of ['dedupe', 'sourceProvider', 'createdBy', '__v', '_id']) assert.equal(lead[internal], undefined);
  });

  it('validates input strictly', async () => {
    const { agent } = await loginAgent(app);
    const res = await agent.post(LEADS).send({
      businessName: '',
      email: 'nope',
      status: 'MAYBE',
      potentialServices: ['Teleportation'],
      source: 'AI_DISCOVERY',
      notes: 'x'.repeat(5001),
      tags: Array.from({ length: 21 }, (_, i) => `t${i}`),
    });
    assert.equal(res.status, 400);
    for (const field of ['businessName', 'email', 'status', 'potentialServices', 'source', 'notes', 'tags']) {
      assert.ok(res.body.details[field], `expected an error for ${field}`);
    }
  });

  it('refuses an obvious duplicate and points to the existing lead', async () => {
    const { agent } = await loginAgent(app);
    const first = (await agent.post(LEADS).send({ businessName: 'ABC', phone: '98765 43210' })).body.data;
    const res = await agent.post(LEADS).send({ businessName: 'ABC Gym', phone: '+91 98765 43210' });
    assert.equal(res.status, 409);
    assert.equal(res.body.details.existingLeadId, first.id);
    assert.equal(res.body.details.matchedOn, 'phone');
  });

  it('updates fields, status, tags, services, notes, custom fields and assignment', async () => {
    const { agent } = await loginAgent(app);
    const { id, createdAt } = (await agent.post(LEADS).send({ businessName: 'Edit Me' })).body.data;
    const res = await agent.patch(`${LEADS}/${id}`).send({
      category: 'Gym',
      status: 'contacted',
      tags: ['follow up'],
      potentialServices: ['AEO'],
      notes: 'Called on Monday.',
      customFields: { Owner: 'Ravi' },
      assignedTo: admin.id,
    });

    assert.equal(res.status, 200);
    const lead = res.body.data;
    assert.equal(lead.status, 'CONTACTED');
    assert.deepEqual(lead.tags, ['follow up']);
    assert.deepEqual(lead.potentialServices, ['AEO']);
    assert.equal(lead.notes, 'Called on Monday.');
    assert.deepEqual(lead.customFields, { Owner: 'Ravi' });
    assert.deepEqual(lead.assignedTo, { id: admin.id, email: TEST_ADMIN.email });
    assert.equal(lead.createdAt, createdAt);
    assert.ok(lead.updatedAt >= createdAt);
  });

  it('rejects edits that would duplicate another lead, but allows editing the same lead', async () => {
    const { agent } = await loginAgent(app);
    await agent.post(LEADS).send({ businessName: 'Taken', website: 'taken.example' });
    const { id } = (await agent.post(LEADS).send({ businessName: 'Mine', website: 'mine.example' })).body.data;

    assert.equal((await agent.patch(`${LEADS}/${id}`).send({ website: 'https://www.taken.example' })).status, 409);
    assert.equal((await agent.patch(`${LEADS}/${id}`).send({ website: 'https://mine.example/' })).status, 200);
    assert.equal((await agent.patch(`${LEADS}/${id}`).send({ assignedTo: new mongoose.Types.ObjectId().toString() })).status, 400);
  });

  it('returns a single lead and 404 for unknown IDs', async () => {
    const { agent } = await loginAgent(app);
    const { id } = (await agent.post(LEADS).send({ businessName: 'One' })).body.data;
    const res = await agent.get(`${LEADS}/${id}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.businessName, 'One');
    assert.equal(res.body.data.prospect, null);

    for (const bad of [new mongoose.Types.ObjectId().toString(), 'not-an-id']) {
      assert.equal((await agent.get(`${LEADS}/${bad}`)).status, 404);
      assert.equal((await agent.patch(`${LEADS}/${bad}`).send({ notes: 'x' })).status, 404);
      assert.equal((await agent.delete(`${LEADS}/${bad}`)).status, 404);
    }
  });

  it('archives instead of deleting, hiding the lead by default', async () => {
    const { agent } = await loginAgent(app);
    const { id } = (await agent.post(LEADS).send({ businessName: 'Archive Me' })).body.data;

    const res = await agent.delete(`${LEADS}/${id}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.archived, true);
    assert.equal(await SalesLead.countDocuments(), 1, 'record is kept');
    assert.equal((await agent.get(LEADS)).body.pagination.total, 0);
    assert.deepEqual(names(await agent.get(`${LEADS}?archived=only`)), ['Archive Me']);
  });
});

describe('GET /api/admin/leads', () => {
  it('paginates newest first with the default page size', async () => {
    const { agent } = await loginAgent(app);
    await seed();
    const res = await agent.get(LEADS);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.pagination, { page: 1, limit: 50, total: 4, totalPages: 1 });
    assert.deepEqual(names(res), ['Delta Dental', 'Gamma Cafe', 'beta Salon', 'Alpha Gym']);

    const page2 = await agent.get(`${LEADS}?limit=3&page=2`);
    assert.deepEqual(names(page2), ['Alpha Gym']);
    assert.equal(page2.body.pagination.totalPages, 2);
  });

  it('searches server-side across fields, including phone digits', async () => {
    const { agent } = await loginAgent(app);
    await seed();
    assert.deepEqual(names(await agent.get(`${LEADS}?search=salon`)), ['beta Salon']);
    assert.deepEqual(names(await agent.get(`${LEADS}?search=beta.example`)), ['beta Salon']);
    assert.deepEqual(names(await agent.get(`${LEADS}?search=pune`)), ['Delta Dental', 'Gamma Cafe']);
    assert.deepEqual(names(await agent.get(`${LEADS}?search=9000000001`)), ['Alpha Gym']);
    assert.deepEqual(names(await agent.get(`${LEADS}?search=${encodeURIComponent('(.*)')}`)), []);
  });

  it('combines filters', async () => {
    const { agent } = await loginAgent(app);
    await seed();
    assert.deepEqual(names(await agent.get(`${LEADS}?status=INTERESTED&city=Hyderabad`)), ['beta Salon']);
    assert.deepEqual(names(await agent.get(`${LEADS}?service=website%20redesign`)), ['beta Salon']);
    assert.deepEqual(names(await agent.get(`${LEADS}?source=MANUAL&tag=hot`)), ['Delta Dental']);
    assert.deepEqual(names(await agent.get(`${LEADS}?category=Gym&source=AI_DISCOVERY`)), ['Alpha Gym']);
  });

  it('sorts by allowed fields, case-insensitively', async () => {
    const { agent } = await loginAgent(app);
    await seed();
    assert.deepEqual(names(await agent.get(`${LEADS}?sortBy=businessName&sortOrder=asc`)), ['Alpha Gym', 'beta Salon', 'Delta Dental', 'Gamma Cafe']);
    assert.deepEqual(names(await agent.get(`${LEADS}?sortBy=status&sortOrder=asc`)).slice(0, 2).sort(), ['Gamma Cafe', 'beta Salon']);
  });

  it('rejects invalid query parameters', async () => {
    const { agent } = await loginAgent(app);
    for (const query of ['sortBy=passwordHash', 'sortBy=$where', 'sortOrder=up', 'status=MAYBE', 'source=X', 'service=Nope', 'limit=101', 'page=0', 'status=NEW&status=WON', 'archived=yes']) {
      assert.equal((await agent.get(`${LEADS}?${query}`)).status, 400, query);
    }
  });
});

describe('PATCH /api/admin/leads/bulk', () => {
  const idsOf = async () => (await SalesLead.find({ archived: false }).sort({ businessName: 1 })).map((l) => l.id);

  it('changes the status of many leads in one request', async () => {
    const { agent } = await loginAgent(app);
    await seed();
    const ids = (await idsOf()).slice(0, 3);
    const res = await agent.patch(`${LEADS}/bulk`).send({ ids, operation: 'status', value: 'contacted' });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.modified, 3);
    assert.equal(await SalesLead.countDocuments({ status: 'CONTACTED' }), 3);
  });

  it('adds and removes tags and services', async () => {
    const { agent } = await loginAgent(app);
    await seed();
    const ids = await idsOf();
    await agent.patch(`${LEADS}/bulk`).send({ ids, operation: 'addTag', value: ' Q3 Campaign ' });
    assert.equal(await SalesLead.countDocuments({ tags: 'q3 campaign' }), 4);
    await agent.patch(`${LEADS}/bulk`).send({ ids, operation: 'removeTag', value: 'hot' });
    assert.equal(await SalesLead.countDocuments({ tags: 'hot' }), 0);

    await agent.patch(`${LEADS}/bulk`).send({ ids, operation: 'addService', value: 'aeo' });
    assert.equal(await SalesLead.countDocuments({ potentialServices: 'AEO' }), 4);
    await agent.patch(`${LEADS}/bulk`).send({ ids, operation: 'removeService', value: 'SEO' });
    assert.equal(await SalesLead.countDocuments({ potentialServices: 'SEO' }), 0);
  });

  it('assigns, archives and restores', async () => {
    const { agent } = await loginAgent(app);
    await seed();
    const ids = (await idsOf()).slice(0, 2);
    await agent.patch(`${LEADS}/bulk`).send({ ids, operation: 'assign', value: admin.id });
    assert.equal(await SalesLead.countDocuments({ assignedTo: admin._id }), 2);
    await agent.patch(`${LEADS}/bulk`).send({ ids, operation: 'archive' });
    assert.equal((await agent.get(LEADS)).body.pagination.total, 2);
    await agent.patch(`${LEADS}/bulk`).send({ ids, operation: 'unarchive' });
    assert.equal((await agent.get(LEADS)).body.pagination.total, 4);
  });

  it('validates IDs, operations and values', async () => {
    const { agent } = await loginAgent(app);
    const id = new mongoose.Types.ObjectId().toString();
    const bad = [
      { ids: [], operation: 'status', value: 'NEW' },
      { ids: ['nope'], operation: 'status', value: 'NEW' },
      { ids: [id], operation: 'drop', value: 'x' },
      { ids: [id], operation: 'status', value: 'MAYBE' },
      { ids: [id], operation: 'addService', value: 'Teleportation' },
      { ids: [id], operation: 'addTag', value: '' },
      { ids: [id], operation: 'assign', value: 'nope' },
      { ids: [id], operation: 'assign', value: new mongoose.Types.ObjectId().toString() },
      { ids: Array.from({ length: 501 }, () => new mongoose.Types.ObjectId().toString()), operation: 'archive' },
    ];
    for (const body of bad) assert.equal((await agent.patch(`${LEADS}/bulk`).send(body)).status, 400, JSON.stringify(body).slice(0, 80));
  });
});

describe('GET /api/admin/leads/export', () => {
  it('exports the filtered leads as CSV without internal fields', async () => {
    const { agent } = await loginAgent(app);
    await seed();
    await SalesLead.updateOne({ businessName: 'beta Salon' }, { $set: { customFields: { Instagram: '@beta' } } });

    const res = await agent.get(`${LEADS}/export?status=INTERESTED&city=Hyderabad`);
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/csv/);
    assert.match(res.headers['content-disposition'], /attachment; filename="sales-leads-/);
    assert.equal(res.headers['x-export-count'], '1');

    const lines = res.text.replace(/^\uFEFF/, '').trim().split('\r\n');
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^Business Name,Category,/);
    assert.match(lines[0], /,Instagram$/);
    assert.match(lines[1], /^beta Salon,Salon,/);
    for (const internal of ['dedupe', 'sourceProvider', 'passwordHash', 'sessionVersion', 'lockedBy', 'heartbeatAt', 'createdBy']) {
      assert.doesNotMatch(res.text, new RegExp(internal));
    }
  });

  it('exposes the export headers to the allowed admin origin only', async () => {
    const { agent } = await loginAgent(app);
    const res = await agent.get(`${LEADS}/export`).set('Origin', 'http://localhost:3000');
    assert.equal(res.status, 200);
    assert.equal(res.headers['access-control-allow-origin'], 'http://localhost:3000');
    const exposed = res.headers['access-control-expose-headers'];
    for (const header of ['Content-Disposition', 'X-Export-Count', 'X-Export-Truncated']) {
      assert.ok(exposed.includes(header), `${header} should be exposed`);
    }

    const foreign = await agent.get(`${LEADS}/export`).set('Origin', 'https://evil.example');
    assert.equal(foreign.headers['access-control-allow-origin'], undefined);
  });

  it('validates export filters', async () => {
    const { agent } = await loginAgent(app);
    assert.equal((await agent.get(`${LEADS}/export?sortBy=passwordHash`)).status, 400);
  });
});

describe('GET /api/admin/lead-workspace/meta', () => {
  it('returns the configured vocabulary and live filter options', async () => {
    const { agent } = await loginAgent(app);
    await seed();
    const { data } = (await agent.get('/api/admin/lead-workspace/meta')).body;
    assert.equal(data.statuses.length, 9);
    assert.deepEqual(data.sources, ['AI_DISCOVERY', 'MANUAL', 'CSV_IMPORT', 'OTHER']);
    assert.ok(data.services.includes('Website Redesign') && data.services.includes('AEO'));
    assert.deepEqual(data.facets.cities, ['Hyderabad', 'Pune']);
    assert.deepEqual(data.facets.tags, ['hot', 'vip']);
    assert.deepEqual(data.admins, [{ id: admin.id, email: TEST_ADMIN.email }]);
  });
});
