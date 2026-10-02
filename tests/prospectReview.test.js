import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import mongoose from 'mongoose';
import request from 'supertest';
import app from '../src/app.js';
import { SERVICE_CATALOG } from '../src/config/leadWorkspace.js';
import { AdminUser } from '../src/models/adminUser.model.js';
import { ProspectQualification } from '../src/models/prospectQualification.model.js';
import { ProspectReview } from '../src/models/prospectReview.model.js';
import { ProspectWebsiteAnalysis } from '../src/models/prospectWebsiteAnalysis.model.js';
import { SalesLead } from '../src/models/salesLead.model.js';
import { promoteProspect } from '../src/services/leadWorkspace/salesLead.service.js';
import { createFakeQualificationProvider } from '../src/services/qualification/providers/fakeProvider.js';
import { setQualificationProvider } from '../src/services/qualification/providers/index.js';
import { createQualificationWorker } from '../src/services/qualification/worker.js';
import { analysedProspect, newProspect } from './helpers/qualification.js';
import { clearDb, createTestAdmin, loginAgent, startTestDb, stopTestDb, TEST_ADMIN } from './helpers/testDb.js';

const P = (id) => `/api/admin/prospects/${id}`;
const LEADS = '/api/admin/leads';
const silent = { error() {}, warn() {} };
const serviceName = (id) => SERVICE_CATALOG.find((s) => s.id === id).name;

let agent;
let admin;

before(startTestDb);
after(stopTestDb);
beforeEach(async () => {
  await clearDb();
  admin = await createTestAdmin();
  setQualificationProvider(createFakeQualificationProvider());
  ({ agent } = await loginAgent(app));
});
afterEach(() => setQualificationProvider(null));

/** A prospect with a completed Phase 4 analysis and Phase 5 qualification (fake provider). */
const qualifiedProspect = async (kind = 'B') => {
  const { prospect, target } = await analysedProspect(kind);
  const res = await agent.post(`/api/admin/lead-finder/prospects/${prospect.id}/qualify`);
  assert.equal(res.status, 202);
  const worker = createQualificationWorker({ logger: silent });
  while (await worker.runOnce());
  const qualification = await ProspectQualification.findOne({ subjectKey: target.subjectKey });
  assert.equal(qualification.status, 'COMPLETED');
  const recommended = qualification.opportunities.map((o) => o.serviceId);
  assert.ok(recommended.length >= 2, 'fixture B should produce at least two recommendations');
  return { prospect, target, qualification, recommended };
};

const unrecommendedService = (recommended) => SERVICE_CATALOG.find((s) => !recommended.includes(s.id)).id;

const approveBody = (version, serviceId, extra = {}) => ({
  expectedVersion: version,
  evidenceAcknowledged: true,
  serviceDecisions: [{ serviceId, decision: 'APPROVED' }],
  ...extra,
});

