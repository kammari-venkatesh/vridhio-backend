import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { ProspectWebsiteAnalysis } from '../src/models/prospectWebsiteAnalysis.model.js';
import { buildEvidencePayload, cleanText } from '../src/services/qualification/evidencePayload.js';
import { makesUnsupportedClaim, validateQualificationOutput } from '../src/services/qualification/outputValidator.js';
import { deterministicOutput } from '../src/services/qualification/providers/fakeProvider.js';
import { prepareQualificationInput } from '../src/services/qualification/qualification.service.js';
import { candidateServices, SERVICE_EVIDENCE_RULES } from '../src/services/qualification/serviceRules.js';
import { SALES_SERVICES, SERVICE_CATALOG } from '../src/config/leadWorkspace.js';
import { analysedProspect } from './helpers/qualification.js';
import { clearDb, startTestDb, stopTestDb } from './helpers/testDb.js';

before(startTestDb);
after(stopTestDb);
beforeEach(clearDb);

const inputFor = async (kind) => {
  const { target } = await analysedProspect(kind);
  const doc = await ProspectWebsiteAnalysis.findOne({ subjectKey: target.subjectKey });
  return prepareQualificationInput(target, doc);
};

const types = (evidence) => evidence.map((e) => e.type);
const candidateIds = (candidates) => candidates.map((c) => c.serviceId);

describe('Service catalogue', () => {
  it('uses the public site service IDs and derives the sales-lead service list from one catalogue', () => {
    for (const id of ['website-development', 'app-development', 'ai-automation', 'graphic-design', 'video-editing', 'seo', 'google-ads', 'meta-ads', 'social-media-marketing', 'lead-generation']) {
      assert.ok(SERVICE_CATALOG.some((s) => s.id === id), id);
    }
    assert.deepEqual(SALES_SERVICES.slice(0, -1), SERVICE_CATALOG.map((s) => s.name));
    assert.equal(SALES_SERVICES.at(-1), 'Need to Know');
    for (const id of Object.keys(SERVICE_EVIDENCE_RULES)) assert.ok(SERVICE_CATALOG.some((s) => s.id === id), id);
  });

  it('never offers services that website evidence cannot support', () => {
    const everything = Object.values(SERVICE_EVIDENCE_RULES).flat().map((type, i) => ({ id: `E${i + 1}`, type }));
    const ids = candidateIds(candidateServices(everything));
    for (const id of ['google-ads', 'meta-ads', 'digital-marketing', 'video-editing', 'graphic-design', 'app-development', 'ai-automation', 'lead-generation']) {
      assert.ok(!ids.includes(id), id);
    }
  });

  it('does not treat an access-denied status as a broken website', () => {
    const evidence = [{ id: 'E1', type: 'HTTP_ERROR' }];
    assert.deepEqual(candidateServices(evidence, { httpStatus: 403 }), []);
    assert.deepEqual(candidateIds(candidateServices(evidence, { httpStatus: 500 })), ['website-development']);
  });
});

