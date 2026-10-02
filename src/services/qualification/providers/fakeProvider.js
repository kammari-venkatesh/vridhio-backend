const PRIORITY_BY_SEVERITY = { WARNING: 'HIGH', NOTICE: 'MEDIUM', INFO: 'LOW' };
const RANK = { HIGH: 3, MEDIUM: 2, LOW: 1 };

/** Deterministic qualification built only from the payload: one opportunity per candidate. */
export const deterministicOutput = (payload) => {
  const byId = new Map(payload.evidence.map((e) => [e.id, e]));
  const opportunities = payload.candidateServices.map((c) => {
    const items = c.supportingEvidenceIds.map((id) => byId.get(id)).filter(Boolean);
    const priority = items
      .map((e) => PRIORITY_BY_SEVERITY[e.severity] ?? 'LOW')
      .sort((a, b) => RANK[b] - RANK[a])[0];
    return {
      serviceId: c.serviceId,
      serviceName: c.serviceName,
      priority,
      reason: `The website analysis recorded: ${items.map((e) => e.evidence).join(' ')}`,
      evidenceReferences: c.supportingEvidenceIds.slice(0, 5),
      confidence: items.length >= 2 ? 'HIGH' : 'MEDIUM',
    };
  });
  const wa = payload.websiteAnalysis;
  const summary = !wa.hasWebsite
    ? 'No website is recorded for this business, so no website facts were available.'
    : wa.reachable
      ? `The website was reachable (HTTP ${wa.httpStatus}${wa.https ? ', HTTPS' : ''}). The analysis recorded ${payload.evidence.length} observations.`
      : 'The recorded website could not be reached during the analysis.';
  return {
    summary,
    confidence: payload.evidence.length >= 3 ? 'MEDIUM' : 'LOW',
    opportunities,
    evidenceReferences: payload.evidence.slice(0, 3).map((e) => e.id),
    missingInformation: ['No search-ranking data was collected.', 'No traffic or conversion analytics were available.'],
    recommendedNextAction: opportunities.length
      ? `Review the ${opportunities[0].serviceName} evidence before deciding whether to contact the business.`
      : 'Review the website analysis manually; it did not show evidence for a specific service.',
  };
};

/**
 * Free, deterministic provider for tests and isolated environments. `respond(payload,
 * messages)` can override the output (or throw) to simulate any provider behaviour.
 * Every request is recorded in `requests` so tests can inspect what would be sent.
 */
export const createFakeQualificationProvider = ({ respond, usage = { inputTokens: 900, outputTokens: 250 } } = {}) => {
  const requests = [];
  return {
    name: 'fake',
    model: 'fake-qualifier-1',
    paid: false,
    requests,
    estimateMaxCostMicroUsd: () => 0,
    costMicroUsd: () => 0,
    async analyzeProspect({ payload, messages, signal }) {
      requests.push({ payload, messages });
      if (signal?.aborted) throw signal.reason ?? new Error('aborted');
      const output = respond ? await respond(payload, messages) : deterministicOutput(payload);
      return {
        output,
        usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: usage.inputTokens + usage.outputTokens },
      };
    },
  };
};
