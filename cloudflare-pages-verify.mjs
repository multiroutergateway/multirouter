#!/usr/bin/env node
/**
 * Cloudflare Pages staging verification — FreeFirst AI.
 *
 * What this proves (locally, with mocks):
 *   - the frontend still builds to a static bundle with PWA assets intact;
 *   - _routes.json restricts Pages Functions to /api/* only, so static assets and
 *     SPA routes are never billed as Function invocations;
 *   - functions/api/[[path]].js forwards method, path, query, body, Authorization
 *     and cookies to BACKEND_ORIGIN and passes status + headers back;
 *   - SSE responses stream through incrementally and a client disconnect
 *     propagates to the origin;
 *   - misconfiguration and upstream failures produce explicit errors;
 *   - no secret (BACKEND_ORIGIN, DB URL, JWT secret, admin token) leaks into the
 *     bundle, the proxy responses, or the proxy logs.
 *
 * What this does NOT prove: that Cloudflare Pages is reachable, that the Pages
 * project exists, or that a Tencent Lighthouse origin answers. Those require a
 * real deployment and are reported as NOT TESTED in the implementation report.
 *
 * Usage: node scripts/cloudflare-pages-verify.mjs [--skip-build]
 * Exit:  0 = all executed assertions passed, 1 = at least one failure.
 */

import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FRONTEND = join(ROOT, 'apps', 'frontend');
const DIST = join(FRONTEND, 'dist');
const FUNCTIONS_FILE = join(ROOT, 'functions', 'api', '[[path]].js');
const SKIP_BUILD = process.argv.includes('--skip-build');

