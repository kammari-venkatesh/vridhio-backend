import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import app from '../src/app.js';
import { createTestAdmin, startTestDb, stopTestDb, TEST_ADMIN } from './helpers/testDb.js';

before(async () => {
  await startTestDb();
  await createTestAdmin();
});
after(stopTestDb);

describe('login rate limiting', () => {
  it('blocks further attempts after 10 failed logins', async () => {
    const attempt = () =>
      request(app).post('/api/admin/auth/login').send({ email: TEST_ADMIN.email, password: 'wrong-password-123' });

    for (let i = 0; i < 10; i += 1) {
      assert.equal((await attempt()).status, 401);
    }

    const blocked = await attempt();
    assert.equal(blocked.status, 429);
    assert.match(blocked.body.message, /Too many login attempts/);

    const correct = await request(app).post('/api/admin/auth/login').send(TEST_ADMIN);
    assert.equal(correct.status, 429, 'correct password is also blocked while rate limited');
  });

  it('does not rate limit other endpoints', async () => {
    const res = await request(app).get('/api/health');
    assert.equal(res.status, 200);
  });
});
