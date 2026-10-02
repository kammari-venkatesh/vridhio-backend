import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import app from '../src/app.js';
import { budgetUsd, leadFinderConfig } from '../src/config/leadFinder.js';
import { readApifyConfig } from '../src/config/apify.js';
import { LeadFinderJob } from '../src/models/leadFinderJob.model.js';
import { Prospect } from '../src/models/prospect.model.js';
import {
  checkBudget,
  costPerNewProspectMicroUsd,
  DAILY_BUDGET_MESSAGE,
  getSpendSummary,
  MONTHLY_BUDGET_MESSAGE,
  toMicroUsd,
} from '../src/services/leadFinder/cost.service.js';
import { createGeocoder, GeocodingError } from '../src/services/leadFinder/geocoding.service.js';
import { createJob, getJob } from '../src/services/leadFinder/leadFinderJob.service.js';
import { createLeadFinderWorker, filterByRadius } from '../src/services/leadFinder/worker.js';
import { haversineKm, isValidCoordinate, parseCoordinatePair } from '../src/utils/geo.js';
import { clearDb, createTestAdmin, loginAgent, startTestDb, stopTestDb } from './helpers/testDb.js';
import { mockApify, placeItem, testApifyProvider } from './helpers/mockApify.js';

const silent = { error() {}, warn() {}, info() {} };
const CENTER = { latitude: 17.385, longitude: 78.4867 }; // central Hyderabad
const fixedCenter = async () => ({ ...CENTER, label: 'Hyderabad, Telangana, India', source: 'geocoded' });
const PARAMS = { location: 'Hyderabad', radius: 5, categories: ['Gyms'], maxBusinesses: 10 };

// Places at known offsets from CENTER: 0.01° latitude ≈ 1.11 km.
const near = (n) => placeItem(n, { location: { lat: CENTER.latitude + 0.01, lng: CENTER.longitude } });
const far = (n) => placeItem(n, { location: { lat: CENTER.latitude + 0.2, lng: CENTER.longitude } }); // ≈ 22 km

let admin;
const savedBudget = { ...leadFinderConfig.budget };

const workerWith = (provider, options = {}) =>
  createLeadFinderWorker({ resolveProvider: () => provider, providers: ['fake', 'apify'], logger: silent, ...options });

const createLiveJob = (provider, params = PARAMS, geocode = fixedCenter) =>
  createJob(params, admin._id, { provider: 'apify', apifyEnabled: true, resolveProvider: () => provider, geocode });

const settled = (totalMicroUsd) => ({ totalMicroUsd, retrievedAt: new Date(), settledAt: new Date() });

/** Inserts job documents as stored, bypassing timestamps so createdAt can be set. */
const insertJobs = (jobs) =>
  LeadFinderJob.collection.insertMany(
    jobs.map((job) => ({
      status: 'completed',
      provider: 'apify',
      params: PARAMS,
      createdBy: admin._id,
      costCapMicroUsd: 1_000_000,
      usage: { totalMicroUsd: null, retrievedAt: null },
      providerRun: { runId: null, datasetId: null },
      ...job,
    })),
  );

before(startTestDb);
after(stopTestDb);
beforeEach(async () => {
  await clearDb();
  admin = await createTestAdmin();
});
afterEach(() => {
  Object.assign(leadFinderConfig.budget, savedBudget);
});

describe('geo: Haversine distance', () => {
  it('matches known distances', () => {
    assert.ok(Math.abs(haversineKm(0, 0, 0, 1) - 111.195) < 0.001, 'one degree of longitude at the equator');
    // Charminar to Secunderabad railway station, ≈ 8.5 km in a straight line
    const d = haversineKm(17.3616, 78.4747, 17.4337, 78.5016);
    assert.ok(d > 8.3 && d < 8.7, `got ${d}`);
  });

  it('returns 0 for the same point', () => {
    assert.equal(haversineKm(17.385, 78.4867, 17.385, 78.4867), 0);
  });

  it('returns null, never a distance, for missing or invalid coordinates', () => {
    for (const args of [
      [null, 78.4, 17.4, 78.4],
      [undefined, undefined, 17.4, 78.4],
      [17.4, 78.4, NaN, 78.4],
      [17.4, 78.4, 91, 78.4],
      [17.4, 78.4, 17.4, -181],
      ['17.4', 78.4, 17.4, 78.4],
      [17.4, 78.4, Infinity, 0],
    ]) {
      assert.equal(haversineKm(...args), null, JSON.stringify(args));
    }
    assert.equal(isValidCoordinate(0, 0), true, '0,0 is a real place when given explicitly');
    assert.equal(isValidCoordinate(null, null), false);
  });

  it('parses "lat, lng" coordinates and rejects anything else', () => {
    assert.deepEqual(parseCoordinatePair(' 17.385, 78.4867 '), { latitude: 17.385, longitude: 78.4867 });
    assert.deepEqual(parseCoordinatePair('-33.9,18.4'), { latitude: -33.9, longitude: 18.4 });
    for (const text of ['Hyderabad', '17.385', '95, 78', '17, 190', '17.3 78.4', '', null]) {
      assert.equal(parseCoordinatePair(text), null, String(text));
    }
  });
});

