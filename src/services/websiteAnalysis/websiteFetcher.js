import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';
import { websiteAnalysisConfig } from '../../config/websiteAnalysis.js';
import { ANALYSIS_ERROR_CODES as C, AnalysisError } from './analysisErrors.js';
import { assertSafeUrl, createSafeResolver } from './urlValidator.js';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_HEADER_BYTES = 32 * 1024;

/**
 * Real transport: one GET over node:http/https that connects to the pre-validated
 * `address` (DNS is never consulted again), while keeping the original hostname for the
 * Host header and TLS SNI/certificate verification. No connection pooling, no proxies.
 * Resolves with { status, headers, body } as soon as response headers arrive.
 */
export const nodeTransport = ({ url, address, family, headers, signal }) =>
  new Promise((resolve, reject) => {
    const secure = url.protocol === 'https:';
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const req = (secure ? https : http).request(
      {
        protocol: url.protocol,
        hostname: host,
        port: url.port || (secure ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers,
        signal,
        agent: false,
        maxHeaderSize: MAX_HEADER_BYTES,
        lookup: (_hostname, options, callback) =>
          options?.all ? callback(null, [{ address, family }]) : callback(null, address, family),
        ...(secure && !net.isIP(host) ? { servername: host } : {}),
      },
      (res) => resolve({ status: res.statusCode, headers: res.headers, body: res }),
    );
    req.on('error', reject);
    req.end();
  });

const TLS_CODE = /^(ERR_TLS_|ERR_SSL_|ERR_OSSL_|CERT_|UNABLE_TO_|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|HOSTNAME_MISMATCH|EPROTO$)/;
const CONNECTION_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EHOSTDOWN',
  'ENETDOWN',
  'EPIPE',
  'EADDRNOTAVAIL',
  'ERR_STREAM_PREMATURE_CLOSE',
]);

/** Maps a low-level network error to a precise, safe analysis error code. */
export const classifyNetworkError = (err, { timedOut = false } = {}) => {
  if (err instanceof AnalysisError) return err;
  if (timedOut) return new AnalysisError(C.TIMEOUT);
  const code = err?.code ?? err?.cause?.code ?? '';
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT' || err?.name === 'TimeoutError') {
    return new AnalysisError(C.TIMEOUT, { detail: code });
  }
  if (TLS_CODE.test(code) || /certificate|ssl|tls/i.test(err?.message ?? '')) {
    return new AnalysisError(C.TLS_ERROR, { detail: code || 'tls' });
  }
  if (CONNECTION_CODES.has(code)) return new AnalysisError(C.CONNECTION_ERROR, { detail: code });
  if (code.startsWith('HPE_') || code === 'Z_DATA_ERROR' || code === 'Z_BUF_ERROR') {
    return new AnalysisError(C.INVALID_RESPONSE, { detail: code });
  }
  if (err?.name === 'AbortError') return new AnalysisError(C.TIMEOUT, { detail: 'aborted' });
  return new AnalysisError(C.CONNECTION_ERROR, { detail: code || err?.name || 'network' });
};

const headerValue = (headers, name) => {
  const value = headers?.[name];
  return Array.isArray(value) ? value[0] : (value ?? null);
};

const parseContentType = (raw) => {
  if (!raw) return { mime: null, charset: null };
  const [mime, ...params] = String(raw).split(';');
  const charset = params.map((p) => p.trim().match(/^charset\s*=\s*"?([\w.:-]+)"?$/i)?.[1]).find(Boolean);
  return { mime: mime.trim().toLowerCase() || null, charset: charset?.toLowerCase() ?? null };
};

const decoderFor = (encoding) => {
  switch ((encoding ?? '').trim().toLowerCase()) {
    case '':
    case 'identity':
      return null;
    case 'gzip':
    case 'x-gzip':
      return zlib.createGunzip();
    case 'deflate':
      return zlib.createInflate();
    case 'br':
      return zlib.createBrotliDecompress();
    default:
      throw new AnalysisError(C.INVALID_RESPONSE, { detail: 'content-encoding' });
  }
};

const destroyQuietly = (stream) => {
  try {
    stream?.destroy?.();
  } catch {
    // already closed
  }
};

/**
 * Reads at most `maxBytes` of decompressed body. Over the limit it either stops early
 * (`truncate`) or rejects with RESPONSE_TOO_LARGE; a gzip bomb therefore never inflates
 * past the cap. The abort signal destroys the stream so a slow body cannot hang.
 */
const readBody = async (raw, encoding, { maxBytes, truncate, signal }) => {
  const decoder = decoderFor(encoding);
  const stream = decoder ?? raw;
  if (decoder) {
    raw.on('error', (err) => decoder.destroy(err));
    raw.pipe(decoder);
  }
  const onAbort = () => stream.destroy(signal.reason ?? new Error('aborted'));
  signal.addEventListener('abort', onAbort, { once: true });

  const chunks = [];
  let size = 0;
  let truncated = false;
  try {
    if (signal.aborted) onAbort();
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (size + buffer.length > maxBytes) {
        if (!truncate) throw new AnalysisError(C.RESPONSE_TOO_LARGE);
        chunks.push(buffer.subarray(0, maxBytes - size));
        size = maxBytes;
        truncated = true;
        break;
      }
      size += buffer.length;
      chunks.push(buffer);
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    destroyQuietly(stream);
    destroyQuietly(raw);
  }
  return { buffer: Buffer.concat(chunks, size), truncated };
};

