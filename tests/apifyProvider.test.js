import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { apifyConfigIssues, readApifyConfig } from '../src/config/apify.js';
import { mapApifyBusiness } from '../src/services/leadFinder/apify/actorAdapters.js';
import { mapApifyError } from '../src/services/leadFinder/apify/apifyErrors.js';
import {
  dedupeBySourceId,
  normalizeBusiness,
  PROVIDER_ERROR_CODES as CODES,
  ProviderError,
  SAFE_PROVIDER_MESSAGES,
} from '../src/services/leadFinder/provider.interface.js';
import { getProviderStatus } from '../src/services/leadFinder/providers.js';
import {
  apiError,
  collectingLogger,
  FAKE_TOKEN,
  mockApify,
  placeItem,
  testApifyConfig,
  testApifyProvider,
} from './helpers/mockApify.js';

const PARAMS = { location: 'Hyderabad, India', radius: 5, categories: ['Gyms'], maxBusinesses: 5 };

const rejectsWithCode = (promise, code) =>
  assert.rejects(promise, (err) => {
    assert.ok(err instanceof ProviderError, `expected ProviderError, got ${err?.name}`);
    assert.equal(err.code, code);
    return true;
  });

describe('Apify configuration', () => {
  it('reads settings from the environment and accepts the legacy token name', () => {
    const config = readApifyConfig({ APIFY_ENABLED: 'true', APIFY_API_TOKEN: ' legacy ', APIFY_ACTOR_ID: 'a/b' });
    assert.equal(config.enabled, true);
    assert.equal(config.token, 'legacy');
    assert.equal(config.actorId, 'a/b');
    assert.equal(config.timeoutSeconds, 300);
    assert.equal(config.pollIntervalSeconds, 5);
    assert.equal(readApifyConfig({ APIFY_TOKEN: 'new', APIFY_API_TOKEN: 'old' }).token, 'new');
    assert.equal(readApifyConfig({}).enabled, false);
  });

  it('reports missing and invalid settings by name only', () => {
    const issues = apifyConfigIssues(readApifyConfig({ APIFY_MAX_TOTAL_CHARGE_USD: 'lots', APIFY_TIMEOUT_SECONDS: '-1' }));
    assert.deepEqual(issues.sort(), ['APIFY_ACTOR_ID', 'APIFY_MAX_TOTAL_CHARGE_USD', 'APIFY_TIMEOUT_SECONDS', 'APIFY_TOKEN']);
    assert.deepEqual(apifyConfigIssues(testApifyConfig()), []);
    assert.deepEqual(apifyConfigIssues(testApifyConfig({ actorAdapter: 'nope' }), { knownAdapters: ['google-maps'] }), [
      'APIFY_ACTOR_ADAPTER',
    ]);
  });

  it('is unconfigured in the test environment and never calls Apify', () => {
    assert.deepEqual(getProviderStatus('apify'), {
      provider: 'apify',
      mode: 'unconfigured',
      configured: false,
      actorConfigured: false,
      dailyBudgetConfigured: true,
      monthlyBudgetConfigured: false,
    });
    assert.deepEqual(getProviderStatus('fake'), {
      provider: 'fake',
      mode: 'test',
      configured: true,
      actorConfigured: false,
      dailyBudgetConfigured: true,
      monthlyBudgetConfigured: false,
    });
  });
});

describe('Apify provider: configuration errors', () => {
  for (const [label, overrides] of [
    ['config missing', { token: '', actorId: '' }],
    ['token missing', { token: '' }],
    ['actor ID missing', { actorId: '' }],
  ]) {
    it(`refuses to run when ${label}, before creating a client`, async () => {
      const mock = mockApify();
      const provider = testApifyProvider({ config: overrides, mock });
      assert.equal(provider.getStatus().configured, false);
      assert.throws(() => provider.validateRequest(PARAMS), (err) => err.code === CODES.CONFIGURATION_ERROR);
      await rejectsWithCode(provider.discoverBusinesses(PARAMS), CODES.CONFIGURATION_ERROR);
      assert.equal(mock.calls.factory.length, 0);
      assert.equal(mock.calls.start.length, 0);
    });
  }

  it('reports whether an Actor is configured without exposing it', () => {
    const status = testApifyProvider({ mock: mockApify() }).getStatus();
    assert.deepEqual(status, { configured: true, actorConfigured: true });
  });
});