describe('radius filtering', () => {
  const business = (latitude, longitude, id = 'x') => ({ sourceId: id, latitude, longitude });

  it('keeps businesses inside or exactly on the radius and excludes those outside', () => {
    const onBoundary = business(0, 1, 'edge');
    const radius = haversineKm(0, 0, 0, 1);
    const { kept, outsideRadius, missingCoordinates } = filterByRadius(
      [business(0, 0.5, 'in'), onBoundary, business(0, 1.01, 'out')],
      { latitude: 0, longitude: 0 },
      radius,
    );
    assert.deepEqual(kept.map((b) => b.sourceId), ['in', 'edge']);
    assert.equal(outsideRadius, 1);
    assert.equal(missingCoordinates, 0);
  });

  it('counts missing or invalid coordinates separately and never treats them as 0,0', () => {
    const { kept, outsideRadius, missingCoordinates } = filterByRadius(
      [business(null, null), business(undefined, 0), business(95, 0), business(0, 0, 'origin')],
      { latitude: 0, longitude: 0 },
      1,
    );
    assert.deepEqual(kept.map((b) => b.sourceId), ['origin']);
    assert.equal(missingCoordinates, 3);
    assert.equal(outsideRadius, 0);
  });
});

describe('live discovery with radius enforcement (mocked Apify)', () => {
  it('sends a custom search circle, filters by distance before saving, and starts one run only', async () => {
    const items = [
      near(1),
      near(2),
      far(3),
      placeItem(4, { location: null }), // no coordinates
      placeItem(5, { location: { lat: CENTER.latitude, lng: CENTER.longitude }, permanentlyClosed: true }),
      placeItem(6, { location: { lat: CENTER.latitude, lng: CENTER.longitude }, temporarilyClosed: true }),
      { title: 'malformed' },
    ];
    const mock = mockApify({ items, usageTotalUsd: 0.0252 });
    const provider = testApifyProvider({ mock });
    const job = await createLiveJob(provider);

    const result = await workerWith(provider).runOnce();
    assert.equal(result.outcome, 'completed');
    assert.equal(mock.calls.start.length, 1, 'never starts a second paid run to make up for filtered places');

    const { input } = mock.calls.start[0];
    assert.deepEqual(input.customGeolocation, {
      type: 'Point',
      coordinates: [CENTER.longitude, CENTER.latitude],
      radiusKm: 5,
    });
    assert.equal('locationQuery' in input, false, 'locationQuery would override the custom area');

    const stored = await LeadFinderJob.findById(job.id).lean();
    assert.deepEqual(stored.progress, {
      total: 7,
      invalid: 1,
      closed: 1,
      outsideRadius: 1,
      missingCoordinates: 1,
      discovered: 3,
      processed: 3,
      newProspects: 3,
      qualified: 0,
    });
    const saved = (await Prospect.find().lean()).map((p) => p.sourceId).sort();
    assert.deepEqual(saved, ['ChIJtestPlace1', 'ChIJtestPlace2', 'ChIJtestPlace6'], 'temporarily closed places stay');
    assert.ok((await Prospect.find().lean()).every((p) => !('permanentlyClosed' in p)));
  });

  it('completes with fewer prospects when few places fall inside the radius', async () => {
    const mock = mockApify({ items: [near(1), far(2), far(3)] });
    const provider = testApifyProvider({ mock });
    const job = await createLiveJob(provider);

    await workerWith(provider).runOnce();
    const dto = await getJob(job.id);
    assert.equal(dto.status, 'completed');
    assert.equal(dto.progress.discovered, 1);
    assert.equal(dto.progress.outsideRadius, 2);
    assert.equal(mock.calls.start.length, 1);
  });

  it('exposes the search area and mode in the job, without run IDs or internals', async () => {
    const mock = mockApify({ items: [near(1)], usageTotalUsd: 0.0252 });
    const provider = testApifyProvider({ mock });
    const job = await createLiveJob(provider);
    await workerWith(provider).runOnce();

    const dto = await getJob(job.id);
    assert.equal(dto.providerMode, 'live');
    assert.deepEqual(dto.searchArea, {
      label: 'Hyderabad, Telangana, India',
      latitude: CENTER.latitude,
      longitude: CENTER.longitude,
      radiusEnforced: true,
    });
    assert.doesNotMatch(JSON.stringify(dto), /run-test-1|dataset-test-1|providerRun|costCap|MicroUsd|usage/);
  });

  it('does not geocode or enforce a radius for test-data searches', async () => {
    let geocoded = 0;
    const job = await createJob(PARAMS, admin._id, { geocode: async () => (geocoded += 1) });
    assert.equal(geocoded, 0);
    assert.equal(job.providerMode, 'test');
    assert.equal(job.searchArea.radiusEnforced, false);
  });

  it('rejects a live search whose location cannot be resolved, without queuing it', async () => {
    const mock = mockApify();
    const provider = testApifyProvider({ mock });
    for (const [code, status] of [
      ['NOT_FOUND', 400],
      ['UNAVAILABLE', 503],
    ]) {
      await assert.rejects(
        createLiveJob(provider, PARAMS, async () => {
          throw new GeocodingError(code);
        }),
        (err) => err.statusCode === status && /coordinates/.test(err.message),
      );
    }
    assert.equal(await LeadFinderJob.countDocuments(), 0);
    assert.equal(mock.calls.start.length, 0);
  });
});

