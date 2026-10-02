import { qualificationConfig } from '../../config/qualification.js';
import { LEVELS } from '../../models/prospectQualification.model.js';
import { cleanText } from './evidencePayload.js';
import { QUALIFICATION_ERROR_CODES as C, QualificationError } from './qualificationErrors.js';
import { serviceById } from './serviceRules.js';

/**
 * Assertions that no supplied evidence can back (nothing about rankings, traffic,
 * sales, customers or social accounts is collected). A heuristic safety net on top of
 * the prompt: an opportunity whose reason makes one is dropped; a summary or next
 * action that makes one fails the whole output.
 */
const UNSUPPORTED_CLAIMS = [
  /\b(google|search)?\s*rankings?\s+(is|are)\s+(poor|low|bad|weak)/i,
  /\b(poor|low|bad|weak)\s+(search\s+)?rankings?\b/i,
  /\branks?\s+(poorly|low|badly)\b/i,
  /\b(low|poor|little|no)\s+(website\s+)?traffic\b/i,
  /\b(is|are)\s+losing\s+(customers|clients|business|sales|revenue|leads)\b/i,
  /\b(low|poor)\s+conversions?(\s+rates?)?\b/i,
  /\b(declining|low|poor)\s+(sales|revenue)\b/i,
  /\b(has|have)\s+no\s+(instagram|facebook|social\s+media)(\s+(presence|accounts?|profiles?))?\b/i,
  /\b(does|do)\s+not\s+(have|use)\s+(instagram|facebook|social\s+media)\b/i,
  /\b(relies|rely)\s+(only|solely|entirely)\s+on\s+(instagram|facebook|whatsapp|social\s+media)\b/i,
  /\b(minimal|limited|low|little|weak|poor|inactive|no)\s+(online\s+)?social(\s+media)?\s+(promotion|presence|activity|engagement|following|reach)\b/i,
  /\bsocial(\s+media)?\s+(activity|engagement|presence|following)\s+(is|are|seems|appears)\s+(low|minimal|limited|weak|poor|lacking)\b/i,
  /\b(inactive|not\s+active)\s+on\s+(social\s+media|instagram|facebook)\b/i,
];

export const makesUnsupportedClaim = (text) => UNSUPPORTED_CLAIMS.some((re) => re.test(text ?? ''));

const isLevel = (v) => typeof v === 'string' && LEVELS.includes(v);
const isStringArray = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');

const truncateWords = (text, maxWords) => {
  const words = text.split(/\s+/);
  return words.length <= maxWords ? text : `${words.slice(0, maxWords).join(' ')}…`;
};

const truncateChars = (text, max) => {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
};

const invalid = (detail) => new QualificationError(C.INVALID_AI_OUTPUT, { detail, providerCalled: true });

/**
 * Validates provider output against the evidence actually sent. Throws
 * INVALID_AI_OUTPUT for structurally unusable output; otherwise drops what cannot be
 * grounded (unknown services, non-candidate services, unknown evidence IDs,
 * opportunities left without supporting evidence) and normalises lengths.
 * Returns { value, validation }.
 */