// The logical public origin used for simulated requests. Pages terminates TLS and
// invokes the Function with an https URL, so the proxy must see https here too.
const PAGES_ORIGIN = 'https://freefirst-ai.pages.dev';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}${detail ? `  [${detail}]` : ''}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? `  [${detail}]` : ''}`);
  }
  return ok;
}

function section(title) {
  console.log(`\n${title}`);
}

const read = (p) => readFileSync(p, 'utf8');
const exists = (p) => existsSync(p);

// ---------------------------------------------------------------------------
// 1. Frontend build
// ---------------------------------------------------------------------------
section('1. Frontend build (vite build -> apps/frontend/dist)');

if (SKIP_BUILD) {
  check('build skipped by flag', exists(join(DIST, 'index.html')), 'using existing dist');
} else {
  const build = spawnSync('npm', ['run', 'build'], {
    cwd: ROOT,
    shell: true,
    encoding: 'utf8',
    timeout: 240_000,
  });
  check(
    'npm run build exits 0',
    build.status === 0,
    `exit=${build.status}`,
  );
  if (build.status !== 0) {
    console.log((build.stdout || '').split('\n').slice(-25).join('\n'));
    console.log((build.stderr || '').split('\n').slice(-25).join('\n'));
  }
}

const indexHtmlPath = join(DIST, 'index.html');
check('dist/index.html exists', exists(indexHtmlPath));
const indexHtml = exists(indexHtmlPath) ? read(indexHtmlPath) : '';

const assetDir = join(DIST, 'assets');
const assets = exists(assetDir) ? readdirSync(assetDir) : [];
const jsAssets = assets.filter((f) => f.endsWith('.js'));
const cssAssets = assets.filter((f) => f.endsWith('.css'));
check('hashed JS bundle emitted', jsAssets.length >= 1, `${jsAssets.length} file(s)`);
check('hashed CSS bundle emitted', cssAssets.length >= 1, `${cssAssets.length} file(s)`);

check('PWA service worker emitted', exists(join(DIST, 'sw.js')));
check('PWA manifest emitted', exists(join(DIST, 'manifest.webmanifest')));
check('PWA icons emitted', exists(join(DIST, 'icons')) && readdirSync(join(DIST, 'icons')).length > 0);

check('index.html loads assets from relative /assets/', /(src|href)="\/assets\//.test(indexHtml));

// ---------------------------------------------------------------------------
// 2. Routing contract (_routes.json)
// ---------------------------------------------------------------------------
section('2. Routing contract (_routes.json + functions layout)');

const routesPath = join(DIST, '_routes.json');
check('_routes.json present in build output', exists(routesPath));

let routes = null;
if (exists(routesPath)) {
  try {
    routes = JSON.parse(read(routesPath));
  } catch {
    routes = null;
  }
}
check('_routes.json is valid JSON', routes !== null);
check('_routes.json version is 1', routes?.version === 1, `version=${routes?.version}`);
check(
  '_routes.json includes /api and /api/*',
  Array.isArray(routes?.include) && routes.include.includes('/api') && routes.include.includes('/api/*'),
  JSON.stringify(routes?.include),
);
check(
  '_routes.json include list is API-only (no catch-all)',
  Array.isArray(routes?.include) && routes.include.every((p) => p === '/api' || p.startsWith('/api/')),
  JSON.stringify(routes?.include),
);

check('functions/api/[[path]].js exists', exists(FUNCTIONS_FILE));

const functionsDir = join(ROOT, 'functions');
function listFunctions(dir, acc = []) {
  if (!exists(dir)) return acc;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) listFunctions(full, acc);
    else acc.push(full);
  }
  return acc;
}
const functionFiles = listFunctions(functionsDir);
check(
  'only the API catch-all Function is declared',
  functionFiles.length === 1 && functionFiles[0] === FUNCTIONS_FILE,
  functionFiles.map((f) => f.slice(ROOT.length + 1)).join(', '),
);

// Route matcher mirroring Pages semantics: exclude wins over include.
function toRegExp(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}
const includeRules = (routes?.include || []).map(toRegExp);
const excludeRules = (routes?.exclude || []).map(toRegExp);
function functionMatches(pathname) {
  if (excludeRules.some((r) => r.test(pathname))) return false;
  return includeRules.some((r) => r.test(pathname));
}

check('/api/chat invokes the Function', functionMatches('/api/chat'));
check('/api/health invokes the Function', functionMatches('/api/health'));
check('/api (bare) invokes the Function', functionMatches('/api'));
check('/index.html stays static', !functionMatches('/index.html'));
check('/assets/*.js stays static', !functionMatches(`/assets/${jsAssets[0] || 'index.js'}`));
check('/settings (SPA deep link) stays static', !functionMatches('/settings'));
check('/manifest.webmanifest stays static', !functionMatches('/manifest.webmanifest'));
check('/sw.js stays static', !functionMatches('/sw.js'));

const redirectsPath = join(DIST, '_redirects');
const redirectsText = exists(redirectsPath) ? read(redirectsPath) : '';
check('_redirects present in build output', exists(redirectsPath));
check(
  '_redirects provides SPA fallback to /index.html 200',
  /^\s*\/\*\s+\/index\.html\s+200\s*$/m.test(redirectsText),
);

// --- _headers: the CSP and security headers the container edge used to add ---
const headersPath = join(DIST, '_headers');
const headersText = exists(headersPath) ? read(headersPath) : '';
check('_headers present in build output', exists(headersPath));

function parseHeadersFile(text) {
  const rules = [];
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    if (/^\s/.test(raw)) {
      const idx = raw.indexOf(':');
      if (idx === -1 || !current) continue;
      current.headers.push([raw.slice(0, idx).trim(), raw.slice(idx + 1).trim()]);
    } else {
      current = { pattern: raw.trim(), regex: toRegExp(raw.trim()), headers: [] };
      rules.push(current);
    }
  }
  return rules;
}
const headerRules = parseHeadersFile(headersText);
function headersFor(pathname) {
  const out = {};
  for (const rule of headerRules) {
    if (!rule.regex.test(pathname)) continue;
    for (const [k, v] of rule.headers) out[k.toLowerCase()] = v;
  }
  return out;
}
check('_headers parsed into rules', headerRules.length >= 2, `${headerRules.length} rule(s)`);

// ---------------------------------------------------------------------------
// 3. Load the Function module
// ---------------------------------------------------------------------------
section('3. Function module loads as ESM');

// The repo is CJS-by-default, so copy the Function to a temp .mjs to import it.
const tempDir = mkdtempSync(join(tmpdir(), 'ff-pages-verify-'));
let onRequest = null;
let parseBackendOrigin = null;
let importError = null;
try {
  const tempModule = join(tempDir, 'pages-function.mjs');
  writeFileSync(tempModule, read(FUNCTIONS_FILE), 'utf8');
  const mod = await import(pathToFileURL(tempModule).href);
  onRequest = mod.onRequest;
  parseBackendOrigin = mod.parseBackendOrigin;
} catch (err) {
  importError = err;
}
check('Function module imports', typeof onRequest === 'function', importError ? importError.message : '');
check('exports onRequest handler', typeof onRequest === 'function');

if (typeof onRequest !== 'function') {
  console.log('\nAborting: the Function could not be loaded.');
  rmSync(tempDir, { recursive: true, force: true });
  process.exit(1);
}

check('rejects missing BACKEND_ORIGIN', parseBackendOrigin('')?.error === 'missing');
check('rejects unparseable BACKEND_ORIGIN', parseBackendOrigin('not a url')?.error === 'invalid');
check('rejects plain-http remote origin', parseBackendOrigin('http://api.example.com')?.error === 'insecure');
check('accepts https origin', Boolean(parseBackendOrigin('https://api.example.com')?.base));
check('accepts loopback http for dev', Boolean(parseBackendOrigin('http://127.0.0.1:3001')?.base));

// ---------------------------------------------------------------------------
// 4. Mock origin (stands in for Tencent Lighthouse)
// ---------------------------------------------------------------------------
const originLog = [];
let sseClosedEarly = false;

const origin = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString('utf8');

  originLog.push({
    method: req.method,
    pathname: url.pathname,
    query: url.search,
    headers: req.headers,
    body,
  });

  if (url.pathname === '/api/chat') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-router-route': 'free-tier',
      'x-router-tier': 'free',
      'x-conversation-id': 'conv-1',
    });
    res.flushHeaders?.();
    let i = 0;
    const timer = setInterval(() => {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `t${i}` } }] })}\n\n`);
      i += 1;
      if (i >= 5) {
        clearInterval(timer);
        res.write('data: [DONE]\n\n');
        res.end();
      }
    }, 40);
    res.on('close', () => {
      if (!res.writableEnded) sseClosedEarly = true;
      clearInterval(timer);
    });
    return;
  }

  if (url.pathname === '/api/boom') {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'unavailable', message: 'mock outage' }));
    return;
  }

  res.writeHead(200, {
    'content-type': 'application/json',
    'x-origin': 'mock-lighthouse',
    // A hop-by-hop header the proxy must strip. `keep-alive` is unusable here:
    // Node's own HTTP layer adds it to every response, so it would always appear.
    'proxy-authenticate': 'Basic realm="mock"',
  });
  res.end(
    JSON.stringify({
      method: req.method,
      pathname: url.pathname,
      query: url.search,
      body,
      seen: {
        authorization: req.headers.authorization ?? null,
        cookie: req.headers.cookie ?? null,
        contentType: req.headers['content-type'] ?? null,
        connection: req.headers.connection ?? null,
        te: req.headers.te ?? null,
        keepAlive: req.headers['keep-alive'] ?? null,
        userHeader: req.headers['x-user-id'] ?? null,
        forwardedFor: req.headers['x-forwarded-for'] ?? null,
        forwardedProto: req.headers['x-forwarded-proto'] ?? null,
        forwardedHost: req.headers['x-forwarded-host'] ?? null,
      },
    }),
  );
});