describe('geocoding', () => {
  const config = {
    enabled: true,
    url: 'https://geocoder.test/search',
    userAgent: 'VridhioLeadFinder/test',
    timeoutMs: 1000,
    minIntervalMs: 0,
    cacheTtlMs: 60_000,
  };
  const fakeFetch = (body, { ok = true } = {}) => {
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push({ url: String(url), options });
      return { ok, json: async () => body };
    };
    return { calls, fetchImpl };
  };

  it('uses typed coordinates directly without a network request', async () => {
    const { calls, fetchImpl } = fakeFetch([]);
    const center = await createGeocoder({ config: { ...config, enabled: false }, fetchImpl })('17.385, 78.4867');
    assert.deepEqual(center, { latitude: 17.385, longitude: 78.4867, label: '17.385, 78.4867', source: 'coordinates' });
    assert.equal(calls.length, 0);
  });

  it('looks up a place name once, identifies itself, and caches the result', async () => {
    const { calls, fetchImpl } = fakeFetch([{ lat: '17.3850', lon: '78.4867', display_name: 'Hyderabad, India' }]);
    const geocode = createGeocoder({ config, fetchImpl });
    const first = await geocode('Hyderabad');
    const second = await geocode('  hyderabad ');
    assert.deepEqual(first, { latitude: 17.385, longitude: 78.4867, label: 'Hyderabad, India', source: 'geocoded' });
    assert.deepEqual(second, first);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /q=Hyderabad/);
    assert.equal(calls[0].options.headers['User-Agent'], 'VridhioLeadFinder/test');
  });

  it('reports not found and unavailable separately, never inventing coordinates', async () => {
    const notFound = createGeocoder({ config, fetchImpl: fakeFetch([]).fetchImpl });
    await assert.rejects(notFound('Nowhere'), (err) => err.code === 'NOT_FOUND');

    const badCoords = createGeocoder({ config, fetchImpl: fakeFetch([{ lat: 'abc', lon: '200' }]).fetchImpl });
    await assert.rejects(badCoords('Somewhere'), (err) => err.code === 'NOT_FOUND');

    const httpError = createGeocoder({ config, fetchImpl: fakeFetch([], { ok: false }).fetchImpl });
    await assert.rejects(httpError('Hyderabad'), (err) => err.code === 'UNAVAILABLE');

    const offline = createGeocoder({
      config,
      fetchImpl: async () => {
        throw new Error('network down');
      },
    });
    await assert.rejects(offline('Hyderabad'), (err) => err.code === 'UNAVAILABLE');

    const disabled = createGeocoder({ config: { ...config, enabled: false }, fetchImpl: fakeFetch([]).fetchImpl });
    await assert.rejects(disabled('Hyderabad'), (err) => err.code === 'UNAVAILABLE');
  });
});

