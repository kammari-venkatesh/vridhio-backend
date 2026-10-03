import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import mongoose from 'mongoose';
import request from 'supertest';
import app from '../src/app.js';
import { AdminUser } from '../src/models/adminUser.model.js';
import { Prospect } from '../src/models/prospect.model.js';
import { ProspectWebsiteAnalysis } from '../src/models/prospectWebsiteAnalysis.model.js';
import { SalesLead } from '../src/models/salesLead.model.js';
import { createLeadFinderWorker } from '../src/services/leadFinder/worker.js';
import { createWebsiteAnalysisWorker } from '../src/services/websiteAnalysis/worker.js';
import { createFakeWeb, createTestAnalyzer, fixture, html, redirect, text } from './helpers/fakeWeb.js';
import { clearDb, createTestAdmin, loginAgent, startTestDb, stopTestDb, TEST_ADMIN } from './helpers/testDb.js';

const LF = '/api/admin/lead-finder';
const LEADS = '/api/admin/leads';
const analyzePath = (id) => `${LF}/prospects/${id}/analyze`;
const analysisPath = (id) => `${LF}/prospects/${id}/analysis`;

const SITE = 'https://abc-dental.com/';
const defaultRoutes = () => ({
  [SITE]: html(fixture('complete.html')),
  'https://abc-dental.com/robots.txt': text('User-agent: *\nDisallow:\nSitemap: https://abc-dental.com/sitemap.xml'),
  'https://abc-dental.com/sitemap.xml': { status: 200, headers: { 'content-type': 'application/xml' }, body: '<urlset></urlset>' },
  'https://down-site.com/': { error: 'ECONNREFUSED' },
  'https://redirecting.com/': redirect('https://www.redirecting.com/welcome'),
  'https://www.redirecting.com/welcome': html(fixture('wordpress.html')),
});

let web;
let worker;
let agent;

const newProspect = (overrides = {}) =>
  Prospect.create({
    businessName: 'ABC Dental Clinic',
    category: 'Dentist',
    city: 'Pune',
    website: SITE,
    source: 'apify',
    sourceId: `place-${new mongoose.Types.ObjectId()}`,
    jobId: new mongoose.Types.ObjectId(),
    ...overrides,
  });

const runWorker = async () => {
  const outcomes = [];
  for (let result = await worker.runOnce(); result; result = await worker.runOnce()) outcomes.push(result.outcome);
  return outcomes;
};

before(startTestDb);
after(stopTestDb);
beforeEach(async () => {
  await clearDb();
  await createTestAdmin();
  web = createFakeWeb(defaultRoutes());
  worker = createWebsiteAnalysisWorker({ analyzer: createTestAnalyzer(web), logger: { error() {} } });
  ({ agent } = await loginAgent(app));
});

describe('Website analysis API: access and validation', () => {
  it('requires an authenticated admin for every endpoint', async () => {
    const prospect = await newProspect();
    const id = prospect.id;
    const anon = request(app);
    for (const res of [
      await anon.post(analyzePath(id)),
      await anon.post(`${analyzePath(id)}/refresh`),
      await anon.get(analysisPath(id)),
      await anon.get(`${LF}/website-analysis/jobs/${id}`),
      await anon.post(`${LEADS}/analyze/bulk`).send({ ids: [id] }),
      await anon.get(`${LEADS}/analysis-status?ids=${id}`),
    ]) {
      assert.equal(res.status, 401);
    }
    await AdminUser.collection.updateOne({ email: TEST_ADMIN.email }, { $set: { role: 'viewer' } });
    assert.equal((await agent.post(analyzePath(id))).status, 403);
    assert.equal(await ProspectWebsiteAnalysis.countDocuments(), 0);
    assert.equal(web.requests.length, 0);
  });

  it('validates IDs and request bodies', async () => {
    const prospect = await newProspect();
    assert.equal((await agent.post(analyzePath('not-an-id'))).status, 404);
    assert.equal((await agent.post(analyzePath(new mongoose.Types.ObjectId().toString()))).status, 404);
    const badRefresh = await agent.post(analyzePath(prospect.id)).send({ refresh: 'yes' });
    assert.equal(badRefresh.status, 400);
    assert.equal(badRefresh.body.details.refresh, 'refresh must be true or false.');
    assert.equal((await agent.post(analyzePath(prospect.id)).send({ url: 'http://127.0.0.1' })).status, 400);
    const tooMany = Array.from({ length: 26 }, () => new mongoose.Types.ObjectId().toString());
    assert.equal((await agent.post(`${LEADS}/analyze/bulk`).send({ ids: tooMany })).status, 400);
    assert.equal((await agent.post(`${LEADS}/analyze/bulk`).send({ ids: ['x'] })).status, 400);
    assert.equal((await agent.get(`${LEADS}/analysis-status`)).status, 400);
    assert.equal(await ProspectWebsiteAnalysis.countDocuments(), 0);
  });
});

