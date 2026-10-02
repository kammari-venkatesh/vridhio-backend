import { setTimeout as delay } from 'node:timers/promises';
import { ProviderError } from './provider.interface.js';

/**
 * Deterministic provider returning fictional businesses for development and tests.
 * All names, phone numbers (+91 90000 xxxxx) and domains (*.example) are made up.
 *
 * Covers: businesses with and without websites, missing phones, businesses listed
 * under several categories, and a repeated record (overlapping provider pages).
 * Searching for the location "Simulate Failure" makes the provider fail.
 */
const FIXTURES = [
  { key: 'ironpulse', name: 'IronPulse Fitness Studio', categories: ['Gyms'], website: 'https://ironpulse-fitness.example', phone: '+91 90000 00101', street: '14 Lake View Road' },
  { key: 'corestrong', name: 'CoreStrong Gym', categories: ['Gyms'], website: null, phone: '+91 90000 00102', street: '3 Station Lane' },
  { key: 'flexflow', name: 'FlexFlow Yoga & Fitness', categories: ['Gyms', 'Yoga Studios'], website: 'https://flexflow.example', phone: null, street: '88 Garden Street' },
  { key: 'lotus-breath', name: 'Lotus Breath Yoga', categories: ['Yoga Studios'], website: null, phone: '+91 90000 00104', street: '21 Temple Road' },
  { key: 'urban-shears', name: 'Urban Shears Salon', categories: ['Salons'], website: 'https://urbanshears.example', phone: '+91 90000 00201', street: '5 Market Square' },
  { key: 'glow-lounge', name: 'Glow Beauty Lounge', categories: ['Salons'], website: null, phone: null, street: '17 Hill Crescent' },
  { key: 'mane-street', name: 'Mane Street Hair Studio', categories: ['Salons', 'Spas'], website: 'https://manestreet.example', phone: '+91 90000 00203', street: '42 Main Street' },
  { key: 'serenity', name: 'Serenity Day Spa', categories: ['Spas'], website: 'https://serenity-spa.example', phone: '+91 90000 00204', street: '9 Palm Avenue' },
  { key: 'spice-route', name: 'Spice Route Kitchen', categories: ['Restaurants'], website: 'https://spiceroute.example', phone: '+91 90000 00301', street: '60 Food Street' },
  { key: 'tandoor-corner', name: 'Tandoor Corner', categories: ['Restaurants'], website: null, phone: '+91 90000 00302', street: '11 Bazaar Road' },
  { key: 'green-bowl', name: 'Green Bowl Cafe', categories: ['Restaurants', 'Cafes'], website: 'http://greenbowl.example', phone: '+91 90000 00303', street: '27 Park Lane' },
  { key: 'brew-bean', name: 'Brew & Bean Coffee House', categories: ['Cafes'], website: null, phone: '+91 90000 00304', street: '2 College Road' },
  { key: 'brightsmile', name: 'BrightSmile Dental Care', categories: ['Dental Clinics'], website: 'https://brightsmile-dental.example', phone: '+91 90000 00401', street: '33 Health Avenue' },
  { key: 'pearl-dental', name: 'Pearl Dental Clinic', categories: ['Dental Clinics'], website: null, phone: '+91 90000 00402', street: '7 Clinic Road' },
  { key: 'golden-crust', name: 'Golden Crust Bakery', categories: ['Bakeries'], website: null, phone: '+91 90000 00501', street: '19 Mill Street' },
  { key: 'sugarloaf', name: 'Sugarloaf Patisserie', categories: ['Bakeries', 'Cafes'], website: 'https://sugarloaf.example', phone: null, street: '4 Rose Gardens' },
];

const SYNTHETIC_PER_CATEGORY = 3;

const slugify = (text) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const hash = (text) => [...text].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

const syntheticFixtures = (category) =>
  Array.from({ length: SYNTHETIC_PER_CATEGORY }, (_, i) => ({
    key: `${slugify(category)}-${i + 1}`,
    name: `${category} Hub ${i + 1}`,
    categories: [category],
    website: i % 2 === 0 ? `https://${slugify(category)}-hub-${i + 1}.example` : null,
    phone: i === 2 ? null : `+91 90000 9${String(hash(category) % 1000).padStart(3, '0')}${i}`,
    street: `${10 + i} Commerce Road`,
  }));

const fixturesFor = (category) => {
  const matches = FIXTURES.filter((f) => f.categories.some((c) => c.toLowerCase() === category.toLowerCase()));
  return matches.length > 0 ? matches : syntheticFixtures(category);
};

export const createFakeProvider = ({ latencyMs = 0 } = {}) => ({
  name: 'fake',

  async discoverBusinesses({ location, categories, maxBusinesses }, { signal } = {}) {
    if (latencyMs > 0) await delay(latencyMs, undefined, { signal });

    if (location.trim().toLowerCase() === 'simulate failure') {
      throw new ProviderError('The test data provider simulated a failure.');
    }

    const locationSlug = slugify(location);
    const base = hash(locationSlug);
    const baseLat = 8 + (base % 2200) / 100;
    const baseLng = 70 + ((base >> 8) % 1800) / 100;

    // A business listed under several requested categories is returned once per category,
    // like real providers do; the worker de-duplicates by sourceId.
    const records = categories.flatMap((category) =>
      fixturesFor(category).map((f) => {
        const offset = (hash(f.key) % 1000) / 10_000;
        return {
          sourceId: `${locationSlug}:${f.key}`,
          businessName: f.name,
          category,
          categories: f.categories,
          address: `${f.street}, ${location}`,
          phone: f.phone,
          website: f.website,
          googleMapsUrl: `https://maps.example/place/${locationSlug}/${f.key}`,
          latitude: Number((baseLat + offset).toFixed(6)),
          longitude: Number((baseLng + offset).toFixed(6)),
        };
      }),
    );

    // Simulate overlapping result pages: the first record appears again.
    if (records.length >= 2) records.splice(2, 0, { ...records[0] });

    return records.slice(0, maxBusinesses);
  },
});
