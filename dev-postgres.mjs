#!/usr/bin/env node
/**
 * Project-local PostgreSQL for development and verification.
 *
 * Starts a real PostgreSQL server from the binaries shipped by the
 * `embedded-postgres` package (no Docker, no admin rights, no system install).
 * Data lives in `<repo>/.pgdata` and is never shared with any other cluster, so
 * nothing that already exists on the machine is touched.
 *
 * Usage:
 *   node scripts/dev-postgres.mjs start     # initdb (once) + start + ensure databases
 *   node scripts/dev-postgres.mjs status    # is the server running?
 *   node scripts/dev-postgres.mjs stop      # fast shutdown
 *   node scripts/dev-postgres.mjs reset     # stop, delete .pgdata, start fresh (destructive)
 *   node scripts/dev-postgres.mjs version   # binary version + data directory version
 *
 * Connection (matches .env.example defaults and earlier stages):
 *   postgresql://postgres:postgres@127.0.0.1:55432/freefirst_app
 *
 * Environment overrides — these exist so a second cluster (for example a PostgreSQL 17
 * parity run) can be started next to the default one without touching it:
 *   PG_PORT   port on 127.0.0.1 (default 55432)
 *   PG_DATA   data directory    (default <repo>/.pgdata)
 *   PG_BIN    directory holding initdb/pg_ctl/postgres (default the bundled binaries)
 *   PG_USER   superuser name    (default postgres)
 *
 * Safety properties this script guarantees:
 *   - binds to 127.0.0.1 only, never 0.0.0.0 or ::
 *   - never runs `dropdb`, `DROP DATABASE`, or deletes anything outside its own data directory
 *   - refuses `reset` if the data directory is not inside this repository
 *   - serialises `initdb` with a lock file so two concurrent runs cannot corrupt a new cluster
 *   - reports the port actually recorded in `postmaster.pid`, not the port that was requested
 *
 * Security note: `--auth=trust` is used because the server listens on 127.0.0.1
 * only and this cluster exists for tests. It must never be used for anything
 * reachable from another host.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync, unlinkSync, statSync, openSync, closeSync } from 'node:fs';
import { join, resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import pg from 'pg';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.env.PG_DATA ? resolve(process.env.PG_DATA) : join(ROOT, '.pgdata');
const PORT = Number(process.env.PG_PORT || 55432);
const USER = process.env.PG_USER || 'postgres';
const DATABASES = ['freefirst_app', 'freefirst_router'];
const LOCK = `${DATA}.lock`;
const LOCK_STALE_MS = 5 * 60 * 1000;

function binaryDir() {
  if (process.env.PG_BIN) {
    if (!existsSync(process.env.PG_BIN)) {
      throw new Error(`PG_BIN does not exist: ${process.env.PG_BIN}`);
    }
    return process.env.PG_BIN;
  }
  // The bundled binary packages use zonky-style platform names:
  // win32 -> windows, darwin -> darwin, linux -> linux.
  const platform = process.platform === 'win32' ? 'windows' : process.platform;
  const arch = process.arch;
  const pkg = `@embedded-postgres/${platform}-${arch}`;
  const dir = join(ROOT, 'node_modules', pkg, 'native', 'bin');
  if (!existsSync(dir)) {
    throw new Error(
      `PostgreSQL binaries not found at ${dir}.\n` +
        'Run: npm install --no-save embedded-postgres',
    );
  }
  return dir;
}

function exe(name) {
  const suffix = process.platform === 'win32' ? '.exe' : '';
  return join(binaryDir(), `${name}${suffix}`);
}

function run(name, args, opts = {}) {
  const res = spawnSync(exe(name), args, {
    encoding: 'utf8',
    shell: false,
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024,
    ...opts,
  });
  return {
    ok: res.status === 0,
    status: res.status,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    error: res.error,
  };
}

// pg_ctl start/stop must not inherit our stdio: the postmaster keeps the inherited
// handles open, so a piped spawnSync would block until the server exits.
const QUIET = { stdio: 'ignore' };

function isInitialised() {
  return existsSync(join(DATA, 'PG_VERSION'));
}

function dataVersion() {
  try {
    return readFileSync(join(DATA, 'PG_VERSION'), 'utf8').trim();
  } catch {
    return null;
  }
}

function binaryVersion() {
  const res = run('pg_ctl', ['--version']);
  const match = `${res.stdout}${res.stderr}`.match(/(\d+\.\d+(?:\.\d+)?)/);
  return match ? match[1] : null;
}

/**
 * The port the postmaster is actually listening on. `pg_ctl status` only reports
 * "running" for a data directory, so without this a cluster started on a different port
 * would be reported as listening on whatever port this process was asked to use.
 */