await new Promise((r) => origin.listen(0, '127.0.0.1', r));
const originPort = origin.address().port;
const BACKEND_ORIGIN = `http://127.0.0.1:${originPort}`;

// ---------------------------------------------------------------------------
// 5. Pages simulator: static assets + SPA fallback + Function invocation
// ---------------------------------------------------------------------------
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

let functionInvocations = 0;

function serveStatic(pathname, res) {
  const decoded = decodeURIComponent(pathname);
  const candidate = resolve(DIST, `.${decoded}`);
  if (!candidate.startsWith(DIST + sep) && candidate !== DIST) {
    res.writeHead(403).end('forbidden');
    return true;
  }
  const extra = headersFor(pathname);
  if (exists(candidate) && statSync(candidate).isFile()) {
    res.writeHead(200, { 'content-type': CONTENT_TYPES[extname(candidate)] || 'application/octet-stream', ...extra });
    res.end(readFileSync(candidate));
    return true;
  }
  if (/^\s*\/\*\s+\/index\.html\s+200\s*$/m.test(redirectsText)) {
    res.writeHead(200, { 'content-type': CONTENT_TYPES['.html'], ...extra });
    res.end(readFileSync(join(DIST, 'index.html')));
    return true;
  }
  res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  return true;
}

const pages = createServer(async (req, res) => {
  const pathname = new URL(req.url, PAGES_ORIGIN).pathname;

  if (!functionMatches(pathname)) {
    serveStatic(pathname, res);
    return;
  }

  functionInvocations += 1;

  // Mirror Pages: the Function receives an https request; a client disconnect
  // aborts the request signal so the upstream call is cancelled too.
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  let bodyChunks;
  try {
    bodyChunks = [];
    for await (const chunk of req) bodyChunks.push(chunk);
  } catch {
    return; // client disappeared before the body was complete
  }

  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) headers.set(k, v.join(', '));
    else headers.set(k, v);
  }

  const request = new Request(`${PAGES_ORIGIN}${req.url}`, {
    method: req.method,
    headers,
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(bodyChunks),
    signal: controller.signal,
  });

  let response;
  try {
    response = await onRequest({
      request,
      env: { BACKEND_ORIGIN },
      params: { path: pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean) },
      next: () => new Response('next', { status: 404 }),
      data: {},
    });
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain' }).end(`proxy threw: ${err.message}`);
    return;
  }

  const outHeaders = {};
  for (const [k, v] of response.headers) outHeaders[k] = v;
  if (res.destroyed || res.writableEnded) return; // client vanished mid-flight
  res.writeHead(response.status, outHeaders);
  res.flushHeaders?.();

  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (res.destroyed || res.writableEnded) break;
      res.write(Buffer.from(value));
    }
  } catch {
    // Expected when the client aborts: the upstream stream is cancelled and the
    // read rejects. The origin already observed the disconnect.
  }
  if (!res.destroyed && !res.writableEnded) res.end();
});