describe('Evidence payload (fixtures A-D)', () => {
  it('A: no website qualifies from NO_WEBSITE only', async () => {
    const { evidence, candidates, payload } = await inputFor('A');
    assert.deepEqual(types(evidence), ['NO_WEBSITE']);
    assert.deepEqual(candidates, [{ serviceId: 'website-development', serviceName: 'Website Development', supportingEvidenceIds: ['E1'] }]);
    assert.equal(payload.websiteAnalysis.hasWebsite, false);
    // No absence facts are derived for a site that was never fetched.
    assert.ok(!evidence.some((e) => e.source === 'DERIVED'));
  });

  it('B: missing meta description and sitemap become SEO candidates citing those items', async () => {
    const { evidence, candidates } = await inputFor('B');
    const byType = Object.fromEntries(evidence.map((e) => [e.type, e.id]));
    assert.ok(byType.MISSING_META_DESCRIPTION && byType.SITEMAP_MISSING);
    const seo = candidates.find((c) => c.serviceId === 'seo');
    assert.deepEqual(seo.supportingEvidenceIds.sort(), [byType.MISSING_META_DESCRIPTION, byType.SITEMAP_MISSING].sort());
    // Absences are derived with uncertainty in the wording, never "has no social media".
    const social = evidence.find((e) => e.type === 'NO_SOCIAL_LINKS_DETECTED');
    assert.match(social.evidence, /does not show whether the business has social media accounts/);
    assert.equal(social.source, 'DERIVED');
    assert.match(social.id, /^D\d+$/);
  });

  it('C: a strong website yields no candidate services', async () => {
    const { evidence, candidates } = await inputFor('C');
    assert.ok(types(evidence).includes('JSON_LD_PRESENT') && types(evidence).includes('SOCIAL_LINK_FOUND'));
    assert.deepEqual(candidates, []);
  });

  it('D: an access-denied website gives insufficient evidence for any service', async () => {
    const { evidence, candidates } = await inputFor('D');
    assert.deepEqual(types(evidence), ['HTTP_ERROR']);
    assert.deepEqual(candidates, []);
  });

  it('never includes contact details or notes, and stored evidence IDs follow storage order', async () => {
    const { payload, evidence } = await inputFor('B');
    const json = JSON.stringify(payload);
    assert.ok(!json.includes('98000'), 'phone number must not be sent');
    assert.deepEqual(Object.keys(payload.prospect).sort(), ['businessName', 'category', 'city', 'country', 'state', 'website']);
    assert.deepEqual(evidence.filter((e) => e.id.startsWith('E')).map((e) => e.id), evidence.filter((e) => e.id.startsWith('E')).map((_, i) => `E${i + 1}`));
  });

  it('caps and cleans untrusted strings', () => {
    assert.equal(cleanText('a\u0000b\u200bc\n\n d', 50), 'a b c d');
    assert.equal(cleanText('x'.repeat(500), 10).length, 10);
    assert.equal(cleanText('   ', 10), null);
    const { payload } = buildEvidencePayload({
      business: { businessName: 'N'.repeat(1000) },
      analysis: { status: 'COMPLETED', availability: { reachable: true }, page: { title: 'T'.repeat(1000) }, evidence: [{ type: 'MISSING_H1', evidence: 'E'.repeat(1000) }] },
    });
    assert.ok(payload.prospect.businessName.length <= 120);
    assert.ok(payload.websiteAnalysis.title.length <= 200);
    assert.ok(payload.evidence[0].evidence.length <= 300);
  });
});