function actualPort() {
  try {
    const lines = readFileSync(join(DATA, 'postmaster.pid'), 'utf8').split('\n');
    const port = Number(lines[3]);
    return Number.isFinite(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

function isRunning() {
  if (!isInitialised()) return false;
  const res = run('pg_ctl', ['-D', DATA, 'status'], QUIET);
  return res.ok;
}

function portIsFree(port) {
  return new Promise((done) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.setTimeout(800);
    socket.once('connect', () => { socket.destroy(); done(false); });
    socket.once('timeout', () => { socket.destroy(); done(true); });
    socket.once('error', () => { socket.destroy(); done(true); });
  });
}

// initdb writes a whole cluster into DATA. Two runs racing here can leave a
// half-initialised directory that looks valid (PG_VERSION present) but is not.
function acquireLock() {
  try {
    const fd = openSync(LOCK, 'wx');
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
    return true;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    let age = 0;
    try { age = Date.now() - statSync(LOCK).mtimeMs; } catch { /* vanished */ }
    if (age < LOCK_STALE_MS) {
      throw new Error(
        `another process is initialising ${DATA} (lock: ${LOCK}, age ${Math.round(age / 1000)}s).\n` +
          'Wait for it to finish, or delete the lock if that process is gone.',
      );
    }
    console.warn(`stale initdb lock (${Math.round(age / 1000)}s old) — taking over`);
    writeFileSync(LOCK, String(process.pid));
    return true;
  }
}

function releaseLock() {
  try { unlinkSync(LOCK); } catch { /* already gone */ }
}

function initialise() {
  mkdirSync(DATA, { recursive: true });
  // Trust auth is safe here: listen_addresses is pinned to loopback below and
  // the cluster holds disposable test data only.
  const res = run('initdb', [
    '-D', DATA,
    '-U', USER,
    '--auth=trust',
    '--encoding=UTF8',
    '--locale=C',
  ]);
  if (!res.ok) {
    throw new Error(`initdb failed (${res.status}): ${res.stderr || res.stdout}`);
  }
}

async function waitForReady(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const client = new pg.Client({ host: '127.0.0.1', port, user: USER, password: USER, database: 'postgres' });
    client.on('error', () => {});
    try {
      await client.connect();
      await client.query('SELECT 1');
      await client.end();
      return true;
    } catch {
      await client.end().catch(() => {});
      if (Date.now() > deadline) return false;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

async function start() {
  if (!isInitialised()) {
    console.log(`initdb -> ${DATA}`);
    acquireLock();
    try {
      // Re-check inside the lock: another process may have finished initdb while we waited.
      if (!isInitialised()) initialise();
    } finally {
      releaseLock();
    }
  }

  const clusterVersion = dataVersion();
  const binVersion = binaryVersion();
  // PG_VERSION holds the major version only (e.g. "18"); pg_ctl reports the full one ("18.6").
  if (clusterVersion && binVersion && clusterVersion !== binVersion.split('.')[0]) {
    throw new Error(
      `data directory ${DATA} was created by PostgreSQL ${clusterVersion} but the binaries are ${binVersion}.\n` +
        `Run "node scripts/dev-postgres.mjs reset" to rebuild it, or point PG_BIN/PG_DATA elsewhere.`,
    );
  }

  if (isRunning()) {
    const port = actualPort() ?? PORT;
    console.log(`postgres already running on 127.0.0.1:${port}`);
    return port;
  }

  if (!(await portIsFree(PORT))) {
    throw new Error(
      `port ${PORT} on 127.0.0.1 is already in use by another process.\n` +
        `Pick another port, e.g. PG_PORT=55433 node scripts/dev-postgres.mjs start`,
    );
  }

  const logFile = join(DATA, 'server.log');
  const res = run('pg_ctl', [
    '-D', DATA,
    '-l', logFile,
    '-w', '-t', '60',
    '-o', `-p ${PORT} -c listen_addresses=127.0.0.1 -c fsync=off -c synchronous_commit=off`,
    'start',
  ], QUIET);
  if (!res.ok) {
    const tail = existsSync(logFile) ? readFileSync(logFile, 'utf8').split('\n').slice(-15).join('\n') : '';
    throw new Error(`pg_ctl start failed (${res.status}): ${res.stderr || res.stdout}\n${tail}`);
  }
  // pg_ctl -w only waits for the postmaster, not for connections to be accepted.
  if (!(await waitForReady(PORT))) {
    throw new Error(`postgres started but did not accept connections on 127.0.0.1:${PORT} within 30s`);
  }
  console.log(`postgres ${binVersion} started on 127.0.0.1:${PORT} (data: ${DATA})`);
  return PORT;
}

async function ensureDatabases() {
  const client = new pg.Client({
    host: '127.0.0.1',
    port: actualPort() ?? PORT,
    user: USER,
    password: USER,
    database: 'postgres',
  });
  client.on('error', () => {});
  await client.connect();
  try {
    for (const name of DATABASES) {
      const { rows } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
      if (rows.length === 0) {
        // Identifier cannot be parameterised; the names are a fixed literal list.
        await client.query(`CREATE DATABASE ${name}`);
        console.log(`created database ${name}`);
      }
    }
  } finally {
    await client.end();
  }
}

function stop() {
  if (!isInitialised()) {
    console.log('nothing to stop (cluster not initialised)');
    return;
  }
  if (!isRunning()) {
    console.log('postgres is not running');
    return;
  }
  const res = run('pg_ctl', ['-D', DATA, '-m', 'fast', '-w', '-t', '60', 'stop'], QUIET);
  if (!res.ok) throw new Error(`pg_ctl stop failed (${res.status}): ${res.stderr || res.stdout}`);
  console.log('postgres stopped');
}

function status() {
  const initialised = isInitialised();
  const running = isRunning();
  const port = running ? (actualPort() ?? PORT) : null;
  console.log(JSON.stringify({
    initialised,
    running,
    dataDir: DATA,
    port,
    requestedPort: PORT,
    clusterVersion: dataVersion(),
    binaryVersion: binaryVersion(),
    databases: DATABASES,
    url: `postgresql://${USER}:${USER}@127.0.0.1:${port ?? PORT}/freefirst_app`,
  }, null, 2));
  return running;
}

function assertOwnDataDir() {
  const resolved = resolve(DATA);
  if (!(resolved === ROOT || resolved.startsWith(ROOT + sep))) {
    throw new Error(
      `refusing to delete ${resolved}: it is not inside ${ROOT}.\n` +
        'PG_DATA must point at a directory this repository owns.',
    );
  }
}

async function main() {
  const cmd = (process.argv[2] || 'status').toLowerCase();
  switch (cmd) {
    case 'start':
      await start();
      await ensureDatabases();
      status();
      break;
    case 'stop':
      stop();
      break;
    case 'status':
      process.exitCode = status() ? 0 : 1;
      break;
    case 'version':
      console.log(`binaries: ${binaryVersion()} (${binaryDir()})`);
      console.log(`data dir: ${dataVersion() ?? 'not initialised'} (${DATA})`);
      break;
    case 'reset': {
      assertOwnDataDir();
      stop();
      if (existsSync(DATA)) {
        // Only ever removes this script's own cluster directory, after assertOwnDataDir.
        rmSync(DATA, { recursive: true, force: true });
        console.log(`removed ${DATA}`);
      }
      await start();
      await ensureDatabases();
      status();
      break;
    }
    default:
      console.error(`Unknown command: ${cmd}. Use start|stop|status|reset|version.`);
      process.exitCode = 2;
  }
}

// Importable API: verification scripts start and stop the cluster themselves so a
// single process owns the lifecycle (the server does not outlive its parent shell).
export {
  start as startCluster,
  stop as stopCluster,
  status as clusterStatus,
  isRunning,
  isInitialised,
  ensureDatabases,
  actualPort,
  binaryVersion,
  dataVersion,
};
export const CLUSTER = {
  dataDir: DATA,
  port: PORT,
  user: USER,
  databases: DATABASES,
  appUrl: `postgresql://${USER}:${USER}@127.0.0.1:${PORT}/freefirst_app`,
  routerUrl: `postgresql://${USER}:${USER}@127.0.0.1:${PORT}/freefirst_router`,
};

const isMain = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch((err) => {
    console.error(`dev-postgres: ${err.message}`);
    process.exitCode = 1;
  });
}