describe('Website analysis API: lifecycle', () => {
  it('reports NOT_ANALYZED before any analysis and never fetches on read', async () => {
    const prospect = await newProspect();
    const res = await agent.get(analysisPath(prospect.id));
    assert.equal(res.status, 200);
    assert.equal(res.body.data.status, 'NOT_ANALYZED');
    assert.equal(res.body.data.website.hasWebsite, true);
    assert.equal(res.body.data.website.websiteSource, 'APIFY');
    assert.equal(web.requests.length, 0);
  });

  it('queues an analysis (202) and the worker completes it with factual evidence', async () => {
    const prospect = await newProspect();
    const queued = await agent.post(analyzePath(prospect.id));
    assert.equal(queued.status, 202);
    assert.equal(queued.body.data.outcome, 'queued');
    assert.equal(queued.body.data.analysis.status, 'QUEUED');
    assert.equal(web.requests.length, 0, 'the HTTP request does not wait for the website');

    assert.deepEqual(await runWorker(), ['COMPLETED']);
    const res = await agent.get(analysisPath(prospect.id));
    const a = res.body.data;
    assert.equal(a.status, 'COMPLETED');
    assert.equal(a.website.websiteUrl, SITE);
    assert.equal(a.availability.reachable, true);
    assert.equal(a.availability.httpStatus, 200);
    assert.equal(a.availability.https, true);
    assert.equal(a.page.title, 'ABC Dental Clinic | Family Dentist in Pune');
    assert.equal(a.robots.robotsTxtExists, true);
    assert.equal(a.sitemap.sitemapExists, true);
    assert.deepEqual(a.structuredData.jsonLdTypes, ['Dentist']);
    assert.equal(a.mobile.viewportStatus, 'viewport_present');
    assert.ok(a.analyzedAt && a.completedAt);
    assert.equal(a.attemptCount, 1);
    assert.ok(a.evidence.length > 0);
    for (const hidden of ['lockedBy', 'heartbeatAt', 'requestedBy', 'subjectKey']) assert.equal(hidden in a, false, hidden);
    assert.doesNotMatch(JSON.stringify(res.body), /<html|<script|score/i);

    const job = await agent.get(`${LF}/website-analysis/jobs/${a.jobId}`);
    assert.equal(job.body.data.status, 'COMPLETED');
  });

  it('returns the existing analysis instead of fetching the website again', async () => {
    const prospect = await newProspect();
    await agent.post(analyzePath(prospect.id));
    const second = await agent.post(analyzePath(prospect.id));
    assert.equal(second.status, 200);
    assert.equal(second.body.data.outcome, 'in_progress');
    await runWorker();
    const requestsAfterFirst = web.requests.length;

    const again = await agent.post(analyzePath(prospect.id));
    assert.equal(again.status, 200);
    assert.equal(again.body.data.outcome, 'reused');
    assert.equal(again.body.data.analysis.status, 'COMPLETED');
    assert.deepEqual(await runWorker(), []);
    assert.equal(web.requests.length, requestsAfterFirst);
    assert.equal(await ProspectWebsiteAnalysis.countDocuments(), 1);
  });

  it('fetches the website again when the stored analysis came from an older analyzer', async () => {
    const prospect = await newProspect();
    await agent.post(analyzePath(prospect.id));
    await runWorker();
    await ProspectWebsiteAnalysis.updateOne({}, { $set: { analyzerVersion: 1 } });

    const again = await agent.post(analyzePath(prospect.id));
    assert.equal(again.body.data.outcome, 'queued');
    assert.deepEqual(await runWorker(), ['COMPLETED']);
    assert.equal((await ProspectWebsiteAnalysis.findOne()).analyzerVersion, 2);
  });

  it('creates only one analysis for simultaneous requests', async () => {
    const prospect = await newProspect();
    const responses = await Promise.all(Array.from({ length: 5 }, () => agent.post(analyzePath(prospect.id))));
    assert.equal(responses.filter((r) => r.body.data.outcome === 'queued').length, 1);
    assert.equal(await ProspectWebsiteAnalysis.countDocuments(), 1);
    assert.deepEqual(await runWorker(), ['COMPLETED']);
  });

  it('refreshes only explicitly, and not within the refresh cooldown', async () => {
    const prospect = await newProspect();
    await agent.post(analyzePath(prospect.id));
    await runWorker();

    const tooSoon = await agent.post(`${analyzePath(prospect.id)}/refresh`);
    assert.equal(tooSoon.status, 429);
    assert.match(tooSoon.body.message, /checked less than 5 minutes ago/);

    await ProspectWebsiteAnalysis.updateOne({}, { $set: { lastAttemptAt: new Date(Date.now() - 10 * 60 * 1000) } });
    web = createFakeWeb({ ...defaultRoutes(), [SITE]: html('<title>ABC Dental — new site</title>') });
    worker = createWebsiteAnalysisWorker({ analyzer: createTestAnalyzer(web), logger: { error() {} } });

    const refreshed = await agent.post(`${analyzePath(prospect.id)}/refresh`);
    assert.equal(refreshed.status, 202);
    assert.equal(refreshed.body.data.analysis.status, 'QUEUED');
    assert.equal(refreshed.body.data.analysis.page.title, 'ABC Dental Clinic | Family Dentist in Pune', 'old facts stay visible while queued');
    await runWorker();
    const updated = (await agent.get(analysisPath(prospect.id))).body.data;
    assert.equal(updated.page.title, 'ABC Dental — new site');
    assert.equal(updated.attemptCount, 2);
    assert.equal(updated.structuredData.hasJsonLd, false, 'facts from the earlier run are replaced');
    assert.equal(await ProspectWebsiteAnalysis.countDocuments(), 1);
  });

  it('stores a failed analysis safely and does not retry it automatically', async () => {
    const prospect = await newProspect({ website: 'https://down-site.com' });
    await agent.post(analyzePath(prospect.id));
    assert.deepEqual(await runWorker(), ['FAILED']);
    const res = await agent.get(analysisPath(prospect.id));
    const a = res.body.data;
    assert.equal(a.status, 'FAILED');
    assert.equal(a.errorCode, 'CONNECTION_ERROR');
    assert.equal(a.availability.reachable, false);
    assert.equal(a.availability.attempts, 2);
    assert.equal(a.availability.https, null, 'an unanswered request says nothing about HTTPS');
    assert.equal(a.evidence[0].type, 'WEBSITE_UNREACHABLE');
    const body = JSON.stringify(res.body);
    assert.doesNotMatch(body, /stack|ECONNREFUSED|93\.184\.216\.34|Error:/);

    const requests = web.requests.length;
    const again = await agent.post(analyzePath(prospect.id));
    assert.equal(again.body.data.outcome, 'reused');
    assert.deepEqual(await runWorker(), []);
    assert.equal(web.requests.length, requests);
    assert.equal((await Prospect.findById(prospect.id)).website, 'https://down-site.com', 'failure never touches the prospect');
  });

  it('skips a business without a website immediately, without any request', async () => {
    const prospect = await newProspect({ website: null });
    const res = await agent.post(analyzePath(prospect.id));
    assert.equal(res.status, 200);
    assert.equal(res.body.data.outcome, 'completed');
    assert.equal(res.body.data.analysis.status, 'SKIPPED');
    assert.equal(res.body.data.analysis.errorCode, 'NO_WEBSITE');
    assert.equal(res.body.data.analysis.website.hasWebsite, false);
    assert.equal(res.body.data.analysis.evidence[0].type, 'NO_WEBSITE');
    assert.deepEqual(await runWorker(), []);
    assert.equal(web.requests.length + web.lookups.length, 0);
  });

  it('refuses a stored website that points at an internal address without resolving or fetching it', async () => {
    for (const website of ['http://169.254.169.254/latest/meta-data/', 'http://localhost:8000/api', 'http://10.0.0.5']) {
      const prospect = await newProspect({ website });
      const res = await agent.post(analyzePath(prospect.id));
      assert.equal(res.status, 200, website);
      assert.equal(res.body.data.analysis.status, 'FAILED');
      assert.equal(res.body.data.analysis.errorCode, 'UNSAFE_URL');
      assert.doesNotMatch(res.body.data.analysis.errorMessage, /169\.254|localhost|10\.0/);
    }
    assert.deepEqual(await runWorker(), []);
    assert.equal(web.requests.length + web.lookups.length, 0);
  });

  it('keeps the discovered website and records where it redirected', async () => {
    const prospect = await newProspect({ website: 'redirecting.com' });
    await agent.post(analyzePath(prospect.id));
    await runWorker();
    const a = (await agent.get(analysisPath(prospect.id))).body.data;
    assert.equal(a.website.websiteUrl, 'redirecting.com');
    assert.equal(a.website.normalizedWebsiteUrl, 'https://redirecting.com/');
    assert.equal(a.availability.finalUrl, 'https://www.redirecting.com/welcome');
    assert.equal(a.availability.redirectCount, 1);
    assert.equal(a.technologies.find((t) => t.name === 'WordPress').confidence, 'HIGH');
    assert.equal((await Prospect.findById(prospect.id)).website, 'redirecting.com');
  });

  it('cancels queued analyses and refuses to cancel finished ones', async () => {
    const prospect = await newProspect();
    const { jobId } = (await agent.post(analyzePath(prospect.id))).body.data;
    const cancelled = await agent.post(`${LF}/website-analysis/jobs/${jobId}/cancel`);
    assert.equal(cancelled.body.data.status, 'CANCELLED');
    assert.deepEqual(await runWorker(), []);
    assert.equal(web.requests.length, 0);
    assert.equal((await agent.post(`${LF}/website-analysis/jobs/${jobId}/cancel`)).status, 409);
    assert.equal((await agent.get(`${LF}/website-analysis/jobs/${jobId}`)).body.data.status, 'CANCELLED');
  });

  it('rejects new analyses when the queue is full', async () => {
    const prospect = await newProspect();
    await ProspectWebsiteAnalysis.insertMany(
      Array.from({ length: 200 }, (_, i) => ({ subjectKey: `lead:filler-${i}`, status: 'QUEUED', queuedAt: new Date() })),
    );
    const res = await agent.post(analyzePath(prospect.id));
    assert.equal(res.status, 429);
    assert.match(res.body.message, /queue is full/);
  });
});

