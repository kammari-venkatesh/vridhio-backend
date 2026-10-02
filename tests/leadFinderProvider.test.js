import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeProvider } from '../src/services/leadFinder/fakeProvider.js';
import {
  assertProvider,
  dedupeBySourceId,
  normalizeBusiness,
  ProviderError,
} from '../src/services/leadFinder/provider.interface.js';

const provider = createFakeProvider();
const params = { location: 'Hyderabad', radius: 10, categories: ['Gyms', 'Yoga Studios'], maxBusinesses: 50 };

describe('fake provider', () => {
  it('satisfies the provider contract', () => {
    assert.equal(assertProvider(provider), provider);
    assert.throws(() => assertProvider({ name: 'broken' }), /Invalid Lead Finder provider/);
  });

  it('is deterministic', async () => {
    assert.deepEqual(await provider.discoverBusinesses(params), await provider.discoverBusinesses(params));
  });

  it('covers websites, missing websites, missing phones and multi-category businesses', async () => {
    const records = await provider.discoverBusinesses(params);
    assert.ok(records.some((r) => r.website));
    assert.ok(records.some((r) => r.website === null));
    assert.ok(records.some((r) => r.phone === null));
    assert.ok(records.some((r) => r.categories.length > 1));
  });

  it('returns duplicate source IDs, like overlapping provider pages', async () => {
    const records = await provider.discoverBusinesses(params);
    const ids = records.map((r) => r.sourceId);
    assert.ok(new Set(ids).size < ids.length);
    assert.equal(dedupeBySourceId(records).length, new Set(ids).size);
  });

  it('respects maxBusinesses', async () => {
    const records = await provider.discoverBusinesses({ ...params, maxBusinesses: 3 });
    assert.equal(records.length, 3);
  });

  it('generates synthetic businesses for unknown categories', async () => {
    const records = await provider.discoverBusinesses({ ...params, categories: ['Pet Groomers'] });
    assert.ok(records.length > 0);
    assert.ok(records.every((r) => r.category === 'Pet Groomers'));
  });

  it('can simulate a provider failure', async () => {
    await assert.rejects(provider.discoverBusinesses({ ...params, location: 'Simulate Failure' }), ProviderError);
  });
});

describe('normalizeBusiness', () => {
  it('rejects records without a name or stable ID', () => {
    assert.equal(normalizeBusiness({ sourceId: 'x' }, 'fake'), null);
    assert.equal(normalizeBusiness({ businessName: 'No ID' }, 'fake'), null);
    assert.equal(normalizeBusiness(null, 'fake'), null);
  });

  it('forces the source to the provider name and drops unsafe URLs', () => {
    const business = normalizeBusiness(
      {
        source: 'spoofed',
        sourceId: ' abc ',
        businessName: '  Example Shop ',
        website: 'javascript:alert(1)',
        googleMapsUrl: 'https://maps.example/place/1',
        latitude: 200,
        longitude: 78.4,
      },
      'fake',
    );
    assert.equal(business.source, 'fake');
    assert.equal(business.sourceId, 'abc');
    assert.equal(business.businessName, 'Example Shop');
    assert.equal(business.website, null);
    assert.equal(business.googleMapsUrl, 'https://maps.example/place/1');
    assert.equal(business.latitude, null);
    assert.equal(business.longitude, 78.4);
  });
});