await new Promise((r) => pages.listen(0, '127.0.0.1', r));
const pagesPort = pages.address().port;
const PAGES = `http://127.0.0.1:${pagesPort}`;

// ---------------------------------------------------------------------------
// 6. Static assets + SPA routing through the simulator
// ---------------------------------------------------------------------------
section('4. Static assets and SPA routing');

functionInvocations = 0;

const rootRes = await fetch(`${PAGES}/`);
const rootBody = await rootRes.text();
check('GET / returns 200', rootRes.status === 200, `status=${rootRes.status}`);
check('GET / serves the app shell', /<div id="root">/.test(rootBody));
check('GET / sets an html content-type', (rootRes.headers.get('content-type') || '').includes('text/html'));

// CSP parity with the container edge (deploy/nginx-freefirst.conf).
const csp = rootRes.headers.get('content-security-policy') || '';
check('CSP header served on static responses', csp.includes("default-src 'self'"), csp.slice(0, 48));
check("CSP keeps connect-src 'self' (same-origin /api only)", /connect-src\s+'self'/.test(csp));
check("CSP keeps script-src 'self'", /script-src\s+'self'/.test(csp));
check(
  "CSP keeps object-src 'none' and frame-ancestors 'none'",
  /object-src\s+'none'/.test(csp) && /frame-ancestors\s+'none'/.test(csp),
);
check('X-Content-Type-Options nosniff served', rootRes.headers.get('x-content-type-options') === 'nosniff');
check('X-Frame-Options DENY served', rootRes.headers.get('x-frame-options') === 'DENY');

const jsRes = await fetch(`${PAGES}/assets/${jsAssets[0]}`);
check('GET /assets/*.js returns 200', jsRes.status === 200, `status=${jsRes.status}`);
check(
  'GET /assets/*.js serves javascript',
  (jsRes.headers.get('content-type') || '').includes('javascript'),
  jsRes.headers.get('content-type') || '',
);
await jsRes.arrayBuffer();
check(
  'hashed assets are cached immutably',
  (jsRes.headers.get('cache-control') || '').includes('immutable'),
  jsRes.headers.get('cache-control') || '',
);