describe('Review API: access control', () => {
  it('requires an authenticated admin for every endpoint', async () => {
    const id = new mongoose.Types.ObjectId().toString();
    const lead = await SalesLead.create({ businessName: 'Manual Co' });
    const anon = request(app);
    for (const res of [
      await anon.get(`${P(id)}/review`),
      await anon.post(`${P(id)}/review`).send({}),
      await anon.patch(`${P(id)}/review`).send({ expectedVersion: 1 }),
      await anon.post(`${P(id)}/approve`).send({ expectedVersion: 1 }),
      await anon.post(`${P(id)}/reject`).send({ expectedVersion: 1 }),
      await anon.get(`${P(id)}/outreach-preview`),
      await anon.get(`${LEADS}/${lead.id}/review`),
      await anon.post(`${LEADS}/${lead.id}/review/approve`).send({ expectedVersion: 1 }),
      await anon.get(`${LEADS}/${lead.id}/outreach-preview`),
    ]) {
      assert.equal(res.status, 401);
    }
    await AdminUser.collection.updateOne({ email: TEST_ADMIN.email }, { $set: { role: 'viewer' } });
    assert.equal((await agent.get(`${P(id)}/review`)).status, 403);
    assert.equal((await agent.post(`${P(id)}/review`).send({})).status, 403);
    assert.equal(await ProspectReview.countDocuments(), 0);
  });

  it('returns 404 for unknown or malformed prospect ids', async () => {
    assert.equal((await agent.get(`${P('nope')}/review`)).status, 404);
    assert.equal((await agent.post(`${P(new mongoose.Types.ObjectId())}/review`).send({})).status, 404);
  });

  it('takes the reviewer from the session and rejects spoofing attempts', async () => {
    const { prospect } = await qualifiedProspect();
    const other = new mongoose.Types.ObjectId().toString();
    for (const body of [
      { reviewerId: other },
      { reviewer: { id: other } },
      { approvedServices: ['seo-optimization'] },
      { decision: 'APPROVED' },
      { reviewedAt: new Date().toISOString() },
    ]) {
      const res = await agent.post(`${P(prospect.id)}/review`).send(body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    const res = await agent.post(`${P(prospect.id)}/review`).send({ reviewNotes: 'Looks promising' });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.review.reviewer.id, admin.id);
    assert.equal(res.body.data.review.reviewer.email, TEST_ADMIN.email);
    const patch = await agent.patch(`${P(prospect.id)}/review`).send({ expectedVersion: 1, reviewerId: other });
    assert.equal(patch.status, 400);
    assert.equal(patch.body.details.reviewerId, 'This field is not allowed.');
    const stored = await ProspectReview.findOne();
    assert.equal(stored.reviewerId.toString(), admin.id);
  });
});

describe('Review API: create, read, update', () => {
  it('creates a pending review without auto-approving any AI recommendation', async () => {
    const { prospect, qualification } = await qualifiedProspect();
    const empty = await agent.get(`${P(prospect.id)}/review`);
    assert.equal(empty.status, 200);
    assert.equal(empty.body.data.review, null);
    assert.equal(empty.body.data.readiness.status, 'AI_REVIEWED');

    const res = await agent.post(`${P(prospect.id)}/review`).send({ reviewNotes: 'First look' });
    assert.equal(res.status, 201);
    const { review, readiness } = res.body.data;
    assert.equal(review.decision, 'PENDING');
    assert.equal(review.version, 1);
    assert.equal(review.qualificationId, qualification.id);
    assert.equal(review.prospectId, prospect.id);
    assert.deepEqual(review.approvedServices, []);
    assert.deepEqual(review.serviceDecisions, []);
    assert.equal(review.evidenceAcknowledged, false);
    assert.equal(readiness.status, 'AI_REVIEWED');
    assert.equal(review.history.length, 1);
    assert.equal(review.history[0].action, 'CREATED');

    const got = await agent.get(`${P(prospect.id)}/review`);
    assert.equal(got.body.data.review.id, review.id);
    assert.equal(got.body.data.review.reviewNotes, 'First look');
  });

  it('refuses a second review for the same prospect', async () => {
    const { prospect } = await qualifiedProspect();
    assert.equal((await agent.post(`${P(prospect.id)}/review`).send({})).status, 201);
    const dup = await agent.post(`${P(prospect.id)}/review`).send({});
    assert.equal(dup.status, 409);
    assert.equal(dup.body.details.code, 'REVIEW_CONFLICT');
    assert.equal(await ProspectReview.countDocuments(), 1);
  });

  it('saves per-service approve and reject decisions and reviewer edits', async () => {
    const { prospect, recommended } = await qualifiedProspect();
    await agent.post(`${P(prospect.id)}/review`).send({});
    const [first, second] = recommended;
    const res = await agent.patch(`${P(prospect.id)}/review`).send({
      expectedVersion: 1,
      serviceDecisions: [
        { serviceId: first, decision: 'APPROVED' },
        { serviceId: second, decision: 'REJECTED' },
      ],
      reviewerEditedSummary: 'Bakery site lacks a meta description.',
      reviewerEditedNextAction: 'Call the owner.',
      evidenceAcknowledged: true,
    });
    assert.equal(res.status, 200);
    const { review } = res.body.data;
    assert.equal(review.version, 2);
    assert.equal(review.decision, 'PENDING');
    assert.deepEqual(review.approvedServices, [{ serviceId: first, serviceName: serviceName(first) }]);
    assert.deepEqual(review.rejectedServices, [{ serviceId: second, serviceName: serviceName(second) }]);
    assert.equal(review.reviewerEditedSummary, 'Bakery site lacks a meta description.');
    assert.equal(review.history[0].action, 'UPDATED');
    // Saving is not approval.
    assert.equal(res.body.data.readiness.status, 'AI_REVIEWED');

    const undo = await agent.patch(`${P(prospect.id)}/review`).send({
      expectedVersion: 2,
      serviceDecisions: [{ serviceId: first, decision: 'UNDECIDED' }],
    });
    assert.deepEqual(undo.body.data.review.approvedServices, []);
    assert.equal(undo.body.data.review.reviewerEditedSummary, 'Bakery site lacks a meta description.');
  });

  it('rejects unknown or unrecommended service ids', async () => {
    const { prospect, recommended } = await qualifiedProspect();
    await agent.post(`${P(prospect.id)}/review`).send({});
    const unknown = await agent
      .patch(`${P(prospect.id)}/review`)
      .send({ expectedVersion: 1, serviceDecisions: [{ serviceId: 'free-money', decision: 'APPROVED' }] });
    assert.equal(unknown.status, 400);
    assert.match(unknown.body.details['serviceDecisions.0'], /Unknown service/);
    const notRecommended = await agent
      .patch(`${P(prospect.id)}/review`)
      .send({ expectedVersion: 1, serviceDecisions: [{ serviceId: unrecommendedService(recommended), decision: 'APPROVED' }] });
    assert.equal(notRecommended.status, 400);
    assert.match(notRecommended.body.details['serviceDecisions.0'], /not recommended/);
    const malformed = await agent
      .patch(`${P(prospect.id)}/review`)
      .send({ expectedVersion: 1, serviceDecisions: [{ serviceId: '$where', decision: 'APPROVED' }] });
    assert.equal(malformed.status, 400);
    const duplicate = await agent.patch(`${P(prospect.id)}/review`).send({
      expectedVersion: 1,
      serviceDecisions: [
        { serviceId: recommended[0], decision: 'APPROVED' },
        { serviceId: recommended[0], decision: 'REJECTED' },
      ],
    });
    assert.equal(duplicate.status, 400);
    assert.equal((await ProspectReview.findOne()).version, 1);
  });

  it('marks a review as needing more review', async () => {
    const { prospect } = await qualifiedProspect();
    await agent.post(`${P(prospect.id)}/review`).send({});
    const res = await agent.patch(`${P(prospect.id)}/review`).send({ expectedVersion: 1, decision: 'NEEDS_REVIEW', reviewNotes: 'Check phone' });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.review.decision, 'NEEDS_REVIEW');
    assert.equal(res.body.data.readiness.status, 'AI_REVIEWED');
    assert.equal(res.body.data.review.history[0].previousDecision, 'PENDING');
    assert.equal(res.body.data.review.history[0].newDecision, 'NEEDS_REVIEW');
  });

  it('requires a completed analysis and qualification', async () => {
    const unanalysed = await newProspect();
    const noAnalysis = await agent.post(`${P(unanalysed.id)}/review`).send({});
    assert.equal(noAnalysis.status, 409);
    assert.equal(noAnalysis.body.details.code, 'ANALYSIS_REQUIRED');
    assert.equal((await agent.get(`${P(unanalysed.id)}/review`)).body.data.readiness.status, 'NOT_REVIEWED');

    const { prospect } = await analysedProspect('B');
    const noQualification = await agent.post(`${P(prospect.id)}/review`).send({});
    assert.equal(noQualification.status, 409);
    assert.equal(noQualification.body.details.code, 'QUALIFICATION_REQUIRED');
    const approve = await agent.post(`${P(prospect.id)}/approve`).send({ expectedVersion: 0, evidenceAcknowledged: true });
    assert.equal(approve.status, 409);
    assert.equal(await ProspectReview.countDocuments(), 0);
  });
});

