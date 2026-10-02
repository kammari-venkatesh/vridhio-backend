import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import request from 'supertest';
import app from '../src/app.js';
import { AdminUser } from '../src/models/adminUser.model.js';
import { requireRole } from '../src/middleware/requireRole.js';
import { clearDb, createTestAdmin, getSessionCookie, startTestDb, stopTestDb, TEST_ADMIN } from './helpers/testDb.js';

const JWT_CLAIMS = { algorithm: 'HS256', issuer: 'vridhio-api', audience: 'vridhio-admin' };
const signWith = (payload, secret = process.env.JWT_SECRET_KEY) =>
  jwt.sign(payload, secret, { ...JWT_CLAIMS, ...(payload.exp ? {} : { expiresIn: 3600 }) });
const asCookie = (token) => `vridhio_admin_session=${token}`;

const loginAgent = async () => {
  const agent = request.agent(app);
  const res = await agent.post('/api/admin/auth/login').send(TEST_ADMIN);
  assert.equal(res.status, 200);
  return { agent, cookie: getSessionCookie(res) };
};

before(startTestDb);
after(stopTestDb);
beforeEach(async () => {
  await clearDb();
  await createTestAdmin();
});

describe('AdminUser model', () => {
  it('stores a hash, never the plaintext password, and normalizes email', async () => {
    const stored = await AdminUser.findOne({ email: TEST_ADMIN.email }).select('+passwordHash').lean();
    assert.notEqual(stored.passwordHash, TEST_ADMIN.password);
    assert.match(stored.passwordHash, /^\$2[aby]\$12\$/);
    assert.equal(stored.role, 'admin');

    const upper = await createTestAdmin({ email: 'Second.Admin@Vridhio.TEST ' });
    assert.equal(upper.email, 'second.admin@vridhio.test');
  });

  it('rejects duplicate emails', async () => {
    await assert.rejects(createTestAdmin(), /duplicate key/);
  });

  it('never serializes passwordHash or sessionVersion', async () => {
    const admin = await AdminUser.findOne({ email: TEST_ADMIN.email }).select('+passwordHash +sessionVersion');
    const json = admin.toJSON();
    assert.equal(json.passwordHash, undefined);
    assert.equal(json.sessionVersion, undefined);
    assert.equal(json.email, TEST_ADMIN.email);
  });
});

describe('POST /api/admin/auth/login', () => {
  it('logs in with valid credentials and sets a secure session cookie', async () => {
    const res = await request(app).post('/api/admin/auth/login').send(TEST_ADMIN);

    assert.equal(res.status, 200);
    assert.equal(res.body.data.admin.email, TEST_ADMIN.email);
    assert.equal(res.body.data.admin.passwordHash, undefined);

    const cookie = getSessionCookie(res);
    assert.ok(cookie, 'session cookie should be set');
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Path=\/api/);
    assert.match(cookie, /Max-Age=28800/);

    const token = cookie.split(';')[0].split('=')[1];
    assert.doesNotMatch(JSON.stringify(res.body), new RegExp(token), 'JWT must not be in the response body');
  });

  it('accepts the email case-insensitively', async () => {
    const res = await request(app)
      .post('/api/admin/auth/login')
      .send({ email: '  ADMIN@Vridhio.test ', password: TEST_ADMIN.password });
    assert.equal(res.status, 200);
  });

  it('returns the same generic error for a wrong password and an unknown email', async () => {
    const wrongPassword = await request(app)
      .post('/api/admin/auth/login')
      .send({ email: TEST_ADMIN.email, password: 'wrong-password-123' });
    const unknownEmail = await request(app)
      .post('/api/admin/auth/login')
      .send({ email: 'nobody@vridhio.test', password: TEST_ADMIN.password });

    for (const res of [wrongPassword, unknownEmail]) {
      assert.equal(res.status, 401);
      assert.equal(res.body.message, 'Invalid email or password');
      assert.equal(getSessionCookie(res), undefined);
    }
  });

  it('rejects missing credentials with a validation error', async () => {
    const res = await request(app).post('/api/admin/auth/login').send({});
    assert.equal(res.status, 400);
    assert.ok(res.body.details.email);
    assert.ok(res.body.details.password);
  });
});