const decodeText = (buffer, charset, mime) => {
  let label = charset;
  if (!label && mime && /html/.test(mime)) {
    const head = buffer.subarray(0, 2048).toString('latin1');
    label = head.match(/<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i)?.[1]?.toLowerCase() ?? null;
  }
  try {
    return new TextDecoder(label || 'utf-8', { fatal: false }).decode(buffer);
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(buffer);
  }
};

/**
 * Creates `fetchUrl(url, options)`. Redirects are followed manually: every hop is checked
 * with assertSafeUrl and resolved through the SSRF-safe resolver before connecting.
 * Non-2xx responses are returned (not thrown) so callers decide what a 404 means.
 *
 * Options: accept (Accept header), maxBytes, truncate, isWantedType(mime) -> boolean
 * (bodies of other types are never downloaded), signal.
 *
 * Throws AnalysisError; `err.partial` carries what was learned before the failure
 * (final URL, redirect count, HTTP status) without any network internals.
 */
export const createWebsiteFetcher = ({
  resolve = createSafeResolver(),
  transport = nodeTransport,
  userAgent = websiteAnalysisConfig.userAgent,
  timeoutMs = websiteAnalysisConfig.request.timeoutMs,
  maxRedirects = websiteAnalysisConfig.request.maxRedirects,
  now = () => Date.now(),
} = {}) => {
  const fetchUrl = async (
    input,
    { accept = '*/*', maxBytes, truncate = false, isWantedType = () => true, signal: outerSignal } = {},
  ) => {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new AnalysisError(C.TIMEOUT)), timeoutMs);
    const signal = outerSignal ? AbortSignal.any([timeout.signal, outerSignal]) : timeout.signal;
    const started = now();
    const chain = [];
    let current;
    try {
      current = input instanceof URL ? new URL(input.href) : new URL(String(input));
    } catch {
      clearTimeout(timer);
      throw new AnalysisError(C.INVALID_URL);
    }
    const partial = () => ({ finalUrl: current.href, redirectCount: chain.length, redirectChain: [...chain] });

    try {
      for (;;) {
        assertSafeUrl(current);
        const { address, family } = await resolve(current.hostname);
        if (signal.aborted) throw signal.reason;

        const response = await transport({
          url: current,
          address,
          family,
          signal,
          headers: {
            'User-Agent': userAgent,
            Accept: accept,
            'Accept-Encoding': 'gzip, deflate, br',
            'Accept-Language': 'en;q=0.9, *;q=0.5',
          },
        });
        const status = Number(response.status);
        const location = headerValue(response.headers, 'location');

        if (REDIRECT_STATUSES.has(status) && location) {
          destroyQuietly(response.body);
          let next;
          try {
            next = new URL(location, current);
          } catch {
            throw new AnalysisError(C.INVALID_RESPONSE, { httpStatus: status, detail: 'location' });
          }
          next.hash = '';
          chain.push(current.href);
          if (chain.includes(next.href)) throw new AnalysisError(C.REDIRECT_LOOP, { httpStatus: status });
          if (chain.length > maxRedirects) throw new AnalysisError(C.TOO_MANY_REDIRECTS, { httpStatus: status });
          current = next;
          continue;
        }

        const responseTimeMs = Math.max(0, now() - started);
        const { mime, charset } = parseContentType(headerValue(response.headers, 'content-type'));
        const declared = Number(headerValue(response.headers, 'content-length'));
        const result = {
          url: input instanceof URL ? input.href : String(input),
          finalUrl: current.href,
          status,
          headers: response.headers ?? {},
          contentType: mime,
          redirectCount: chain.length,
          redirectChain: [...chain],
          responseTimeMs,
          body: null,
          bytes: 0,
          truncated: false,
        };
        if (!isWantedType(mime)) {
          destroyQuietly(response.body);
          return { ...result, skippedBody: true };
        }
        if (!truncate && Number.isFinite(declared) && declared > maxBytes) {
          destroyQuietly(response.body);
          throw new AnalysisError(C.RESPONSE_TOO_LARGE, { httpStatus: status });
        }
        const { buffer, truncated } = await readBody(
          response.body,
          headerValue(response.headers, 'content-encoding'),
          { maxBytes, truncate, signal },
        );
        return { ...result, body: decodeText(buffer, charset, mime), bytes: buffer.length, truncated };
      }
    } catch (err) {
      const reason = timeout.signal.aborted ? timeout.signal.reason : null;
      const error = reason instanceof AnalysisError ? reason : classifyNetworkError(err);
      error.partial = { ...partial(), ...(error.httpStatus ? { httpStatus: error.httpStatus } : {}) };
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };

  return { fetchUrl };
};