describe('Review API: approval', () => {
  it('requires acknowledged evidence and at least one approved service', async () => {
    const { prospect, recommended } = await qualifiedProspect();
    const noAck = await agent
      .post(`${P(prospect.id)}/approve`)
      .send({ expectedVersion: 0, serviceDecisions: [{ serviceId: recommended[0], decision: 'APPROVED' }] });
    assert.equal(noAck.status, 400);
    assert.ok(noAck.body.details.evidenceAcknowledged);
    const noService = await agent.post(`${P(prospect.id)}/approve`).send({ expectedVersion: 0, evidenceAcknowledged: true });
    assert.equal(noService.status, 400);
    assert.ok(noService.body.details.serviceDecisions);
    const onlyRejected = await agent.post(`${P(prospect.id)}/approve`).send({
      expectedVersion: 0,
      evidenceAcknowledged: true,
      serviceDecisions: [{ serviceId: recommended[0], decision: 'REJECTED' }],
    });
    assert.equal(onlyRejected.status, 400);
    assert.equal(await ProspectReview.countDocuments(), 0);
  });

  it('approves only the services the reviewer approved and becomes outreach-ready', async () => {
    const { prospect, recommended, qualification } = await qualifiedProspect();
    const [first, second] = recommended;
    const res = await agent.post(`${P(prospect.id)}/approve`).send(
      approveBody(0, first, {
        serviceDecisions: [
          { serviceId: first, decision: 'APPROVED' },
          { serviceId: second, decision: 'REJECTED' },
        ],
      }),
    );
    assert.equal(res.status, 200);
    const { review, readiness } = res.body.data;
    assert.equal(review.decision, 'APPROVED');
    assert.deepEqual(review.approvedServices.map((s) => s.serviceId), [first]);
    assert.deepEqual(review.rejectedServices.map((s) => s.serviceId), [second]);
    assert.ok(review.reviewedAt);
    assert.equal(readiness.status, 'OUTREACH_READY');
    assert.deepEqual(readiness.problems, []);
    // AI recommendations that were not decided are not approved.
    for (const id of recommended.slice(2)) assert.ok(!review.approvedServices.some((s) => s.serviceId === id));
    // The qualification itself is untouched.
    const after = await ProspectQualification.findById(qualification._id).lean();
    assert.deepEqual(after.opportunities, qualification.toObject().opportunities);
  });

  it('refuses a duplicate approval', async () => {
    const { prospect, recommended } = await qualifiedProspect();
    assert.equal((await agent.post(`${P(prospect.id)}/approve`).send(approveBody(0, recommended[0]))).status, 200);
    const dup = await agent.post(`${P(prospect.id)}/approve`).send(approveBody(1, recommended[0]));
    assert.equal(dup.status, 409);
    assert.equal(dup.body.details.code, 'ALREADY_APPROVED');
    const stale = await agent.post(`${P(prospect.id)}/approve`).send(approveBody(0, recommended[0]));
    assert.equal(stale.status, 409);
    assert.equal((await ProspectReview.findOne()).version, 1);
  });

  it('lets exactly one of two concurrent approvals win', async () => {
    const { prospect, recommended } = await qualifiedProspect();
    await agent.post(`${P(prospect.id)}/review`).send({});
    const { agent: second } = await loginAgent(app);
    const results = await Promise.all([
      agent.post(`${P(prospect.id)}/approve`).send(approveBody(1, recommended[0])),
      second.post(`${P(prospect.id)}/approve`).send(approveBody(1, recommended[1])),
    ]);
    const statuses = results.map((r) => r.status).sort();
    assert.deepEqual(statuses, [200, 409]);
    const stored = await ProspectReview.findOne();
    assert.equal(stored.version, 2);
    assert.equal(stored.approvedServices.length, 1);
    assert.equal(stored.history.filter((h) => h.action === 'APPROVED').length, 1);
  });

  it('lets exactly one of two concurrent first reviews win', async () => {
    const { prospect, recommended } = await qualifiedProspect();
    const results = await Promise.all([
      agent.post(`${P(prospect.id)}/review`).send({}),
      agent.post(`${P(prospect.id)}/approve`).send(approveBody(0, recommended[0])),
    ]);
    assert.equal(results.filter((r) => r.status === 409).length, 1);
    assert.ok(results.some((r) => r.status === 200 || r.status === 201));
    assert.equal(await ProspectReview.countDocuments(), 1);
  });

  it('refuses approval when the evidence behind a service is missing', async () => {
    const { prospect, recommended, qualification } = await qualifiedProspect();
    const opp = qualification.opportunities.find((o) => o.serviceId === recommended[0]);
    await ProspectQualification.collection.updateOne(
      { _id: qualification._id },
      { $pull: { evidenceSnapshot: { id: { $in: opp.evidenceReferences } } } },
    );
    const res = await agent.post(`${P(prospect.id)}/approve`).send(approveBody(0, recommended[0]));
    assert.equal(res.status, 422);
    assert.equal(res.body.details.code, 'EVIDENCE_INVALID');
    assert.equal(await ProspectReview.countDocuments(), 0);
  });

  it('drops readiness when the qualification changes after approval', async () => {
    const { prospect, recommended, qualification } = await qualifiedProspect();
    await agent.post(`${P(prospect.id)}/approve`).send(approveBody(0, recommended[0]));
    await ProspectQualification.collection.updateOne({ _id: qualification._id }, { $set: { completedAt: new Date(Date.now() + 1000) } });
    const res = await agent.get(`${P(prospect.id)}/review`);
    assert.equal(res.body.data.review.outdated, true);
    assert.equal(res.body.data.readiness.status, 'HUMAN_APPROVED');
    assert.ok(res.body.data.readiness.problems.length > 0);
    // Re-approving against the new qualification is allowed and restores readiness.
    const again = await agent.post(`${P(prospect.id)}/approve`).send(approveBody(1, recommended[0]));
    assert.equal(again.status, 200);
    assert.equal(again.body.data.readiness.status, 'OUTREACH_READY');
  });

  it('drops readiness when the website analysis disappears', async () => {
    const { prospect, recommended } = await qualifiedProspect();
    await agent.post(`${P(prospect.id)}/approve`).send(approveBody(0, recommended[0]));
    await ProspectWebsiteAnalysis.deleteMany({});
    const res = await agent.get(`${P(prospect.id)}/review`);
    assert.equal(res.body.data.readiness.status, 'HUMAN_APPROVED');
  });

  it('editing an approved review returns it to pending', async () => {
    const { prospect, recommended } = await qualifiedProspect();
    await agent.post(`${P(prospect.id)}/approve`).send(approveBody(0, recommended[0]));
    const res = await agent.patch(`${P(prospect.id)}/review`).send({
      expectedVersion: 1,
      serviceDecisions: [{ serviceId: recommended[1], decision: 'APPROVED' }],
    });
    assert.equal(res.body.data.review.decision, 'PENDING');
    assert.notEqual(res.body.data.readiness.status, 'OUTREACH_READY');
  });
});