export const validateQualificationOutput = (raw, { evidence, candidates, limits = qualificationConfig.limits }) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid('output is not an object');
  const { summary, confidence, opportunities, evidenceReferences, missingInformation, recommendedNextAction } = raw;
  if (typeof summary !== 'string' || !cleanText(summary, 2000)) throw invalid('summary missing');
  if (!isLevel(confidence)) throw invalid('confidence invalid');
  if (!Array.isArray(opportunities)) throw invalid('opportunities not an array');
  if (!isStringArray(evidenceReferences)) throw invalid('evidenceReferences invalid');
  if (!isStringArray(missingInformation)) throw invalid('missingInformation invalid');
  if (typeof recommendedNextAction !== 'string' || !cleanText(recommendedNextAction, 2000)) throw invalid('next action missing');

  const notes = [];
  let droppedReferences = 0;
  let droppedOpportunities = 0;
  const byId = new Map(evidence.map((e) => [e.id.toUpperCase(), e]));
  const supportingById = new Map(candidates.map((c) => [c.serviceId, new Set(c.supportingEvidenceIds)]));

  /** An evidence ID ("E2") or an evidence type present exactly in the snapshot; null otherwise. */
  const resolve = (ref) => {
    const key = cleanText(ref, 80)?.toUpperCase();
    if (!key) return null;
    if (byId.has(key)) return byId.get(key);
    return evidence.find((e) => e.type === key) ?? null;
  };
  const resolveAll = (refs) => {
    const out = [];
    for (const ref of refs) {
      const item = resolve(ref);
      if (!item) droppedReferences += 1;
      else if (!out.includes(item)) out.push(item);
    }
    return out;
  };

  const summaryText = cleanText(summary, 2000);
  const actionText = cleanText(recommendedNextAction, 2000);
  if (makesUnsupportedClaim(summaryText)) throw invalid('summary makes an unsupported claim');
  if (makesUnsupportedClaim(actionText)) throw invalid('next action makes an unsupported claim');

  const kept = [];
  for (const opp of opportunities) {
    const drop = (why) => {
      droppedOpportunities += 1;
      notes.push(why);
    };
    if (!opp || typeof opp !== 'object') {
      drop('An opportunity was not an object.');
      continue;
    }
    const service = typeof opp.serviceId === 'string' ? serviceById(opp.serviceId.trim()) : null;
    if (!service) {
      drop('An opportunity named a service that is not in the catalogue.');
      continue;
    }
    if (!supportingById.has(service.id)) {
      drop(`${service.name} was suggested without supporting evidence in the analysis.`);
      continue;
    }
    if (kept.some((k) => k.serviceId === service.id)) {
      drop(`${service.name} was suggested twice.`);
      continue;
    }
    if (!isLevel(opp.priority) || !isLevel(opp.confidence)) {
      drop(`${service.name} had an invalid priority or confidence.`);
      continue;
    }
    const reason = cleanText(opp.reason, 4000);
    if (!reason) {
      drop(`${service.name} had no reason.`);
      continue;
    }
    if (makesUnsupportedClaim(reason)) {
      drop(`${service.name} was dropped because its reason made a claim the evidence cannot support.`);
      continue;
    }
    const refs = isStringArray(opp.evidenceReferences) ? resolveAll(opp.evidenceReferences) : [];
    const supporting = refs.filter((e) => supportingById.get(service.id).has(e.id));
    if (supporting.length === 0) {
      drop(`${service.name} did not cite evidence that supports it.`);
      continue;
    }
    const ordered = [...supporting, ...refs.filter((e) => !supporting.includes(e))].slice(0, limits.maxEvidencePerOpportunity);
    kept.push({
      serviceId: service.id,
      serviceName: service.name,
      priority: opp.priority,
      confidence: opp.confidence,
      reason: truncateChars(reason, limits.reasonMaxChars),
      evidenceReferences: ordered.map((e) => e.id),
    });
  }
  if (kept.length > limits.maxOpportunities) {
    notes.push(`Only the first ${limits.maxOpportunities} opportunities were kept.`);
    droppedOpportunities += kept.length - limits.maxOpportunities;
    kept.length = limits.maxOpportunities;
  }

  const summaryRefs = resolveAll(evidenceReferences).map((e) => e.id);
  const allRefs = [...new Set([...summaryRefs, ...kept.flatMap((o) => o.evidenceReferences)])];

  const normalizedSummary = truncateWords(summaryText, limits.summaryMaxWords);
  if (normalizedSummary !== summaryText) notes.push(`The summary was shortened to ${limits.summaryMaxWords} words.`);

  const missing = [
    ...new Set(missingInformation.map((m) => cleanText(m, 2000)).filter(Boolean).map((m) => truncateChars(m, limits.missingItemMaxChars))),
  ].slice(0, limits.maxMissingInformation);

  return {
    value: {
      summary: normalizedSummary,
      confidence,
      opportunities: kept,
      evidenceReferences: allRefs,
      missingInformation: missing,
      recommendedNextAction: truncateChars(actionText, limits.nextActionMaxChars),
    },
    validation: { droppedOpportunities, droppedReferences, notes: notes.slice(0, 20) },
  };
};
