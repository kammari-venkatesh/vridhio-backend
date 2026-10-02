// In-memory stand-in for apify-client. Tests never reach the real Apify API.
import { createApifyProvider } from '../../src/services/leadFinder/apify/apifyProvider.js';

export const FAKE_TOKEN = 'apify_api_TESTONLY_DoNotLeak_123456';

export const testApifyConfig = (overrides = {}) => ({
  enabled: true,
  token: FAKE_TOKEN,
  actorId: 'test-user/test-places-actor',
  actorAdapter: 'google-maps',
  timeoutSeconds: 300,
  maxItems: 100,
  maxTotalChargeUsd: 0.5,
  pollIntervalSeconds: 5,
  ...overrides,
});

export const apiError = (statusCode, message = `Request failed (token ${FAKE_TOKEN})`) =>
  Object.assign(new Error(message), { name: 'ApifyApiError', statusCode, type: 'test-error' });

export const placeItem = (n, overrides = {}) => ({
  placeId: `ChIJtestPlace${n}`,
  title: `Test Business ${n}`,
  categoryName: 'Gym',
  categories: ['Gym', 'Fitness center'],
  searchString: 'gyms',
  address: `${n} Main Road, Hyderabad, Telangana 500001, India`,
  city: 'Hyderabad',
  state: 'Telangana',
  countryCode: 'IN',
  phone: `+91 90000 0000${n}`,
  website: `https://business${n}.example/`,
  url: `https://www.google.com/maps/place/?q=place_id:ChIJtestPlace${n}`,
  location: { lat: Number(`17.38${n}`), lng: 78.486 },
  totalScore: 4.5,
  reviewsCount: 10,
  ...overrides,
});

/**
 * Builds a mock client factory. `statuses` are returned by successive run.get()
 * calls, each with `usageTotalUsd` when given (a value, or a function of the call
 * number); hooks (onStart, onGet, onListItems) let tests act mid-run.
 */
export const mockApify = ({
  startRun = { id: 'run-test-1', defaultDatasetId: 'dataset-test-1', status: 'READY' },
  startError = null,
  statuses = ['RUNNING', 'SUCCEEDED'],
  usageTotalUsd,
  getError = null,
  items = [],
  listItemsResult,
  onStart = async () => {},
  onGet = async () => {},
  onListItems = async () => {},
} = {}) => {
  const calls = { factory: [], start: [], get: [], abort: [], listItems: [] };
  let statusIndex = 0;

  const client = {
    actor: (actorId) => ({
      start: async (input, options) => {
        calls.start.push({ actorId, input, options });
        await onStart();
        if (startError) throw startError;
        return startRun;
      },
    }),
    run: (runId) => ({
      get: async () => {
        calls.get.push(runId);
        await onGet(calls.get.length);
        if (getError) throw getError;
        const status = statuses[Math.min(statusIndex, statuses.length - 1)];
        statusIndex += 1;
        const usage = typeof usageTotalUsd === 'function' ? usageTotalUsd(calls.get.length) : usageTotalUsd;
        return {
          id: runId,
          defaultDatasetId: startRun?.defaultDatasetId,
          status,
          ...(usage !== undefined && { usageTotalUsd: usage }),
        };
      },
      abort: async () => {
        calls.abort.push(runId);
        return { id: runId, status: 'ABORTING' };
      },
    }),
    dataset: (datasetId) => ({
      listItems: async (options) => {
        calls.listItems.push({ datasetId, options });
        await onListItems();
        return listItemsResult ?? { items, total: items.length, offset: 0, count: items.length, limit: options?.limit };
      },
    }),
  };

  const clientFactory = (options) => {
    calls.factory.push(options);
    return client;
  };
  return { calls, clientFactory };
};

export const collectingLogger = () => {
  const lines = [];
  const push = (...args) => lines.push(args.map(String).join(' '));
  return { lines, logger: { info: push, warn: push, error: push } };
};

const noSleep = async (_ms, _value, { signal } = {}) => signal?.throwIfAborted();

export const testApifyProvider = ({ config, mock, sleep = noSleep, now, logger } = {}) =>
  createApifyProvider({
    config: testApifyConfig(config),
    clientFactory: mock.clientFactory,
    sleep,
    ...(now ? { now } : {}),
    logger: logger ?? collectingLogger().logger,
  });