describe('Review API: rejection and readiness', () => {
  it('rejects without deleting the qualification and can never be ready', async () => {
    const { prospect, recommended, qualification } = await qualifiedProspect();
    const res = await agent.post(`${P(prospect.id)}/reject`).send({
      expectedVersion: 0,
      reviewNotes: 'Not a fit',
      serviceDecisions: [{ serviceId: recommended[0], decision: 'APPROVED' }],
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.review.decision, 'REJECTED');
    assert.equal(res.body.data.readiness.status, 'HUMAN_REJECTED');
    assert.ok(await ProspectQualification.findById(qualification._id));
    const dup = await agent.post(`${P(prospect.id)}/reject`).send({ expectedVersion: 1 });
    assert.equal(dup.status, 409);
    const preview = await agent.get(`${P(prospect.id)}/outreach-preview`);
    assert.equal(preview.body.data.readiness.status, 'HUMAN_REJECTED');
    assert.deepEqual(preview.body.data.approvedServices, []);
  });

  it('an unreviewed prospect is not ready', async () => {
    const { prospect } = await qualifiedProspect();
    const res = await agent.get(`${P(prospect.id)}/outreach-preview`);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.readiness.status, 'AI_REVIEWED');
    assert.deepEqual(res.body.data.approvedServices, []);
  });

  it('records an audit trail without sensitive data', async () => {
    const { prospect, recommended } = await qualifiedProspect();
    await agent.post(`${P(prospect.id)}/review`).send({ reviewNotes: 'start' });
    await agent.patch(`${P(prospect.id)}/review`).send({ expectedVersion: 1, decision: 'NEEDS_REVIEW' });
    await agent.post(`${P(prospect.id)}/approve`).send(approveBody(2, recommended[0], { reviewNotes: 'ok' }));
    const res = await agent.get(`${P(prospect.id)}/review`);
    const history = res.body.data.review.history;
    assert.deepEqual(
      history.map((h) => [h.action, h.previousDecision, h.newDecision]),
      [
        ['APPROVED', 'NEEDS_REVIEW', 'APPROVED'],
        ['NEEDS_REVIEW', 'PENDING', 'NEEDS_REVIEW'],
        ['CREATED', null, 'PENDING'],
      ],
    );
    for (const h of history) {
      assert.equal(h.reviewer.id, admin.id);
      assert.equal(h.reviewer.email, TEST_ADMIN.email);
      assert.ok(h.at);
    }
    assert.deepEqual(history[0].approvedServices, [recommended[0]]);
    assert.equal(history[0].notes, 'ok');
    const json = JSON.stringify(res.body);
    for (const secret of ['passwordHash', 'apiKey', 'lockedBy', 'prompt']) assert.ok(!json.includes(secret));
  });
});