describe('Apify provider: run lifecycle', () => {
  it('starts the Actor with mapped input and cost limits, and records the run IDs', async () => {
    const mock = mockApify({ items: [placeItem(1)] });
    const reported = [];
    const provider = testApifyProvider({ mock });

    await provider.discoverBusinesses(PARAMS, { reportRun: async (run) => reported.push(run) });

    assert.equal(mock.calls.start.length, 1);
    const { actorId, input, options } = mock.calls.start[0];
    assert.equal(actorId, 'test-user/test-places-actor');
    assert.deepEqual(input.searchStringsArray, ['Gyms']);
    assert.equal(input.locationQuery, 'Hyderabad, India');
    assert.equal(input.maxCrawledPlacesPerSearch, 5);
    assert.equal(input.skipClosedPlaces, false, 'closed places are filtered by the worker, not a paid Actor filter');
    assert.equal(input.scrapeContacts, false);
    assert.equal(input.maxReviews, 0);
    assert.equal(input.maximumLeadsEnrichmentRecords, 0);
    assert.deepEqual(options, { timeout: 300, maxItems: 5, maxTotalChargeUsd: 0.5, restartOnError: false });
    assert.deepEqual(reported, [{ runId: 'run-test-1', datasetId: 'dataset-test-1' }]);
  });

  it('never retries starting a paid run but allows bounded retries for reads', async () => {
    const mock = mockApify();
    await testApifyProvider({ mock }).discoverBusinesses(PARAMS);
    const retries = mock.calls.factory.map((o) => o.maxRetries).sort();
    assert.deepEqual(retries, [0, 2]);
    assert.ok(mock.calls.factory.every((o) => o.token === FAKE_TOKEN));
  });

  it('splits the item budget across categories', async () => {
    const mock = mockApify();
    await testApifyProvider({ mock }).discoverBusinesses({ ...PARAMS, categories: ['Gyms', 'Salons'], maxBusinesses: 5 });
    assert.equal(mock.calls.start[0].input.maxCrawledPlacesPerSearch, 3);
  });

  it('polls until SUCCEEDED, then downloads and maps the dataset', async () => {
    const sleeps = [];
    const mock = mockApify({ statuses: ['RUNNING', 'RUNNING', 'SUCCEEDED'], items: [placeItem(1), placeItem(2)] });
    const provider = testApifyProvider({ mock, sleep: async (ms) => sleeps.push(ms) });

    const records = await provider.discoverBusinesses(PARAMS);

    assert.equal(mock.calls.get.length, 3);
    assert.deepEqual(sleeps, [5000, 5000, 5000]);
    assert.deepEqual(mock.calls.listItems, [{ datasetId: 'dataset-test-1', options: { limit: 5, clean: true } }]);
    assert.equal(records.length, 2);
    assert.equal(records[0].sourceId, 'ChIJtestPlace1');
    assert.equal(records[0].businessName, 'Test Business 1');
    assert.equal(mock.calls.abort.length, 0);
  });

  it('fails without fetching data when the run FAILED or was ABORTED', async () => {
    for (const status of ['FAILED', 'ABORTED']) {
      const mock = mockApify({ statuses: [status] });
      await rejectsWithCode(testApifyProvider({ mock }).discoverBusinesses(PARAMS), CODES.PROVIDER_FAILED);
      assert.equal(mock.calls.listItems.length, 0);
      assert.equal(mock.calls.abort.length, 0, 'a finished run is not aborted');
    }
  });

  it('reports a timeout when the Actor run TIMED-OUT', async () => {
    const mock = mockApify({ statuses: ['TIMED-OUT'] });
    await rejectsWithCode(testApifyProvider({ mock }).discoverBusinesses(PARAMS), CODES.PROVIDER_TIMEOUT);
  });

  it('aborts the run and times out when it never finishes', async () => {
    let clock = 0;
    const mock = mockApify({ statuses: ['RUNNING'] });
    const provider = testApifyProvider({
      mock,
      config: { timeoutSeconds: 60 },
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });

    await rejectsWithCode(provider.discoverBusinesses(PARAMS), CODES.PROVIDER_TIMEOUT);
    assert.deepEqual(mock.calls.abort, ['run-test-1']);
    assert.equal(mock.calls.listItems.length, 0);
  });

  it('treats a start response without run or dataset IDs as invalid', async () => {
    const mock = mockApify({ startRun: { id: 'run-x' } });
    await rejectsWithCode(testApifyProvider({ mock }).discoverBusinesses(PARAMS), CODES.PROVIDER_INVALID_RESPONSE);
    assert.deepEqual(mock.calls.abort, ['run-x']);
  });

  it('treats a malformed dataset response as invalid', async () => {
    const mock = mockApify({ listItemsResult: { items: 'not-a-list' } });
    await rejectsWithCode(testApifyProvider({ mock }).discoverBusinesses(PARAMS), CODES.PROVIDER_INVALID_RESPONSE);
  });
});