const deepRes = await fetch(`${PAGES}/settings`);
const deepBody = await deepRes.text();
check('SPA deep link /settings returns 200', deepRes.status === 200, `status=${deepRes.status}`);
check('SPA deep link serves index.html', /<div id="root">/.test(deepBody));

const manifestRes = await fetch(`${PAGES}/manifest.webmanifest`);
check('manifest.webmanifest returns 200', manifestRes.status === 200, `status=${manifestRes.status}`);
await manifestRes.arrayBuffer();

const swRes = await fetch(`${PAGES}/sw.js`);
check('sw.js returns 200', swRes.status === 200, `status=${swRes.status}`);
await swRes.arrayBuffer();
check(
  'service worker is served no-cache',
  (swRes.headers.get('cache-control') || '') === 'no-cache',
  swRes.headers.get('cache-control') || '',
);

check(
  'static + SPA requests never invoke the Function',
  functionInvocations === 0,
  `invocations=${functionInvocations}`,
);

// ---------------------------------------------------------------------------
// 7. API proxy behaviour
// ---------------------------------------------------------------------------
section('5. API proxy forwarding');

const healthRes = await fetch(`${PAGES}/api/health`);
const healthBody = await healthRes.json();
check('GET /api/health routed through Function', healthRes.status === 200, `status=${healthRes.status}`);
check('GET /api/health reached the origin', healthBody.pathname === '/api/health', healthBody.pathname);
check('origin response header passed through', healthRes.headers.get('x-origin') === 'mock-lighthouse');
check(
  'proxy forces cache-control: no-store',
  (healthRes.headers.get('cache-control') || '').includes('no-store'),
  healthRes.headers.get('cache-control') || '',
);
check(
  'proxy sets cdn-cache-control: no-store',
  (healthRes.headers.get('cdn-cache-control') || '') === 'no-store',
);
check('hop-by-hop response header stripped (proxy-authenticate)', healthRes.headers.get('proxy-authenticate') === null);

const qsRes = await fetch(`${PAGES}/api/models?limit=5&cursor=a%20b&empty=`);
const qsBody = await qsRes.json();
check('query string forwarded verbatim', qsBody.query === '?limit=5&cursor=a%20b&empty=', qsBody.query);
check('path not rewritten', qsBody.pathname === '/api/models', qsBody.pathname);

const postRes = await fetch(`${PAGES}/api/chat`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    authorization: 'Bearer test.jwt.token',
    cookie: 'ff_session=abc123; theme=dark',
    // `connection: close` is a marker: undici would never send that value itself,
    // so seeing it at the origin would prove the proxy forwarded it verbatim.
    connection: 'close',
    te: 'trailers',
    'proxy-authorization': 'Basic abc123',
    'x-user-id': '999999',
  },
  body: JSON.stringify({ messages: [{ role: 'user', content: 'halo' }], stream: false }),
});
// This request hits the SSE branch (path /api/chat); drain it.
await postRes.text();

const postEntry = originLog.filter((e) => e.method === 'POST').pop();
check('POST method forwarded', postEntry?.method === 'POST', postEntry?.method);
check(
  'POST body forwarded byte-for-byte',
  postEntry?.body === JSON.stringify({ messages: [{ role: 'user', content: 'halo' }], stream: false }),
);
check('content-type forwarded', postEntry?.headers['content-type'] === 'application/json');
check('Authorization header forwarded', postEntry?.headers.authorization === 'Bearer test.jwt.token');
check('cookie header forwarded', postEntry?.headers.cookie === 'ff_session=abc123; theme=dark');
check('hop-by-hop connection header stripped', postEntry?.headers.connection !== 'close', String(postEntry?.headers.connection));
check('hop-by-hop te header stripped', postEntry?.headers.te === undefined, String(postEntry?.headers.te));
check('hop-by-hop proxy-authorization header stripped', postEntry?.headers['proxy-authorization'] === undefined, String(postEntry?.headers['proxy-authorization']));
check('spoofed x-user-id stripped', postEntry?.headers['x-user-id'] === undefined, String(postEntry?.headers['x-user-id']));
check('x-forwarded-proto set to https', postEntry?.headers['x-forwarded-proto'] === 'https', postEntry?.headers['x-forwarded-proto']);
check('x-forwarded-host set to the Pages host', postEntry?.headers['x-forwarded-host'] === 'freefirst-ai.pages.dev', postEntry?.headers['x-forwarded-host']);

