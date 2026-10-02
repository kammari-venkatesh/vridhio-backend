import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import { connectDB, disconnectDB } from '../../src/config/db.js';
import { AdminUser } from '../../src/models/adminUser.model.js';
import { AiUsageRecord } from '../../src/models/aiUsageRecord.model.js';
import { LeadFinderJob } from '../../src/models/leadFinderJob.model.js';
import { Prospect } from '../../src/models/prospect.model.js';
import { ProspectQualification } from '../../src/models/prospectQualification.model.js';
import { ProspectReview } from '../../src/models/prospectReview.model.js';
import { ProspectWebsiteAnalysis } from '../../src/models/prospectWebsiteAnalysis.model.js';
import { SalesLead } from '../../src/models/salesLead.model.js';
import { hashPassword } from '../../src/utils/password.js';

export const TEST_ADMIN = { email: 'admin@vridhio.test', password: 'correct-horse-battery-staple' };

let mongo;

export const startTestDb = async () => {
  mongo = await MongoMemoryServer.create();
  await connectDB(mongo.getUri('vridhio_test'));
  await Promise.all([
    AdminUser.init(),
    LeadFinderJob.init(),
    Prospect.init(),
    SalesLead.init(),
    ProspectWebsiteAnalysis.init(),
    ProspectQualification.init(),
    ProspectReview.init(),
    AiUsageRecord.init(),
  ]);
};

export const stopTestDb = async () => {
  await disconnectDB();
  await mongo?.stop();
};

export const clearDb = () => Promise.all(Object.values(mongoose.models).map((model) => model.deleteMany({})));

export const createTestAdmin = async (overrides = {}) =>
  AdminUser.create({
    email: TEST_ADMIN.email,
    passwordHash: await hashPassword(TEST_ADMIN.password),
    ...overrides,
  });

export const getSessionCookie = (res) =>
  (res.headers['set-cookie'] ?? []).find((c) => c.startsWith('vridhio_admin_session='));

export const loginAgent = async (app, credentials = TEST_ADMIN) => {
  const agent = request.agent(app);
  const res = await agent.post('/api/admin/auth/login').send(credentials);
  assert.equal(res.status, 200);
  return { agent, cookie: getSessionCookie(res) };
};