describe('cost tracking', () => {
  const settling = (provider, options = {}) => workerWith(provider, { costSettleDelayMs: 0, ...options });

  it('treats the cost reported as the run ends as provisional and records the settled cost', async () => {
    // Mirrors the real run: per-place charges appeared only after the run had finished.
    let finished = false;
    const mock = mockApify({
      items: [1, 2, 3, 4, 5].map(near),
      usageTotalUsd: () => (finished ? 0.0252 : 0.0002),
      onListItems: async () => {
        finished = true;
      },
    });
    const provider = testApifyProvider({ mock });
    const job = await createLiveJob(provider);
    const worker = settling(provider);
    await worker.runOnce();

    let stored = await LeadFinderJob.findById(job.id).lean();
    assert.equal(stored.usage.totalMicroUsd, 200, 'provisional value from the end of the run');
    assert.equal(stored.usage.settledAt, null);
    assert.equal((await getJob(job.id)).cost.status, 'pending', 'a provisional cost is never shown as final');
    const provisional = await getSpendSummary();
    assert.equal(provisional.today.spentUsd, 0);
    assert.equal(provisional.today.reservedUsd, 0.5, 'the full cap stays reserved until the cost settles');

    assert.equal(await worker.settleCostsOnce(), job.id);
    stored = await LeadFinderJob.findById(job.id).lean();
    assert.equal(stored.usage.totalMicroUsd, 25_200);
    assert.ok(stored.usage.settledAt instanceof Date);
    assert.deepEqual((await getJob(job.id)).cost, { status: 'recorded', totalUsd: 0.0252, perNewProspectUsd: 0.00504 });
    const settled = await getSpendSummary();
    assert.equal(settled.today.spentUsd, 0.0252);
    assert.equal(settled.today.reservedUsd, 0);
    assert.equal(await worker.settleCostsOnce(), null, 'nothing left to settle');
  });

  it('waits before settling so late charges are included', async () => {
    const mock = mockApify({ items: [near(1)], usageTotalUsd: 0.0042 });
    const provider = testApifyProvider({ mock });
    await createLiveJob(provider);
    const worker = settling(provider, { costSettleDelayMs: 60_000 });
    await worker.runOnce();
    assert.equal(await worker.settleCostsOnce(), null);
  });

  it('keeps the cost unknown (null, not zero) when Apify never reports it', async () => {
    const mock = mockApify({ items: [near(1)] });
    const provider = testApifyProvider({ mock });
    const job = await createLiveJob(provider);
    const worker = settling(provider, { maxCostSettleAttempts: 3 });
    await worker.runOnce();

    for (let i = 0; i < 3; i += 1) await worker.settleCostsOnce();
    const stored = await LeadFinderJob.findById(job.id).lean();
    assert.equal(stored.usage.totalMicroUsd, null);
    assert.ok(stored.usage.settledAt instanceof Date);
    assert.deepEqual((await getJob(job.id)).cost, { status: 'unavailable', totalUsd: null, perNewProspectUsd: null });
    assert.equal((await getSpendSummary()).today.reservedUsd, 0.5, 'an unpriced run counts as its full cap');
  });

  it('records the cost of a run that failed after starting', async () => {
    const mock = mockApify({ statuses: ['FAILED'], usageTotalUsd: 0.004 });
    const provider = testApifyProvider({ mock });
    const job = await createLiveJob(provider);
    const worker = settling(provider);
    await worker.runOnce();
    await worker.settleCostsOnce();

    const dto = await getJob(job.id);
    assert.equal(dto.status, 'failed');
    assert.deepEqual(dto.cost, { status: 'recorded', totalUsd: 0.004, perNewProspectUsd: null });
  });

  it('computes cost per new prospect only when cost is known and something new was saved', () => {
    assert.equal(costPerNewProspectMicroUsd(25_200, 5), 5_040);
    assert.equal(costPerNewProspectMicroUsd(25_200, 0), null);
    assert.equal(costPerNewProspectMicroUsd(null, 5), null);
    assert.equal(toMicroUsd(0.0252), 25_200);
    assert.equal(toMicroUsd(-1), null);
    assert.equal(toMicroUsd(undefined), null);
  });

  it('aggregates spend per UTC day and month, reserving caps for active or unpriced runs', async () => {
    const now = new Date('2026-10-15T12:00:00Z');
    await insertJobs([
      { createdAt: new Date('2026-10-15T01:00:00Z'), usage: settled(25_200) }, // today, priced
      { createdAt: new Date('2026-10-15T02:00:00Z'), status: 'running' }, // today, active: cap reserved
      { createdAt: new Date('2026-10-15T03:00:00Z'), status: 'failed', providerRun: { runId: 'r' } }, // unpriced
      {
        createdAt: new Date('2026-10-15T03:30:00Z'),
        providerRun: { runId: 'r2' },
        usage: { totalMicroUsd: 200, settledAt: null }, // provisional: cap reserved
      },
      { createdAt: new Date('2026-10-15T04:00:00Z'), status: 'failed' }, // never started a run: free
      { createdAt: new Date('2026-10-15T05:00:00Z'), costCapMicroUsd: null }, // test-data job
      { createdAt: new Date('2026-10-14T23:59:59Z'), usage: settled(100_000) }, // yesterday
      { createdAt: new Date('2026-09-30T23:00:00Z'), usage: settled(999_999) }, // last month
    ]);

    const summary = await getSpendSummary({ now, budget: { dailyUsd: 5, monthlyUsd: 50 } });
    assert.deepEqual(summary, {
      timezone: 'UTC',
      today: { spentUsd: 0.0252, reservedUsd: 3, budgetUsd: 5 },
      month: { spentUsd: 0.1252, reservedUsd: 3, budgetUsd: 50 },
    });
  });
});