const errRes = await fetch(`${PAGES}/api/boom`);
const errBody = await errRes.json();
check('upstream error status passed through', errRes.status === 503, `status=${errRes.status}`);
check('upstream error body passed through', errBody.error === 'unavailable', errBody.error);

// ---------------------------------------------------------------------------
// 8. SSE streaming
// ---------------------------------------------------------------------------
section('6. SSE streaming through the proxy');

const sseStart = Date.now();
const sseRes = await fetch(`${PAGES}/api/chat`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer test.jwt.token' },
  body: JSON.stringify({ messages: [], stream: true }),
});
check('SSE returns 200', sseRes.status === 200, `status=${sseRes.status}`);
check(
  'SSE content-type preserved',
  (sseRes.headers.get('content-type') || '').includes('text/event-stream'),
  sseRes.headers.get('content-type') || '',
);
check('router metadata header passed through', sseRes.headers.get('x-router-route') === 'free-tier');
check('SSE response is not content-encoded', sseRes.headers.get('content-encoding') === null);

let sseText = '';
let sseChunks = 0;
let firstChunkAt = 0;
const sseReader = sseRes.body.getReader();
const decoder = new TextDecoder();
for (;;) {
  const { done, value } = await sseReader.read();
  if (done) break;
  if (!firstChunkAt) firstChunkAt = Date.now() - sseStart;
  sseChunks += 1;
  sseText += decoder.decode(value, { stream: true });
}
const sseTotal = Date.now() - sseStart;

check('SSE delivered incrementally (not buffered)', sseChunks >= 2, `chunks=${sseChunks}, first=${firstChunkAt}ms, total=${sseTotal}ms`);
check('SSE first chunk arrived before completion', firstChunkAt > 0 && firstChunkAt < sseTotal, `first=${firstChunkAt}ms total=${sseTotal}ms`);
check('SSE frames intact', (sseText.match(/^data: /gm) || []).length === 6, `frames=${(sseText.match(/^data: /gm) || []).length}`);
check('SSE sentinel preserved', sseText.includes('data: [DONE]'));

// Cancellation: abort mid-stream and confirm the origin saw the disconnect.
sseClosedEarly = false;
const abortController = new AbortController();
const cancelRes = await fetch(`${PAGES}/api/chat`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ messages: [], stream: true }),
  signal: abortController.signal,
});
const cancelReader = cancelRes.body.getReader();
await cancelReader.read();
abortController.abort();
await new Promise((r) => setTimeout(r, 250));
check('client abort propagates to the origin', sseClosedEarly === true, `closedEarly=${sseClosedEarly}`);
try {
  await cancelReader.cancel();
} catch { /* already aborted */ }

// ---------------------------------------------------------------------------
// 9. Error handling and secret leakage
// ---------------------------------------------------------------------------
section('7. Error handling and secret containment');

async function callDirect(url, env, extra = {}) {
  return onRequest({
    request: new Request(`${PAGES_ORIGIN}${url}`, extra),
    env,
    params: {},
    next: () => new Response('next', { status: 404 }),
    data: {},
  });
}

const missing = await callDirect('/api/health', {});
const missingBody = await missing.json();
check('missing BACKEND_ORIGIN -> 500', missing.status === 500, `status=${missing.status}`);
check('missing BACKEND_ORIGIN -> explicit error code', missingBody.error === 'backend_origin_not_configured', missingBody.error);

const insecure = await callDirect('/api/health', { BACKEND_ORIGIN: 'http://api.example.com' });
const insecureBody = await insecure.json();
check('plain-http remote origin -> 500', insecure.status === 500, `status=${insecure.status}`);
check('plain-http remote origin -> insecure error', insecureBody.error === 'backend_origin_insecure', insecureBody.error);

const invalid = await callDirect('/api/health', { BACKEND_ORIGIN: 'http:////' });
check('malformed origin -> 500', invalid.status === 500, `status=${invalid.status}`);