describe('Output validation (fixtures E-F and grounding rules)', () => {
  let input;
  beforeEach(async () => {
    input = await inputFor('B');
  });
  const validate = (output) => validateQualificationOutput(output, input);
  const base = () => deterministicOutput(input.payload);

  it('accepts the deterministic fake output unchanged', () => {
    const { value, validation } = validate(base());
    assert.deepEqual(value.opportunities.map((o) => o.serviceId).sort(), ['aeo', 'seo', 'social-media-marketing']);
    assert.equal(validation.droppedOpportunities, 0);
    assert.equal(validation.droppedReferences, 0);
  });

  it('E: rejects malformed output as INVALID_AI_OUTPUT', () => {
    for (const bad of [null, 'text', [], { ...base(), summary: 5 }, { ...base(), confidence: 'VERY HIGH' }, { ...base(), opportunities: {} }, { ...base(), missingInformation: [1] }, { ...base(), recommendedNextAction: '' }]) {
      assert.throws(() => validate(bad), (err) => err.code === 'INVALID_AI_OUTPUT' && err.providerCalled === true);
    }
  });

  it('F: drops nonexistent evidence references and opportunities left without support', () => {
    const output = base();
    output.opportunities[0].evidenceReferences = ['E99', 'D42', 'MADE_UP_TYPE'];
    output.evidenceReferences = ['E99', 'E1'];
    const { value, validation } = validate(output);
    assert.ok(!value.opportunities.some((o) => o.serviceId === output.opportunities[0].serviceId));
    assert.deepEqual(value.evidenceReferences.includes('E99'), false);
    assert.ok(validation.droppedReferences >= 4);
    assert.equal(validation.droppedOpportunities, 1);
    for (const opp of value.opportunities) for (const ref of opp.evidenceReferences) assert.ok(input.evidence.some((e) => e.id === ref));
  });

  it('rejects services outside the catalogue or without supporting evidence, and invalid enums', () => {
    const output = base();
    const seoRefs = output.opportunities.find((o) => o.serviceId === 'seo').evidenceReferences;
    output.opportunities.push(
      { serviceId: 'crypto-consulting', serviceName: 'Crypto', priority: 'HIGH', reason: 'x', evidenceReferences: seoRefs, confidence: 'HIGH' },
      { serviceId: 'google-ads', serviceName: 'Google Ads', priority: 'HIGH', reason: 'Ads may help.', evidenceReferences: seoRefs, confidence: 'HIGH' },
      { serviceId: 'website-redesign', serviceName: 'Website Redesign', priority: 'HIGH', reason: 'Old.', evidenceReferences: seoRefs, confidence: 'HIGH' },
    );
    output.opportunities[0].priority = 'URGENT';
    const { value, validation } = validate(output);
    const ids = value.opportunities.map((o) => o.serviceId);
    assert.ok(!ids.includes('crypto-consulting') && !ids.includes('google-ads') && !ids.includes('website-redesign'));
    assert.equal(validation.droppedOpportunities, 4);
  });

  it('requires a supporting reference, not just any existing one', () => {
    const output = base();
    const https = input.evidence.find((e) => e.type === 'HTTPS_PRESENT').id;
    const seo = output.opportunities.find((o) => o.serviceId === 'seo');
    seo.evidenceReferences = [https];
    const { value } = validate(output);
    assert.ok(!value.opportunities.some((o) => o.serviceId === 'seo'));
  });

  it('normalises evidence types to IDs and orders supporting references first', () => {
    const output = base();
    const seo = output.opportunities.find((o) => o.serviceId === 'seo');
    seo.evidenceReferences = ['HTTPS_PRESENT', 'missing_meta_description'];
    const { value } = validate(output);
    const kept = value.opportunities.find((o) => o.serviceId === 'seo');
    const ids = Object.fromEntries(input.evidence.map((e) => [e.type, e.id]));
    assert.deepEqual(kept.evidenceReferences, [ids.MISSING_META_DESCRIPTION, ids.HTTPS_PRESENT]);
  });

  it('enforces size limits', () => {
    const output = base();
    output.summary = Array.from({ length: 90 }, (_, i) => `word${i}`).join(' ');
    output.missingInformation = Array.from({ length: 12 }, (_, i) => `item ${i} ${'x'.repeat(300)}`);
    output.recommendedNextAction = 'Review '.repeat(60);
    const seo = output.opportunities.find((o) => o.serviceId === 'seo');
    seo.evidenceReferences = input.evidence.map((e) => e.id);
    seo.reason = 'r '.repeat(400);
    output.opportunities.push(...Array.from({ length: 4 }, () => ({ ...seo })));
    const { value, validation } = validate(output);
    assert.equal(value.summary.split(/\s+/).length, 60);
    assert.ok(value.summary.endsWith('…'));
    assert.equal(value.missingInformation.length, 8);
    assert.ok(value.missingInformation.every((m) => m.length <= 200));
    assert.ok(value.recommendedNextAction.length <= 200);
    assert.ok(value.opportunities.length <= 5);
    assert.ok(value.opportunities.every((o) => o.evidenceReferences.length <= 5 && o.reason.length <= 400));
    assert.ok(validation.notes.some((n) => /shortened/.test(n)));
  });

  it('overrides service names from the catalogue', () => {
    const output = base();
    output.opportunities[0].serviceName = 'Something invented';
    const { value } = validate(output);
    assert.ok(value.opportunities.every((o) => SERVICE_CATALOG.find((s) => s.id === o.serviceId).name === o.serviceName));
  });

  it('rejects claims the evidence cannot support', () => {
    for (const claim of ['Their Google rankings are poor.', 'The business is losing customers.', 'Low traffic is likely.', 'The business has no Instagram.', 'They do not use social media.', 'The homepage lacks Open Graph tags, suggesting minimal social media promotion.', 'The business has low social media activity.', 'Social media engagement appears limited.', 'They are inactive on Instagram.']) {
      assert.ok(makesUnsupportedClaim(claim), claim);
    }
    for (const fine of ['No social media links were detected on the homepage.', 'A sitemap could help search engines find pages.', 'Rankings were not measured.', 'No Open Graph tags were found, so shared links may show no preview.', 'Social media activity was not collected.']) {
      assert.ok(!makesUnsupportedClaim(fine), fine);
    }
    const inReason = base();
    inReason.opportunities[0].reason = 'Missing sitemap means rankings are poor.';
    assert.equal(validate(inReason).value.opportunities.length, 2);
    assert.throws(() => validate({ ...base(), summary: 'The bakery is losing customers to competitors.' }), (e) => e.code === 'INVALID_AI_OUTPUT');
    assert.throws(() => validate({ ...base(), recommendedNextAction: 'Explain they have low traffic.' }), (e) => e.code === 'INVALID_AI_OUTPUT');
  });

  it('accepts an empty opportunity list for insufficient evidence', () => {
    const { value } = validate({ ...base(), opportunities: [], confidence: 'LOW' });
    assert.deepEqual(value.opportunities, []);
  });
});