describe('discovery budgets', () => {
  const now = new Date('2026-10-15T12:00:00Z');

  it('rejects a run that would exceed the daily budget', async () => {
    await insertJobs([{ createdAt: new Date('2026-10-15T01:00:00Z'), usage: settled(4_500_000) }]);
    const budget = { dailyUsd: 5, monthlyUsd: null };
    assert.equal(await checkBudget({ capMicroUsd: 400_000, now, budget }), null);
    assert.equal(await checkBudget({ capMicroUsd: 600_000, now, budget }), DAILY_BUDGET_MESSAGE);
  });

  it('rejects a run that would exceed the monthly budget, independently of the daily one', async () => {
    await insertJobs([{ createdAt: new Date('2026-10-02T01:00:00Z'), usage: settled(9_800_000) }]);
    assert.equal(await checkBudget({ capMicroUsd: 1_000_000, now, budget: { dailyUsd: 5, monthlyUsd: null } }), null);
    assert.equal(
      await checkBudget({ capMicroUsd: 1_000_000, now, budget: { dailyUsd: 5, monthlyUsd: 10 } }),
      MONTHLY_BUDGET_MESSAGE,
    );
  });

  it('refuses to queue a live search once the daily budget is used, before any location lookup', async () => {
    leadFinderConfig.budget.dailyUsd = 0.4; // below the 0.5 cap per run
    const mock = mockApify();
    let geocoded = 0;
    await assert.rejects(
      createLiveJob(testApifyProvider({ mock }), PARAMS, async () => {
        geocoded += 1;
        return fixedCenter();
      }),
      (err) => err.statusCode === 429 && err.message === DAILY_BUDGET_MESSAGE,
    );
    assert.equal(geocoded, 0);
    assert.equal(await LeadFinderJob.countDocuments(), 0);
    assert.equal(mock.calls.start.length, 0);
  });

  it('re-checks the budget before starting a queued job and never starts the paid run', async () => {
    const mock = mockApify({ items: [near(1)] });
    const provider = testApifyProvider({ mock });
    const job = await createLiveJob(provider);
    leadFinderConfig.budget.dailyUsd = 0.1;

    const result = await workerWith(provider).runOnce();
    assert.equal(result.outcome, 'failed');
    const dto = await getJob(job.id);
    assert.equal(dto.error, DAILY_BUDGET_MESSAGE);
    assert.equal(dto.cost.status, 'none');
    assert.equal(mock.calls.start.length, 0);
  });

  it('lets a running job finish when the budget is crossed mid-run, and blocks the next one', async () => {
    const provider = testApifyProvider({
      mock: mockApify({
        items: [near(1)],
        usageTotalUsd: 0.45,
        onStart: async () => {
          leadFinderConfig.budget.dailyUsd = 0.5;
        },
      }),
    });
    const job = await createLiveJob(provider);
    assert.equal((await workerWith(provider).runOnce()).outcome, 'completed');
    assert.equal((await getJob(job.id)).progress.processed, 1);

    await assert.rejects(createLiveJob(provider), (err) => err.statusCode === 429);
  });

  it('never budgets or reserves test-data searches', async () => {
    leadFinderConfig.budget.dailyUsd = 0;
    const job = await createJob(PARAMS, admin._id);
    assert.equal(job.cost.status, 'test');
  });
});