const unreachable = await callDirect('/api/health', { BACKEND_ORIGIN: 'http://127.0.0.1:1' });
const unreachableBody = await unreachable.json();
check('unreachable origin -> 502', unreachable.status === 502, `status=${unreachable.status}`);
check('unreachable origin -> backend_unreachable', unreachableBody.error === 'backend_unreachable', unreachableBody.error);

let nextCalled = false;
await onRequest({
  request: new Request(`${PAGES_ORIGIN}/index.html`),
  env: { BACKEND_ORIGIN },
  params: {},
  next: () => {
    nextCalled = true;
    return new Response('static', { status: 200 });
  },
  data: {},
});
check('non-/api path falls through to next()', nextCalled === true);

// Nothing from the environment may appear in a proxy response.
const allProxyText = [
  JSON.stringify(missingBody),
  JSON.stringify(insecureBody),
  JSON.stringify(unreachableBody),
  healthBody ? JSON.stringify(healthBody) : '',
].join('\n');
check('BACKEND_ORIGIN never echoed to the client', !allProxyText.includes(String(originPort)));

const functionSource = read(FUNCTIONS_FILE);
check(
  'proxy adds no wildcard CORS header',
  !/access-control-allow-origin/i.test(functionSource),
);
check(
  'proxy has at most one console call (redacted debug only)',
  (functionSource.match(/console\.(log|info|warn|error|debug)\s*\(/g) || []).length <= 1,
);
check(
  'debug logging never includes headers or bodies',
  !/console[\s\S]{0,120}(headers|body|cookie|authorization)/i.test(functionSource),
);
check('proxy never buffers the response body', !/await\s+upstream\.(text|json|arrayBuffer)\(\)/.test(functionSource));

// ---------------------------------------------------------------------------
// 10. Secret hygiene in the built bundle
// ---------------------------------------------------------------------------
section('8. Secret hygiene in the built bundle');

const bundleSource = jsAssets.map((f) => read(join(assetDir, f))).join('\n');
const secretPatterns = [
  ['BACKEND_ORIGIN', /BACKEND_ORIGIN/],
  ['trycloudflare hostname', /trycloudflare\.com/i],
  ['dev backend port 3001', /localhost:3001/],
  ['DATABASE_URL', /DATABASE_URL/],
  ['JWT_SECRET', /JWT_SECRET/],
  ['admin token', /ROUTER_ADMIN_TOKEN|ADMIN_TOKEN/],
];
for (const [label, re] of secretPatterns) {
  check(`bundle contains no ${label}`, !re.test(bundleSource));
}
check('bundle contains no postgres connection string', !/postgres(ql)?:\/\//i.test(bundleSource));

// ---------------------------------------------------------------------------
// 11. Frontend integration points
// ---------------------------------------------------------------------------
section('9. Frontend integration points');

const apiSource = read(join(FRONTEND, 'src', 'lib', 'api.js'));
check(
  'health probe uses the /api alias',
  /health:\s*\(\)\s*=>\s*request\('\/api\/health'/.test(apiSource),
);
check('chat streaming posts to /api/chat', /getApiBase\(\)\}\/api\/chat/.test(apiSource));
check(
  'no absolute backend origin in the API client',
  !/https?:\/\/(?!localhost|127\.0\.0\.1)/.test(apiSource.replace(/\/\/.*$/gm, '')),
);
check(
  'API base defaults to same-origin',
  /import\.meta\.env\.VITE_API_BASE\s*\|\|\s*''/.test(apiSource),
);

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------
await new Promise((r) => pages.close(r));
await new Promise((r) => origin.close(r));
rmSync(tempDir, { recursive: true, force: true });

const total = passed + failed;
console.log(`\n${'-'.repeat(64)}`);
console.log(`Assertions: ${total}  |  PASS: ${passed}  |  FAIL: ${failed}`);
if (failed > 0) {
  console.log('Failed assertions:');
  for (const name of failures) console.log(`  - ${name}`);
}
console.log('Scope: local simulation only. Cloudflare Pages and the Tencent origin were NOT contacted.');
console.log(`${'-'.repeat(64)}`);
process.exit(failed === 0 ? 0 : 1);