describe('authentication middleware', () => {
  it('rejects requests without a session cookie', async () => {
    const res = await request(app).get('/api/admin/auth/me');
    assert.equal(res.status, 401);
    assert.equal(res.body.message, 'Authentication required');
  });

  it('rejects a malformed JWT', async () => {
    const res = await request(app).get('/api/admin/auth/me').set('Cookie', asCookie('not-a-jwt'));
    assert.equal(res.status, 401);
    assert.equal(res.body.message, 'Invalid session');
  });

  it('rejects a JWT signed with a different secret', async () => {
    const admin = await AdminUser.findOne({ email: TEST_ADMIN.email });
    const token = signWith({ sub: admin.id, ver: 0 }, 'some-other-secret-that-is-long-enough-123');
    const res = await request(app).get('/api/admin/auth/me').set('Cookie', asCookie(token));
    assert.equal(res.status, 401);
    assert.equal(res.body.message, 'Invalid session');
  });

  it('rejects an expired JWT', async () => {
    const admin = await AdminUser.findOne({ email: TEST_ADMIN.email });
    const token = signWith({ sub: admin.id, ver: 0, exp: Math.floor(Date.now() / 1000) - 60 });
    const res = await request(app).get('/api/admin/auth/me').set('Cookie', asCookie(token));
    assert.equal(res.status, 401);
    assert.equal(res.body.message, 'Session expired');
  });

  it('rejects a valid JWT for an admin that no longer exists', async () => {
    const token = signWith({ sub: new mongoose.Types.ObjectId().toString(), ver: 0 });
    const res = await request(app).get('/api/admin/auth/me').set('Cookie', asCookie(token));
    assert.equal(res.status, 401);
  });

  it('returns the current admin without sensitive fields', async () => {
    const { agent } = await loginAgent();
    const res = await agent.get('/api/admin/auth/me');
    assert.equal(res.status, 200);
    assert.equal(res.body.data.admin.email, TEST_ADMIN.email);
    assert.equal(res.body.data.admin.passwordHash, undefined);
    assert.equal(res.body.data.admin.sessionVersion, undefined);
  });
});

describe('admin authorization', () => {
  const run = (req) =>
    new Promise((resolve) => {
      requireRole('admin')(req, {}, (err) => resolve(err));
    });

  it('allows admins and rejects other roles', async () => {
    assert.equal(await run({ admin: { role: 'admin' } }), undefined);
    assert.equal((await run({ admin: { role: 'viewer' } })).statusCode, 403);
    assert.equal((await run({})).statusCode, 401);
  });

  it('uses the role stored in the database, not claims in the token', async () => {
    const { agent } = await loginAgent();
    // Bypass schema validation to simulate a non-admin account.
    await AdminUser.collection.updateOne({ email: TEST_ADMIN.email }, { $set: { role: 'viewer' } });

    const res = await agent.get('/api/admin/dashboard');
    assert.equal(res.status, 403);

    const admin = await AdminUser.findOne({ email: TEST_ADMIN.email });
    const forged = signWith({ sub: admin.id, ver: 0, role: 'admin' });
    const forgedRes = await request(app).get('/api/admin/dashboard').set('Cookie', asCookie(forged));
    assert.equal(forgedRes.status, 403);
  });
});

describe('GET /api/admin/dashboard', () => {
  it('is not accessible without authentication', async () => {
    const res = await request(app).get('/api/admin/dashboard');
    assert.equal(res.status, 401);
  });

  it('returns dashboard data for an authenticated admin', async () => {
    const { agent } = await loginAgent();
    const res = await agent.get('/api/admin/dashboard');
    assert.equal(res.status, 200);
    assert.equal(res.body.data.admin.email, TEST_ADMIN.email);
    assert.equal(typeof res.body.data.stats.inboundLeads, 'number');
    assert.equal(res.body.data.modules[0].status, 'active');
    assert.equal(res.body.data.stats.leadFinder.activeJobs, 0);
  });

  it('marks private responses as non-cacheable', async () => {
    const { agent } = await loginAgent();
    for (const path of ['/api/admin/dashboard', '/api/admin/auth/me', '/api/leads']) {
      const res = await agent.get(path);
      assert.equal(res.status, 200);
      assert.equal(res.headers['cache-control'], 'no-store', `${path} must not be cached`);
    }
  });

  it('protects unknown admin routes too', async () => {
    const res = await request(app).get('/api/admin/anything-else');
    assert.equal(res.status, 401);
  });
});

describe('/api/leads protection', () => {
  const lead = {
    name: 'Test Business',
    email: 'owner@example.com',
    phone: '9876543210',
    services: ['SEO'],
    message: 'We need help with search.',
  };

  it('keeps lead submission public', async () => {
    const res = await request(app).post('/api/leads').send(lead);
    assert.equal(res.status, 201);
  });

  it('blocks listing leads without authentication', async () => {
    const res = await request(app).get('/api/leads');
    assert.equal(res.status, 401);
    assert.equal(res.body.data, undefined);
  });

  it('allows an authenticated admin to list leads', async () => {
    await request(app).post('/api/leads').send(lead);
    const { agent } = await loginAgent();
    const res = await agent.get('/api/leads');
    assert.equal(res.status, 200);
    assert.ok(res.body.data.some((l) => l.email === lead.email));
  });
});

describe('POST /api/admin/auth/logout', () => {
  it('clears the cookie and revokes the previous session token', async () => {
    const { agent, cookie } = await loginAgent();
    const oldToken = cookie.split(';')[0].split('=')[1];

    const res = await agent.post('/api/admin/auth/logout');
    assert.equal(res.status, 200);
    assert.match(getSessionCookie(res), /Expires=Thu, 01 Jan 1970/);

    const afterLogout = await agent.get('/api/admin/auth/me');
    assert.equal(afterLogout.status, 401);

    const replay = await request(app).get('/api/admin/dashboard').set('Cookie', asCookie(oldToken));
    assert.equal(replay.status, 401, 'a token from before logout must no longer work');
  });

  it('succeeds even without a session', async () => {
    const res = await request(app).post('/api/admin/auth/logout');
    assert.equal(res.status, 200);
  });
});