describe('provider mode safety', () => {
  it('only enables Apify with the exact value APIFY_ENABLED=true', () => {
    assert.equal(readApifyConfig({}).enabled, false);
    assert.equal(readApifyConfig({ APIFY_ENABLED: 'false' }).enabled, false);
    assert.equal(readApifyConfig({ APIFY_TOKEN: 'token', APIFY_ACTOR_ID: 'a~b' }).enabled, false, 'a token alone is not live');
    assert.equal(readApifyConfig({ APIFY_ENABLED: 'TRUE' }).enabled, false, 'only the exact value "true" enables it');
    assert.equal(readApifyConfig({ APIFY_ENABLED: 'true' }).enabled, true);
  });

  it('runs the test environment on test data with safe budget defaults', () => {
    assert.equal(leadFinderConfig.defaultProvider, 'fake');
    assert.equal(leadFinderConfig.geocoding.enabled, false);
    assert.equal(savedBudget.dailyUsd, 5);
    assert.equal(savedBudget.monthlyUsd, null);
  });

  it('parses budget limits conservatively', () => {
    assert.equal(budgetUsd(undefined, 5), 5);
    assert.equal(budgetUsd('', 5), 5);
    assert.equal(budgetUsd('abc', 5), 5);
    assert.equal(budgetUsd('-1', 5), 5);
    assert.equal(budgetUsd('2.5', 5), 2.5);
    assert.equal(budgetUsd('0', 5), 0);
    assert.equal(budgetUsd('off', 5), null);
    assert.equal(budgetUsd(undefined, null), null);
  });
});

describe('Actor input: closed places and paid add-ons', () => {
  it('keeps every paid add-on and the paid closed-place filter switched off', async () => {
    const mock = mockApify();
    await testApifyProvider({ mock }).discoverBusinesses(PARAMS);
    const { input } = mock.calls.start[0];
    for (const key of [
      'skipClosedPlaces',
      'scrapePlaceDetailPage',
      'scrapeContacts',
      'scrapeDirectories',
      'scrapeTableReservationProvider',
      'scrapeOrderOnline',
      'includeWebResults',
      'verifyLeadsEnrichmentEmails',
      'enableCompetitorAnalysis',
    ]) {
      assert.equal(input[key], false, key);
    }
    for (const key of ['maxReviews', 'maxImages', 'maxQuestions', 'maximumLeadsEnrichmentRecords']) {
      assert.equal(input[key], 0, key);
    }
    assert.equal(input.locationQuery, 'Hyderabad', 'without a resolved centre the named area is searched');
    assert.equal('customGeolocation' in input, false);
  });
});

describe('Apify provider: reading a past run cost', () => {
  it('returns the reported cost, or null when it is missing', async () => {
    assert.equal(await testApifyProvider({ mock: mockApify({ usageTotalUsd: 0.0202 }) }).getRunCost('run-x'), 0.0202);
    assert.equal(await testApifyProvider({ mock: mockApify() }).getRunCost('run-x'), null);
  });

  it('never contacts Apify when it is not configured', async () => {
    const mock = mockApify({ usageTotalUsd: 1 });
    await assert.rejects(
      testApifyProvider({ mock, config: { token: '' } }).getRunCost('run-x'),
      (err) => err.code === 'CONFIGURATION_ERROR',
    );
    assert.equal(mock.calls.factory.length, 0);
  });
});

describe('GET /api/admin/lead-finder/usage', () => {
  const URL = '/api/admin/lead-finder/usage';

  it('requires an admin session', async () => {
    assert.equal((await request(app).get(URL)).status, 401);
  });

  it("returns today's and this month's spend", async () => {
    await insertJobs([{ createdAt: new Date(), usage: settled(25_200) }]);
    const { agent } = await loginAgent(app);
    const res = await agent.get(URL);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.timezone, 'UTC');
    assert.equal(res.body.data.today.spentUsd, 0.0252);
    assert.equal(res.body.data.today.budgetUsd, 5);
    assert.equal(res.body.data.month.budgetUsd, null);
  });

  it('provider status reports budget flags without secrets', async () => {
    const { agent } = await loginAgent(app);
    const res = await agent.get('/api/admin/lead-finder/provider-status');
    assert.equal(res.body.data.dailyBudgetConfigured, true);
    assert.equal(res.body.data.monthlyBudgetConfigured, false);
    assert.doesNotMatch(JSON.stringify(res.body), /token|actorId|runId|datasetId/i);
  });
});