describe('Review API: SalesLead integration', () => {
  it('does not touch the lead until approval, then only adds approved services', async () => {
    const { prospect, recommended } = await qualifiedProspect();
    const { lead } = await promoteProspect(prospect.id, admin._id);
    await SalesLead.updateOne({ _id: lead.id }, { $set: { potentialServices: ['Need to Know'], notes: 'Called once', status: 'CONTACTED' } });
    const before = await SalesLead.findById(lead.id).lean();

    await agent.post(`${P(prospect.id)}/review`).send({});
    await agent.patch(`${P(prospect.id)}/review`).send({
      expectedVersion: 1,
      serviceDecisions: [{ serviceId: recommended[0], decision: 'APPROVED' }],
      evidenceAcknowledged: true,
    });
    await agent.patch(`${P(prospect.id)}/review`).send({ expectedVersion: 2, decision: 'NEEDS_REVIEW' });
    assert.deepEqual(await SalesLead.findById(lead.id).lean(), before);

    const res = await agent.post(`${LEADS}/${lead.id}/review/approve`).send(approveBody(3, recommended[0]));
    assert.equal(res.status, 200);
    const afterLead = await SalesLead.findById(lead.id).lean();
    assert.deepEqual(afterLead.potentialServices, ['Need to Know', serviceName(recommended[0])]);
    assert.equal(afterLead.notes, 'Called once');
    assert.equal(afterLead.status, 'CONTACTED');
    assert.equal(afterLead.businessName, before.businessName);
    assert.deepEqual(res.body.data.review.leadUpdate.addedServices, [serviceName(recommended[0])]);
    assert.equal(res.body.data.review.history[0].action, 'LEAD_UPDATED');
    // Lead and prospect routes see the same review.
    const viaProspect = await agent.get(`${P(prospect.id)}/review`);
    assert.equal(viaProspect.body.data.review.id, res.body.data.review.id);
  });

  it('never creates a lead and never changes one on rejection', async () => {
    const { prospect, recommended } = await qualifiedProspect();
    await agent.post(`${P(prospect.id)}/approve`).send(approveBody(0, recommended[0]));
    assert.equal(await SalesLead.countDocuments(), 0);

    const other = await qualifiedProspect();
    const { lead } = await promoteProspect(other.prospect.id, admin._id);
    const before = await SalesLead.findById(lead.id).lean();
    await agent.post(`${P(other.prospect.id)}/reject`).send({
      expectedVersion: 0,
      serviceDecisions: [{ serviceId: other.recommended[0], decision: 'APPROVED' }],
    });
    assert.deepEqual(await SalesLead.findById(lead.id).lean(), before);
  });
});