describe('Apify provider: API errors', () => {
  const cases = [
    [401, CODES.PROVIDER_AUTH_ERROR],
    [403, CODES.PROVIDER_AUTH_ERROR],
    [429, CODES.PROVIDER_RATE_LIMIT],
    [404, CODES.CONFIGURATION_ERROR],
    [400, CODES.CONFIGURATION_ERROR],
    [402, CODES.PROVIDER_FAILED],
    [503, CODES.PROVIDER_UNAVAILABLE],
  ];
  for (const [status, code] of cases) {
    it(`maps HTTP ${status} when starting to ${code} without retrying`, async () => {
      const mock = mockApify({ startError: apiError(status) });
      await rejectsWithCode(testApifyProvider({ mock }).discoverBusinesses(PARAMS), code);
      assert.equal(mock.calls.start.length, 1);
      assert.equal(mock.calls.get.length, 0);
    });
  }

  it('maps network errors to PROVIDER_UNAVAILABLE', async () => {
    const mock = mockApify({ startError: Object.assign(new Error('getaddrinfo ENOTFOUND api.apify.com'), { code: 'ENOTFOUND' }) });
    await rejectsWithCode(testApifyProvider({ mock }).discoverBusinesses(PARAMS), CODES.PROVIDER_UNAVAILABLE);
  });

  it('aborts the run when polling fails (rate limit after retries)', async () => {
    const mock = mockApify({ getError: apiError(429) });
    await rejectsWithCode(testApifyProvider({ mock }).discoverBusinesses(PARAMS), CODES.PROVIDER_RATE_LIMIT);
    assert.deepEqual(mock.calls.abort, ['run-test-1']);
  });

  it('uses only safe messages and never leaks the token, raw errors or URLs', async () => {
    const { lines, logger } = collectingLogger();
    const mock = mockApify({ startError: apiError(401, `Unauthorized https://api.apify.com/v2/acts?token=${FAKE_TOKEN}`) });
    const provider = testApifyProvider({ mock, logger });

    const err = await provider.discoverBusinesses(PARAMS).catch((e) => e);

    assert.equal(err.message, SAFE_PROVIDER_MESSAGES.PROVIDER_AUTH_ERROR);
    assert.equal(err.cause, undefined, 'raw client errors are not attached');
    const surfaces = [err.message, err.stack, JSON.stringify(err), ...lines].join('\n');
    assert.doesNotMatch(surfaces, new RegExp(FAKE_TOKEN));
    assert.doesNotMatch(surfaces, /api\.apify\.com|Unauthorized/);
    assert.ok(lines.some((l) => l.includes('PROVIDER_AUTH_ERROR (HTTP 401)')));
  });

  it('maps unknown errors to a generic safe message', () => {
    const err = mapApifyError(new Error(`boom ${FAKE_TOKEN}`));
    assert.equal(err.code, CODES.PROVIDER_UNAVAILABLE);
    assert.equal(err.message, 'Business discovery provider is temporarily unavailable.');
  });
});

describe('Apify provider: limits', () => {
  it('rejects searches over the configured item limit before starting a run', async () => {
    const mock = mockApify();
    const provider = testApifyProvider({ mock, config: { maxItems: 20 } });
    assert.throws(
      () => provider.validateRequest({ ...PARAMS, maxBusinesses: 21 }),
      (err) => err.code === CODES.VALIDATION_ERROR && /20 businesses/.test(err.message),
    );
    await rejectsWithCode(provider.discoverBusinesses({ ...PARAMS, maxBusinesses: 21 }), CODES.VALIDATION_ERROR);
    assert.equal(mock.calls.start.length, 0);
  });

  it('enforces the application maximum of 100 even if Apify allows more', async () => {
    const mock = mockApify();
    const provider = testApifyProvider({ mock, config: { maxItems: 500 } });
    await rejectsWithCode(provider.discoverBusinesses({ ...PARAMS, maxBusinesses: 101 }), CODES.VALIDATION_ERROR);
    await provider.discoverBusinesses({ ...PARAMS, maxBusinesses: 100 });
    assert.equal(mock.calls.start[0].options.maxItems, 100);
  });

  it('passes the spending cap to every run', async () => {
    const mock = mockApify();
    await testApifyProvider({ mock, config: { maxTotalChargeUsd: 0.25 } }).discoverBusinesses(PARAMS);
    assert.equal(mock.calls.start[0].options.maxTotalChargeUsd, 0.25);
  });
});

