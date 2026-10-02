import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import mongoose from 'mongoose';
import request from 'supertest';
import app from '../src/app.js';
import { AdminUser } from '../src/models/adminUser.model.js';
import { SalesLead } from '../src/models/salesLead.model.js';
import { clearDb, createTestAdmin, loginAgent, startTestDb, stopTestDb, TEST_ADMIN } from './helpers/testDb.js';

const ADMINS = '/api/admin/admins';
const NEW_ADMIN = { email: 'Teammate@Vridhio.test ', password: 'another-long-password' };

let agent;
let me;

before(startTestDb);
after(stopTestDb);
beforeEach(async () => {
  await clearDb();
  me = await createTestAdmin();
  ({ agent } = await loginAgent(app));
});

const createTeammate = async () => {
  const res = await agent.post(ADMINS).send(NEW_ADMIN);
  assert.equal(res.status, 201);
  return res.body.data;
};

describe('Admin access: permissions', () => {
  it('requires an authenticated admin for every endpoint', async () => {
    const id = new mongoose.Types.ObjectId().toString();
    const anon = request(app);
    for (const res of [
      await anon.get(ADMINS),
      await anon.post(ADMINS).send(NEW_ADMIN),
      await anon.patch(`${ADMINS}/${id}`).send({ disabled: true }),
      await anon.post(`${ADMINS}/${id}/password`).send({ password: 'x'.repeat(12) }),
      await anon.delete(`${ADMINS}/${id}`),
    ]) {
      assert.equal(res.status, 401);
    }
    assert.equal(await AdminUser.countDocuments(), 1);
  });
});

describe('Admin access: create and list', () => {
  it('creates an admin who can sign in, and never returns password hashes', async () => {
    const created = await createTeammate();
    assert.equal(created.email, 'teammate@vridhio.test');
    assert.equal(created.disabled, false);
    assert.equal(created.role, 'admin');
    assert.equal(created.createdBy.email, TEST_ADMIN.email);
    assert.equal(created.passwordHash, undefined);
    assert.equal(created.sessionVersion, undefined);

    const login = await request(app).post('/api/admin/auth/login').send({ email: 'teammate@vridhio.test', password: NEW_ADMIN.password });
    assert.equal(login.status, 200);

    const list = await agent.get(ADMINS);
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.data.map((a) => a.email), [TEST_ADMIN.email, 'teammate@vridhio.test']);
    assert.ok(list.body.data[1].lastLoginAt);
    assert.ok(!JSON.stringify(list.body).includes('passwordHash'));
  });

  it('validates input and rejects duplicates and extra fields', async () => {
    for (const body of [
      { email: 'not-an-email', password: NEW_ADMIN.password },
      { email: 'a@b.co', password: 'short' },
      { email: 'a@b.co', password: ' '.repeat(12) },
      { email: 'a@b.co', password: NEW_ADMIN.password, role: 'superadmin' },
      { email: 'a@b.co', password: NEW_ADMIN.password, disabled: false },
    ]) {
      assert.equal((await agent.post(ADMINS).send(body)).status, 400, JSON.stringify(body));
    }
    await createTeammate();
    const dup = await agent.post(ADMINS).send({ ...NEW_ADMIN, email: 'TEAMMATE@vridhio.test' });
    assert.equal(dup.status, 409);
    assert.equal(await AdminUser.countDocuments(), 2);
  });
});

