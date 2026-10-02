// Preloaded via --import so config/env.js sees test values; Backend/.env is never read by tests.
import { randomBytes } from 'node:crypto';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET_KEY = randomBytes(48).toString('hex');
process.env.CORS_ORIGINS = 'http://localhost:3000';
process.env.LEAD_FINDER_PROVIDER = 'fake';
process.env.FAKE_PROVIDER_LATENCY_MS = '0';
// Tests never reach the real Apify API: live discovery is off and no credentials are present.
process.env.APIFY_ENABLED = 'false';
delete process.env.APIFY_TOKEN;
delete process.env.APIFY_API_TOKEN;
delete process.env.APIFY_ACTOR_ID;
delete process.env.MONGO_URI;
// No geocoding requests leave the test process; tests inject a geocoder where needed.
process.env.LEAD_FINDER_GEOCODING_ENABLED = 'false';
delete process.env.LEAD_FINDER_GEOCODING_URL;
delete process.env.LEAD_FINDER_DAILY_BUDGET_USD;
delete process.env.LEAD_FINDER_MONTHLY_BUDGET_USD;
// Website analysis: no worker is started by tests and no real website is ever fetched;
// tests inject a fake DNS resolver and HTTP transport.
process.env.WEBSITE_ANALYSIS_WORKER_ENABLED = 'false';
delete process.env.WEBSITE_ANALYSIS_TIMEOUT_MS;
delete process.env.WEBSITE_ANALYSIS_CONCURRENCY;
delete process.env.WEBSITE_ANALYSIS_FRESH_DAYS;
// AI qualification: tests never call OpenAI or NVIDIA. Real AI is off, no key is present,
// and tests that need a provider inject a fake one (or a fake fetch for the HTTP clients).
process.env.OPENAI_ENABLED = 'false';
process.env.QUALIFICATION_WORKER_ENABLED = 'false';
delete process.env.OPENAI_API_KEY;
delete process.env.OPENAI_MODEL;
delete process.env.OPENAI_BASE_URL;
delete process.env.OPENAI_INPUT_PRICE_PER_MTOK_USD;
delete process.env.OPENAI_OUTPUT_PRICE_PER_MTOK_USD;
process.env.NVIDIA_ENABLED = 'false';
delete process.env.NVIDIA_API_KEY;
delete process.env.NVIDIA_MODEL;
delete process.env.NVIDIA_BASE_URL;
delete process.env.NVIDIA_MAX_OUTPUT_TOKENS;
delete process.env.NVIDIA_TIMEOUT_MS;
delete process.env.NVIDIA_INPUT_PRICE_PER_MTOK_USD;
delete process.env.NVIDIA_OUTPUT_PRICE_PER_MTOK_USD;
delete process.env.QUALIFICATION_PROVIDER;
delete process.env.QUALIFICATION_FRESH_DAYS;
delete process.env.LEAD_FINDER_AI_DAILY_BUDGET_USD;
delete process.env.LEAD_FINDER_AI_MONTHLY_BUDGET_USD;
