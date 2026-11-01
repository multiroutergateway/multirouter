/**
 * Cloudflare Pages Function — same-origin API proxy for FreeFirst AI.
 *
 * The browser only ever talks to the Pages origin (https://<project>.pages.dev).
 * Every /api/* request is forwarded here, server-side, to BACKEND_ORIGIN, which is
 * a Pages environment binding/secret. BACKEND_ORIGIN is never serialised into a
 * response, never inlined into the bundle, and never readable by browser JS.
 *
 * Design notes (see docs/CLOUDFLARE-PAGES-TENCENT-DEPLOYMENT.md):
 *   - The request path is forwarded verbatim. Nothing is rewritten, so the backend
 *     keeps serving its existing /api/... routes unchanged.
 *   - SSE works because the upstream ReadableStream is handed straight to the
 *     response. The stream is never read into memory, so tokens reach the browser
 *     as they are produced and client disconnects propagate upstream.
 *   - Hop-by-hop headers are stripped in both directions (RFC 9110 §7.6.1).
 *   - Identity headers a browser could forge (X-User-ID and friends) are stripped
 *     on the way in. The backend derives identity from the validated session only.
 *   - No CORS relaxation happens here. The proxy is same-origin by construction, so
 *     no Access-Control-* header is added.
 *   - Nothing sensitive is logged. Passwords, JWTs, cookies and API keys never reach
 *     a log line; the optional debug line contains method, path and status only.
 */

/** Hop-by-hop headers — valid for a single transport hop, never forwarded. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/**
 * Request headers that must not be forwarded:
 * hop-by-hop ones, transport framing (recomputed by fetch), Cloudflare-internal
 * headers, and every identity header a browser could use to impersonate a user.
 */
const DROP_REQUEST_HEADERS = new Set([
  ...HOP_BY_HOP,
  'host',
  'content-length',
  'accept-encoding',
  'cdn-loop',
  'x-forwarded-for',
  'x-forwarded-proto',
  'x-forwarded-host',
  'x-real-ip',
  // Forgeable identity / authorisation headers. The backend must never see these
  // coming from an untrusted client, so the proxy removes them outright.
  'x-user-id',
  'x-userid',
  'x-user',
  'x-forwarded-user',
  'x-auth-user',
  'x-auth-request-user',
  'x-role',
  'x-user-role',
  'x-admin',
  'x-is-admin',
]);

/** Response headers that must not be forwarded back to the browser. */
const DROP_RESPONSE_HEADERS = new Set([...HOP_BY_HOP, 'content-length']);

/** Non-streaming API calls should fail fast rather than hang the UI. */
const DEFAULT_TIMEOUT_MS = 30_000;
/** Chat completions stream for a long time; allow up to 5 minutes. */
const STREAM_TIMEOUT_MS = 300_000;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Parses and validates BACKEND_ORIGIN.
 * Returns { base } on success or { error } where error is one of
 * 'missing' | 'invalid' | 'insecure'.
 *
 * Plain http is rejected for anything that is not loopback: auth traffic and
 * session cookies must never cross the network unencrypted.
 */
export function parseBackendOrigin(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return { error: 'missing' };

  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    return { error: 'invalid' };
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { error: 'invalid' };
  if (url.search || url.hash) return { error: 'invalid' };
  if (url.protocol === 'http:' && !LOOPBACK_HOSTS.has(url.hostname)) return { error: 'insecure' };

  // Optional path prefix (e.g. a tunnel mounted under /ff). Trailing slashes are
  // normalised away so prefix + pathname never produces a double slash.
  const prefix = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
  return { base: { origin: url.origin, prefix } };
}

/** True when the request is expected to answer with a long-lived SSE stream. */
function isStreamRequest(pathname, headers) {
  if (/\/chat$/.test(pathname)) return true;
  const accept = headers.get('accept') || '';
  return accept.includes('text/event-stream');
}