describe('Website analysis worker', () => {
  it('discards the result of an analysis cancelled while it ran', async () => {
    const prospect = await newProspect();
    await agent.post(analyzePath(prospect.id));
    const analyzer = {
      analyze: async (target, options) => {
        await ProspectWebsiteAnalysis.updateOne({}, { $set: { status: 'CANCELLED' } });
        return createTestAnalyzer(web).analyze(target, options);
      },
    };
    const cancelling = createWebsiteAnalysisWorker({ analyzer, logger: { error() {} } });
    assert.equal((await cancelling.runOnce()).outcome, 'CANCELLED');
    const doc = await ProspectWebsiteAnalysis.findOne();
    assert.equal(doc.status, 'CANCELLED');
    assert.equal(doc.page.title, null);
  });

  it('marks analyses abandoned by a crashed worker as INTERRUPTED', async () => {
    await ProspectWebsiteAnalysis.create({
      subjectKey: 'lead:abandoned',
      status: 'ANALYZING',
      lockedBy: 'dead-worker',
      heartbeatAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    await worker.recoverStale();
    const doc = await ProspectWebsiteAnalysis.findOne({ subjectKey: 'lead:abandoned' });
    assert.equal(doc.status, 'FAILED');
    assert.equal(doc.errorCode, 'INTERRUPTED');
  });

  it('stores an unexpected analyzer crash as a generic failure', async () => {
    const prospect = await newProspect();
    await agent.post(analyzePath(prospect.id));
    const crashing = createWebsiteAnalysisWorker({
      analyzer: { analyze: async () => { throw new Error('boom at /internal/path'); } },
      logger: { error() {} },
    });
    assert.equal((await crashing.runOnce()).outcome, 'FAILED');
    const a = (await agent.get(analysisPath(prospect.id))).body.data;
    assert.equal(a.errorCode, 'ANALYSIS_ERROR');
    assert.doesNotMatch(JSON.stringify(a), /boom|internal\/path/);
  });

  it('is queued for every business Lead Finder saves when automatic analysis is on', async () => {
    const job = await agent.post(`${LF}/jobs`).send({ location: 'Pune', radius: 5, categories: ['Gyms'], maxBusinesses: 5 });
    assert.equal(job.status, 202);
    const discovery = createLeadFinderWorker({ analyzeWebsites: true, logger: { error() {} } });
    assert.equal((await discovery.runOnce()).outcome, 'completed');
    const prospects = await Prospect.find().lean();
    assert.ok(prospects.length > 0);
    assert.equal(await ProspectWebsiteAnalysis.countDocuments(), prospects.length, 'one analysis per business');
    const withSite = prospects.filter((p) => p.website).length;
    assert.equal(await ProspectWebsiteAnalysis.countDocuments({ status: 'QUEUED' }), withSite);
    assert.equal(await ProspectWebsiteAnalysis.countDocuments({ status: 'SKIPPED' }), prospects.length - withSite);
    assert.equal(web.requests.length, 0, 'discovery only queues; the analysis worker fetches');

    const listed = await agent.get(`${LF}/jobs/${job.body.data.jobId}/prospects`);
    assert.ok(listed.body.data.items.every((p) => p.websiteAnalysis !== null));
  });

  it('is not queued by Lead Finder when automatic analysis is off', async () => {
    await agent.post(`${LF}/jobs`).send({ location: 'Pune', radius: 5, categories: ['Gyms'], maxBusinesses: 5 });
    const discovery = createLeadFinderWorker({ analyzeWebsites: false, logger: { error() {} } });
    assert.equal((await discovery.runOnce()).outcome, 'completed');
    assert.ok((await Prospect.countDocuments()) > 0);
    assert.equal(await ProspectWebsiteAnalysis.countDocuments(), 0);
  });
});

describe('Website analysis in the Lead Workspace', () => {
  it('shares one analysis between a prospect and the sales lead made from it', async () => {
    const prospect = await newProspect();
    const promoted = await agent.post(`${LF}/prospects/${prospect.id}/promote`);
    const leadId = promoted.body.data.lead.id;

    const queued = await agent.post(`${LEADS}/${leadId}/analyze`);
    assert.equal(queued.status, 202);
    await runWorker();
    const viaLead = (await agent.get(`${LEADS}/${leadId}/analysis`)).body.data;
    const viaProspect = (await agent.get(analysisPath(prospect.id))).body.data;
    assert.equal(viaLead.id, viaProspect.id);
    assert.equal(viaLead.salesLeadId, leadId);
    assert.equal(viaLead.prospectId, prospect.id);

    const list = await agent.get(LEADS);
    assert.equal(list.body.data[0].websiteAnalysis.status, 'COMPLETED');
    assert.equal(list.body.data[0].websiteAnalysis.httpStatus, 200);
    const detail = await agent.get(`${LEADS}/${leadId}`);
    assert.equal(detail.body.data.websiteAnalysis.status, 'COMPLETED');
  });

  it('analyses a manually added lead and flags a website changed after analysis', async () => {
    const lead = await SalesLead.create({ businessName: 'Redirect Co', website: 'redirecting.com', source: 'MANUAL' });
    await agent.post(`${LEADS}/${lead.id}/analyze`);
    await runWorker();
    const first = (await agent.get(`${LEADS}/${lead.id}/analysis`)).body.data;
    assert.equal(first.status, 'COMPLETED');
    assert.equal(first.website.websiteSource, 'MANUAL');
    assert.equal(first.websiteChanged, false);
    assert.equal((await SalesLead.findById(lead.id)).website, 'redirecting.com', 'the lead keeps its website');

    await agent.patch(`${LEADS}/${lead.id}`).send({ website: 'https://abc-dental.com' });
    const stale = (await agent.get(`${LEADS}/${lead.id}/analysis`)).body.data;
    assert.equal(stale.websiteChanged, true);
    const list = await agent.get(LEADS);
    assert.equal(list.body.data[0].websiteAnalysis.websiteChanged, true);

    // A different website is a new analysis even within the freshness window.
    const requeued = await agent.post(`${LEADS}/${lead.id}/analyze`);
    assert.equal(requeued.body.data.outcome, 'queued');
    await runWorker();
    const fresh = (await agent.get(`${LEADS}/${lead.id}/analysis`)).body.data;
    assert.equal(fresh.page.title, 'ABC Dental Clinic | Family Dentist in Pune');
    assert.equal(fresh.websiteChanged, false);
  });

  it('queues analyses for several leads in one request and reports their statuses', async () => {
    const withSite = await SalesLead.create({ businessName: 'ABC Dental', website: SITE });
    const other = await SalesLead.create({ businessName: 'Redirect Co', website: 'https://redirecting.com' });
    const none = await SalesLead.create({ businessName: 'No Site Bakery' });
    const missing = new mongoose.Types.ObjectId().toString();

    const res = await agent.post(`${LEADS}/analyze/bulk`).send({ ids: [withSite.id, other.id, none.id, missing] });
    assert.equal(res.status, 200);
    assert.deepEqual([res.body.data.queued, res.body.data.completed, res.body.data.rejected], [2, 1, 1]);
    assert.equal(res.body.data.results.find((r) => r.leadId === missing).outcome, 'not_found');

    const before = await agent.get(`${LEADS}/analysis-status?ids=${withSite.id},${none.id}`);
    assert.equal(before.body.data[withSite.id].status, 'QUEUED');
    assert.equal(before.body.data[none.id].status, 'SKIPPED');
    await runWorker();
    const afterRun = await agent.get(`${LEADS}/analysis-status?ids=${withSite.id},${other.id}`);
    assert.equal(afterRun.body.data[withSite.id].status, 'COMPLETED');
    assert.equal(afterRun.body.data[other.id].status, 'COMPLETED');
  });

  it('limits bulk analysis requests per admin', async () => {
    const lead = await SalesLead.create({ businessName: 'No Site Bakery' });
    let limited = null;
    for (let i = 0; i < 12 && !limited; i++) {
      const res = await agent.post(`${LEADS}/analyze/bulk`).send({ ids: [lead.id] });
      if (res.status === 429) limited = res;
    }
    assert.ok(limited, 'bulk requests are rate limited');
    assert.match(limited.body.message, /Too many bulk website analysis requests/);
  });
});
