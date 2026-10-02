import { setTimeout as sleep } from 'node:timers/promises';
import { websiteAnalysisConfig } from '../../config/websiteAnalysis.js';
import { ANALYSIS_ERROR_CODES as C, AnalysisError, safeErrorMessage } from './analysisErrors.js';
import { buildEvidence, buildFailureEvidence } from './evidenceBuilder.js';
import { analyzeHtml } from './htmlAnalyzer.js';
import { isPathAllowed, looksLikeHtml, parseRobotsTxt } from './robotsAnalyzer.js';
import { classifySitemapResponse, isSitemapContentType, sitemapCandidates } from './sitemapAnalyzer.js';
import { detectSocialLinks } from './socialDetector.js';
import { detectTechnologies } from './technologyDetector.js';
import { isTransientDnsError, normalizeWebsiteUrl } from './urlValidator.js';
import { createWebsiteFetcher } from './websiteFetcher.js';

/**
 * The analysis pipeline for one website: homepage -> robots.txt -> sitemap discovery ->
 * HTML/technology/social detection -> evidence. At most 1 homepage request (+1 retry,
 * +1 http:// fallback for scheme-less addresses), 1 robots.txt request and
 * `maxSitemapCandidates` sitemap requests. Never throws for website problems: the result
 * carries status COMPLETED or FAILED with a precise errorCode.
 */

const HTML_TYPES = /^(text\/html|application\/xhtml\+xml)$/;
const isHtmlType = (mime) => !mime || HTML_TYPES.test(mime);
const isTextType = (mime) => !mime || /^text\//.test(mime);
const TRANSIENT = new Set([C.TIMEOUT, C.CONNECTION_ERROR]);
const BLOCK_STATUSES = new Set([401, 403, 429, 503]);
const CHALLENGE_BODY = /cf-chl|just a moment\.\.\.|attention required! \| cloudflare|captcha|access denied|ddos protection|bot verification/i;

const isTransient = (err) => TRANSIENT.has(err?.code) || isTransientDnsError(err);

const header = (headers, name) => {
  const value = headers?.[name];
  return String(Array.isArray(value) ? value[0] : (value ?? ''));
};

/** Bot protection or rate limiting, as opposed to an ordinary HTTP error. */
export const isBlockedResponse = (response) => {
  if (response.status === 429) return true;
  if (!BLOCK_STATUSES.has(response.status)) return false;
  if (header(response.headers, 'cf-mitigated')) return true;
  return CHALLENGE_BODY.test(String(response.body ?? '').slice(0, 20_000));
};

const emptyAvailability = () => ({
  reachable: false,
  httpStatus: null,
  finalUrl: null,
  redirectCount: 0,
  redirectChain: [],
  responseTimeMs: null,
  contentType: null,
  https: null,
  bytes: null,
  attempts: 0,
});

const availabilityFrom = (response, attempts) => ({
  reachable: true,
  httpStatus: response.status,
  finalUrl: response.finalUrl,
  redirectCount: response.redirectCount,
  redirectChain: response.redirectChain.slice(0, 5),
  responseTimeMs: response.responseTimeMs,
  contentType: response.contentType,
  https: new URL(response.finalUrl).protocol === 'https:',
  bytes: response.bytes,
  attempts,
});

/** Availability facts known when the request failed part-way (e.g. after redirects). */
const availabilityFromError = (err, attempts) => {
  const partial = err.partial ?? {};
  const base = emptyAvailability();
  return {
    ...base,
    finalUrl: partial.finalUrl ?? null,
    redirectCount: partial.redirectCount ?? 0,
    redirectChain: (partial.redirectChain ?? []).slice(0, 5),
    httpStatus: partial.httpStatus ?? null,
    // Only a received response says anything about HTTPS; a failed attempt's scheme does not.
    https: partial.finalUrl && partial.httpStatus != null ? new URL(partial.finalUrl).protocol === 'https:' : null,
    attempts,
  };
};