describe('Apify provider: cancellation', () => {
  it('stops waiting and aborts the run when the signal fires during polling', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled by admin');
    const mock = mockApify({
      statuses: ['RUNNING'],
      onGet: async (n) => n === 2 && controller.abort(reason),
    });

    await assert.rejects(testApifyProvider({ mock }).discoverBusinesses(PARAMS, { signal: controller.signal }), reason);
    assert.deepEqual(mock.calls.abort, ['run-test-1']);
    assert.equal(mock.calls.listItems.length, 0);
  });

  it('does not start a run when already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const mock = mockApify();
    await assert.rejects(testApifyProvider({ mock }).discoverBusinesses(PARAMS, { signal: controller.signal }));
    assert.equal(mock.calls.start.length, 0);
  });

  it('discards results that arrive after cancellation', async () => {
    const controller = new AbortController();
    const mock = mockApify({ items: [placeItem(1)], onListItems: async () => controller.abort() });

    await assert.rejects(testApifyProvider({ mock }).discoverBusinesses(PARAMS, { signal: controller.signal }));
    assert.equal(mock.calls.abort.length, 0, 'the run had already finished');
  });
});

describe('Apify adapter: mapApifyBusiness', () => {
  it('maps a complete place to the normalized provider contract', () => {
    const record = mapApifyBusiness(placeItem(1), { categories: ['Gyms'] });
    assert.deepEqual(record, {
      sourceId: 'ChIJtestPlace1',
      businessName: 'Test Business 1',
      category: 'Gyms',
      categories: ['Gym', 'Fitness center'],
      address: '1 Main Road, Hyderabad, Telangana 500001, India',
      city: 'Hyderabad',
      state: 'Telangana',
      country: 'IN',
      phone: '+91 90000 00001',
      website: 'https://business1.example/',
      googleMapsUrl: 'https://www.google.com/maps/place/?q=place_id:ChIJtestPlace1',
      latitude: 17.381,
      longitude: 78.486,
      permanentlyClosed: null,
    });
  });

  it('never invents ratings, reviews, emails or owners', () => {
    const record = mapApifyBusiness(placeItem(1, { email: 'x@y.z', owner: 'Someone' }));
    for (const key of ['totalScore', 'reviewsCount', 'rating', 'email', 'owner', 'socialProfiles', 'score']) {
      assert.equal(key in record, false, key);
    }
  });

  it('marks items without a Place ID or title as malformed', () => {
    for (const item of [null, 'text', 42, [], {}, placeItem(1, { placeId: null }), placeItem(1, { placeId: '  ' }), placeItem(1, { title: undefined })]) {
      assert.equal(mapApifyBusiness(item), null, JSON.stringify(item));
    }
  });

  it('tolerates missing, null and wrongly typed optional fields', () => {
    const record = mapApifyBusiness({
      placeId: 'ChIJonlyBasics',
      title: 'Only Basics',
      categories: 'not-an-array',
      categoryName: 7,
      phone: null,
      website: { url: 'x' },
      location: 'somewhere',
    });
    assert.equal(record.sourceId, 'ChIJonlyBasics');
    assert.equal(record.category, '7');
    assert.deepEqual(record.categories, ['7']);
    assert.equal(record.phone, null);
    assert.equal(record.website, null);
    assert.equal(record.latitude, null);
    assert.equal(record.city, null);
  });

  it('falls back to the unformatted phone and coerces numeric coordinate strings', () => {
    const record = mapApifyBusiness(placeItem(1, { phone: null, phoneUnformatted: '+919000000001', location: { lat: '17.4', lng: '78.5' } }));
    assert.equal(record.phone, '+919000000001');
    assert.equal(record.latitude, 17.4);
    assert.equal(record.longitude, 78.5);
  });

  it('leaves invalid coordinates and unsafe websites to the existing normalizer', () => {
    const record = mapApifyBusiness(placeItem(1, { website: 'javascript:alert(1)', location: { lat: 123, lng: 'east' } }));
    const business = normalizeBusiness(record, 'apify');
    assert.equal(business.website, null);
    assert.equal(business.latitude, null);
    assert.equal(business.longitude, null);
    assert.equal(normalizeBusiness(mapApifyBusiness(placeItem(2, { website: 'ftp://files.example' })), 'apify').website, null);
  });

  it('keeps stable Place IDs so repeated places deduplicate', () => {
    const records = [placeItem(1), placeItem(1, { searchString: 'fitness' }), placeItem(2)]
      .map((item) => normalizeBusiness(mapApifyBusiness(item), 'apify'))
      .filter(Boolean);
    assert.deepEqual(dedupeBySourceId(records).map((r) => r.sourceId), ['ChIJtestPlace1', 'ChIJtestPlace2']);
  });
});