describe('Review API: outreach preview', () => {
  it('shows approved services with their evidence and sends nothing', async () => {
    const { prospect, recommended, qualification } = await qualifiedProspect();
    await agent.post(`${P(prospect.id)}/approve`).send(
      approveBody(0, recommended[0], { reviewNotes: 'Owner is friendly', reviewerEditedNextAction: 'Visit the shop' }),
    );
    const versionBefore = (await ProspectReview.findOne()).version;

    const realFetch = globalThis.fetch;
    let outbound = 0;
    globalThis.fetch = async (...args) => {
      outbound += 1;
      return realFetch(...args);
    };
    let res;
    try {
      res = await agent.get(`${P(prospect.id)}/outreach-preview`);
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.equal(res.status, 200);
    assert.equal(outbound, 0);
    const data = res.body.data;
    assert.equal(data.readiness.status, 'OUTREACH_READY');
    assert.equal(data.business.name, 'Sunrise Bakery');
    assert.deepEqual(data.approvedServices.map((s) => s.serviceId), [recommended[0]]);
    const opp = qualification.opportunities.find((o) => o.serviceId === recommended[0]);
    assert.deepEqual(data.approvedServices[0].evidence.map((e) => e.id), opp.evidenceReferences);
    for (const e of data.approvedServices[0].evidence) {
      const stored = qualification.evidenceSnapshot.find((s) => s.id === e.id);
      assert.equal(e.evidence, stored.evidence);
    }
    assert.deepEqual(data.nextAction, { text: 'Visit the shop', source: 'REVIEWER' });
    assert.equal(data.summary.source, 'AI');
    assert.equal(data.reviewerNotes, 'Owner is friendly');
    assert.equal(data.draftMessage, null);
    assert.equal(data.sending.available, false);
    assert.equal((await ProspectReview.findOne()).version, versionBefore);
  });
});