function errorResponse(status, code, message) {
  return new Response(JSON.stringify({ error: code, message }), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'cdn-cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

/**
 * Minimal, secret-free diagnostics. Only enabled when PROXY_LOG === '1'.
 * Method + pathname + status only: no query string, no headers, no body.
 */
function debugLog(env, method, pathname, status) {
  if (!env || env.PROXY_LOG !== '1') return;
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ proxy: 'pages-functions', method, pathname, status }));
}

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);

  // Defence in depth: only /api/* belongs to this Function. _routes.json already
  // restricts invocation, but a stray invocation falls through to static assets.
  if (url.pathname !== '/api' && !url.pathname.startsWith('/api/')) {
    return typeof next === 'function' ? next() : errorResponse(404, 'not_found', 'Not found.');
  }

  const parsed = parseBackendOrigin(env && env.BACKEND_ORIGIN);
  if (parsed.error === 'missing') {
    debugLog(env, request.method, url.pathname, 500);
    return errorResponse(
      500,
      'backend_origin_not_configured',
      'The API proxy is not configured. Set the BACKEND_ORIGIN environment binding for this Pages project.',
    );
  }
  if (parsed.error === 'insecure') {
    debugLog(env, request.method, url.pathname, 500);
    return errorResponse(
      500,
      'backend_origin_insecure',
      'BACKEND_ORIGIN must use https. Unencrypted http is only allowed for loopback development.',
    );
  }
  if (parsed.error === 'invalid') {
    debugLog(env, request.method, url.pathname, 500);
    return errorResponse(500, 'backend_origin_invalid', 'BACKEND_ORIGIN is not a valid absolute URL.');
  }

  const { base } = parsed;

  // Forward the path verbatim. Do not rewrite /api/*.
  const target = new URL(`${base.prefix}${url.pathname}${url.search}`, base.origin);

  // ---- request headers -----------------------------------------------------
  const forwardHeaders = new Headers();
  for (const [key, value] of request.headers) {
    const lower = key.toLowerCase();
    if (DROP_REQUEST_HEADERS.has(lower)) continue;
    if (lower.startsWith('cf-')) continue;
    forwardHeaders.set(key, value);
  }

  // Rebuild the forwarding chain from Cloudflare's own view of the client.
  const clientIp = request.headers.get('cf-connecting-ip');
  if (clientIp) {
    forwardHeaders.set('x-forwarded-for', clientIp);
    forwardHeaders.set('x-real-ip', clientIp);
  }
  forwardHeaders.set('x-forwarded-proto', url.protocol.replace(':', ''));
  forwardHeaders.set('x-forwarded-host', url.host);

  // ---- request body --------------------------------------------------------
  // API payloads are JSON and capped at 256 kB by the backend. Reading the body
  // here (instead of forwarding the ReadableStream) keeps the proxy portable
  // across the Workers runtime and Node, and avoids request-side framing bugs.
  const method = request.method.toUpperCase();
  let body;
  if (method !== 'GET' && method !== 'HEAD') {
    const buffer = await request.arrayBuffer();
    if (buffer.byteLength > 0) body = buffer;
  }

  // ---- upstream call -------------------------------------------------------
  const timeoutSignal = AbortSignal.timeout(
    isStreamRequest(url.pathname, request.headers) ? STREAM_TIMEOUT_MS : DEFAULT_TIMEOUT_MS,
  );
  // Combine client-disconnect with the timeout. AbortSignal.any is present on the
  // Workers runtime and on Node >= 20; the guard keeps a missing helper from
  // turning every request into a 500 at the cost of disconnect propagation.
  const signal = request.signal && typeof AbortSignal.any === 'function'
    ? AbortSignal.any([request.signal, timeoutSignal])
    : timeoutSignal;

  let upstream;
  try {
    upstream = await fetch(target.toString(), {
      method,
      headers: forwardHeaders,
      body,
      redirect: 'manual',
      signal,
    });
  } catch {
    if (request.signal && request.signal.aborted) {
      debugLog(env, method, url.pathname, 499);
      return new Response(null, { status: 499 });
    }
    if (timeoutSignal.aborted) {
      debugLog(env, method, url.pathname, 504);
      return errorResponse(504, 'backend_timeout', 'The backend did not respond in time.');
    }
    debugLog(env, method, url.pathname, 502);
    return errorResponse(
      502,
      'backend_unreachable',
      'The API backend is currently unreachable. Please try again shortly.',
    );
  }

  // ---- response headers ----------------------------------------------------
  const responseHeaders = new Headers();
  for (const [key, value] of upstream.headers) {
    const lower = key.toLowerCase();
    if (DROP_RESPONSE_HEADERS.has(lower)) continue;
    responseHeaders.set(key, value);
  }

  // API responses are per-user and never cacheable at the edge.
  responseHeaders.set('cache-control', 'no-store');
  responseHeaders.set('cdn-cache-control', 'no-store');

  debugLog(env, method, url.pathname, upstream.status);

  // Streaming passthrough: the upstream body is handed over untouched, so SSE
  // frames are delivered as they arrive instead of being buffered to completion.
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}