describe('Admin access: deactivate, reactivate, remove', () => {
  it('deactivating blocks login and ends existing sessions', async () => {
    const teammate = await createTeammate();
    const { agent: theirs } = await loginAgent(app, { email: 'teammate@vridhio.test', password: NEW_ADMIN.password });
    assert.equal((await theirs.get('/api/admin/auth/me')).status, 200);

    const res = await agent.patch(`${ADMINS}/${teammate.id}`).send({ disabled: true });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.disabled, true);
    assert.equal((await theirs.get('/api/admin/auth/me')).status, 401);
    const login = await request(app).post('/api/admin/auth/login').send({ email: 'teammate@vridhio.test', password: NEW_ADMIN.password });
    assert.equal(login.status, 401);
    assert.equal(login.body.message, 'Invalid email or password');

    assert.equal((await agent.patch(`${ADMINS}/${teammate.id}`).send({ disabled: false })).status, 200);
    const again = await request(app).post('/api/admin/auth/login').send({ email: 'teammate@vridhio.test', password: NEW_ADMIN.password });
    assert.equal(again.status, 200);
  });

  it('does not let you deactivate or remove your own account', async () => {
    assert.equal((await agent.patch(`${ADMINS}/${me.id}`).send({ disabled: true })).status, 400);
    assert.equal((await agent.delete(`${ADMINS}/${me.id}`)).status, 400);
    assert.equal((await AdminUser.findById(me.id)).disabled, false);
  });

  it('always leaves at least one active admin, even when two deactivate each other at once', async () => {
    const teammate = await createTeammate();
    const { agent: theirs } = await loginAgent(app, { email: 'teammate@vridhio.test', password: NEW_ADMIN.password });
    await Promise.all([
      agent.patch(`${ADMINS}/${teammate.id}`).send({ disabled: true }),
      theirs.patch(`${ADMINS}/${me.id}`).send({ disabled: true }),
    ]);
    assert.ok((await AdminUser.countDocuments({ disabled: { $ne: true } })) >= 1);
  });

  it('only removes deactivated admins and unassigns their leads', async () => {
    const teammate = await createTeammate();
    const lead = await SalesLead.create({ businessName: 'Assigned Co', assignedTo: teammate.id });
    const active = await agent.delete(`${ADMINS}/${teammate.id}`);
    assert.equal(active.status, 409);
    await agent.patch(`${ADMINS}/${teammate.id}`).send({ disabled: true });
    const res = await agent.delete(`${ADMINS}/${teammate.id}`);
    assert.equal(res.status, 200);
    assert.equal(await AdminUser.exists({ _id: teammate.id }), null);
    assert.equal((await SalesLead.findById(lead.id)).assignedTo, null);
    assert.equal((await agent.delete(`${ADMINS}/${teammate.id}`)).status, 404);
  });

  it('hides deactivated admins from lead assignment', async () => {
    const teammate = await createTeammate();
    await agent.patch(`${ADMINS}/${teammate.id}`).send({ disabled: true });
    const lead = await SalesLead.create({ businessName: 'Assign Me' });
    const res = await agent.patch(`/api/admin/leads/${lead.id}`).send({ assignedTo: teammate.id });
    assert.equal(res.status, 400);
  });
});

describe('Admin access: passwords', () => {
  it('resets another admin password and signs them out', async () => {
    const teammate = await createTeammate();
    const { agent: theirs } = await loginAgent(app, { email: 'teammate@vridhio.test', password: NEW_ADMIN.password });
    const res = await agent.post(`${ADMINS}/${teammate.id}/password`).send({ password: 'brand-new-password-1' });
    assert.equal(res.status, 200);
    assert.equal((await theirs.get('/api/admin/auth/me')).status, 401);
    const oldLogin = await request(app).post('/api/admin/auth/login').send({ email: 'teammate@vridhio.test', password: NEW_ADMIN.password });
    assert.equal(oldLogin.status, 401);
    const newLogin = await request(app).post('/api/admin/auth/login').send({ email: 'teammate@vridhio.test', password: 'brand-new-password-1' });
    assert.equal(newLogin.status, 200);
  });

  it('changing your own password needs the current one and keeps this session', async () => {
    const { agent: otherSession } = await loginAgent(app);
    const wrong = await agent.post(`${ADMINS}/${me.id}/password`).send({ password: 'brand-new-password-1', currentPassword: 'nope' });
    assert.equal(wrong.status, 400);
    assert.ok(wrong.body.details.currentPassword);
    const missing = await agent.post(`${ADMINS}/${me.id}/password`).send({ password: 'brand-new-password-1' });
    assert.equal(missing.status, 400);

    const ok = await agent
      .post(`${ADMINS}/${me.id}/password`)
      .send({ password: 'brand-new-password-1', currentPassword: TEST_ADMIN.password });
    assert.equal(ok.status, 200);
    assert.equal((await agent.get('/api/admin/auth/me')).status, 200);
    assert.equal((await otherSession.get('/api/admin/auth/me')).status, 401);
  });

  it('validates the new password', async () => {
    const teammate = await createTeammate();
    assert.equal((await agent.post(`${ADMINS}/${teammate.id}/password`).send({ password: 'short' })).status, 400);
    assert.equal((await agent.post(`${ADMINS}/${teammate.id}/password`).send({ password: 'x'.repeat(129) })).status, 400);
    assert.equal((await agent.post(`${ADMINS}/nope/password`).send({ password: 'long-enough-password' })).status, 404);
  });
});