export const createWebsiteAnalyzer = ({
  fetcher = createWebsiteFetcher(),
  config = websiteAnalysisConfig,
  logger = console,
} = {}) => {
  const { request } = config;

  const fetchHomepage = async (url, signal) => {
    let attempts = 0;
    for (;;) {
      attempts += 1;
      try {
        const response = await fetcher.fetchUrl(url, {
          accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
          maxBytes: request.maxHtmlBytes,
          isWantedType: isHtmlType,
          signal,
        });
        return { response, attempts };
      } catch (err) {
        if (attempts > request.transientRetries || !isTransient(err) || signal?.aborted) {
          err.attempts = attempts;
          throw err;
        }
        await sleep(request.retryDelayMs, undefined, signal ? { signal } : undefined).catch(() => {});
      }
    }
  };

  const checkRobots = async (origin, signal) => {
    const robotsUrl = new URL('/robots.txt', origin).href;
    try {
      const res = await fetcher.fetchUrl(robotsUrl, {
        accept: 'text/plain,*/*;q=0.1',
        maxBytes: request.maxRobotsBytes,
        truncate: true,
        isWantedType: isTextType,
        signal,
      });
      const ok = res.status >= 200 && res.status < 300;
      const isFile = ok && !res.skippedBody && !looksLikeHtml(res.body);
      const parsed = isFile ? parseRobotsTxt(res.body) : null;
      return {
        facts: {
          robotsTxtUrl: robotsUrl,
          robotsTxtExists: isFile ? true : res.status >= 500 ? null : false,
          robotsTxtStatus: res.status,
          robotsTxtAccessible: ok,
          robotsTxtSitemaps: parsed?.sitemaps.slice(0, 10) ?? [],
          robotsDisallowsAll: parsed ? !isPathAllowed(parsed, config.robotsAgent, '/') : false,
          robotsErrorCode: null,
        },
        parsed,
      };
    } catch (err) {
      return {
        facts: {
          robotsTxtUrl: robotsUrl,
          robotsTxtExists: null,
          robotsTxtStatus: null,
          robotsTxtAccessible: false,
          robotsTxtSitemaps: [],
          robotsDisallowsAll: false,
          robotsErrorCode: err.code ?? C.ANALYSIS_ERROR,
        },
        parsed: null,
      };
    }
  };

  const discoverSitemap = async ({ origin, robots, htmlSitemaps, signal }) => {
    const candidates = sitemapCandidates({
      origin,
      robotsSitemaps: robots.facts.robotsTxtSitemaps,
      htmlSitemaps,
      max: request.maxSitemapCandidates,
    });
    const checkedUrls = [];
    for (const candidate of candidates) {
      const target = new URL(candidate.url);
      // Respect robots.txt for everything beyond the homepage itself.
      if (robots.parsed && target.origin === origin && !isPathAllowed(robots.parsed, config.robotsAgent, `${target.pathname}${target.search}`)) {
        checkedUrls.push({ url: candidate.url, source: candidate.source, status: null, outcome: 'DISALLOWED_BY_ROBOTS' });
        continue;
      }
      try {
        const res = await fetcher.fetchUrl(candidate.url, {
          accept: 'application/xml,text/xml;q=0.9,*/*;q=0.1',
          maxBytes: request.maxSitemapBytes,
          truncate: true,
          isWantedType: isSitemapContentType,
          signal,
        });
        const { exists, kind } = classifySitemapResponse(res);
        checkedUrls.push({ url: candidate.url, source: candidate.source, status: res.status, outcome: exists ? 'FOUND' : 'NOT_A_SITEMAP' });
        if (exists) {
          return {
            sitemapExists: true,
            sitemapUrl: res.finalUrl,
            sitemapStatus: res.status,
            sitemapSource: candidate.source,
            sitemapKind: kind,
            checkedUrls,
          };
        }
      } catch (err) {
        checkedUrls.push({ url: candidate.url, source: candidate.source, status: err.partial?.httpStatus ?? null, outcome: err.code ?? C.ANALYSIS_ERROR });
      }
    }
    const last = checkedUrls.at(-1);
    const anyAnswered = checkedUrls.some((c) => c.status !== null);
    return {
      sitemapExists: anyAnswered ? false : null,
      sitemapUrl: null,
      sitemapStatus: last?.status ?? null,
      sitemapSource: null,
      sitemapKind: null,
      checkedUrls,
    };
  };

  const fail = ({ websiteUrl, normalized, errorCode, availability = emptyAvailability(), startedAt }) => ({
    status: 'FAILED',
    errorCode,
    errorMessage: safeErrorMessage(errorCode, availability.httpStatus),
    website: { websiteUrl, normalizedWebsiteUrl: normalized, hasWebsite: true },
    availability,
    evidence: buildFailureEvidence({ errorCode, availability, attempts: availability.attempts }),
    durationMs: Date.now() - startedAt,
  });

  /**
   * @param {{ websiteUrl: string }} target the stored website, exactly as recorded
   * @param {{ signal?: AbortSignal }} [options]
   */
  const analyze = async ({ websiteUrl }, { signal } = {}) => {
    const startedAt = Date.now();
    const normalized = normalizeWebsiteUrl(websiteUrl);
    if (normalized.error === C.NO_WEBSITE) {
      return {
        status: 'SKIPPED',
        errorCode: C.NO_WEBSITE,
        errorMessage: safeErrorMessage(C.NO_WEBSITE),
        website: { websiteUrl: websiteUrl ?? null, normalizedWebsiteUrl: null, hasWebsite: false },
        availability: emptyAvailability(),
        evidence: buildFailureEvidence({ errorCode: C.NO_WEBSITE }),
        durationMs: 0,
      };
    }
    if (normalized.error) return fail({ websiteUrl, normalized: null, errorCode: normalized.error, startedAt });

    let homepage;
    try {
      homepage = await fetchHomepage(normalized.url, signal);
    } catch (err) {
      // "example.com" was stored without a scheme: HTTPS was assumed; try plain HTTP once.
      const fallback =
        normalized.assumedScheme && (err.code === C.TLS_ERROR || err.code === C.CONNECTION_ERROR) && !signal?.aborted;
      if (fallback) {
        const httpUrl = normalized.url.replace(/^https:/, 'http:');
        try {
          homepage = await fetchHomepage(httpUrl, signal);
        } catch (second) {
          return fail({ websiteUrl, normalized: normalized.url, errorCode: err.code, availability: availabilityFromError(err, (err.attempts ?? 1) + (second.attempts ?? 1)), startedAt });
        }
      } else {
        if (!(err instanceof AnalysisError)) logger.error?.(`[website-analysis] unexpected fetch error: ${err?.message}`);
        const code = err instanceof AnalysisError ? err.code : C.ANALYSIS_ERROR;
        return fail({ websiteUrl, normalized: normalized.url, errorCode: code, availability: availabilityFromError(err, err.attempts ?? 1), startedAt });
      }
    }

    const { response, attempts } = homepage;
    const availability = availabilityFrom(response, attempts);
    if (response.status < 200 || response.status >= 300) {
      const code = isBlockedResponse(response) ? C.BLOCKED : C.HTTP_ERROR;
      return fail({ websiteUrl, normalized: normalized.url, errorCode: code, availability, startedAt });
    }
    if (response.skippedBody) {
      return fail({ websiteUrl, normalized: normalized.url, errorCode: C.NON_HTML, availability, startedAt });
    }

    const html = analyzeHtml(response.body ?? '', { pageUrl: response.finalUrl });
    const origin = new URL(response.finalUrl).origin;
    const robots = await checkRobots(origin, signal);
    const sitemap = await discoverSitemap({ origin, robots, htmlSitemaps: html.sitemapLinks, signal });
    const technologies = detectTechnologies({ headers: response.headers, signals: html.signals });
    const socialLinks = detectSocialLinks(html.links, 'WEBSITE');

    const facts = {
      availability,
      page: html.page,
      content: html.content,
      structuredData: html.structuredData,
      mobile: html.mobile,
      robots: robots.facts,
      sitemap,
      technologies,
      socialLinks,
    };
    return {
      status: 'COMPLETED',
      errorCode: null,
      errorMessage: null,
      website: { websiteUrl, normalizedWebsiteUrl: normalized.url, hasWebsite: true },
      ...facts,
      evidence: buildEvidence(facts),
      durationMs: Date.now() - startedAt,
    };
  };

  return { analyze };
};
