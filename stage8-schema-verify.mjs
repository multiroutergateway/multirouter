#!/usr/bin/env node
/**
 * Stage 8 — explicit schema inventory against a real PostgreSQL server.
 *
 * Stage 10 already proved the schema *behaves* (cascades, rollback, isolation) using
 * aggregate counts. This script is stricter: it asserts the exact set of tables,
 * columns, primary keys, foreign keys, unique constraints, CHECK constraints and
 * named indexes that the five migrations are supposed to produce — and asserts that
 * the two duplicate indexes removed by 004 are really gone.
 *
 * Read-only: it never writes, never deletes, never drops.
 *
 * Usage:
 *   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/freefirst_app \
 *     node scripts/stage8-schema-verify.mjs
 *
 * Exit: 0 = every assertion passed, 1 = at least one mismatch.
 */
import pg from 'pg';

const URL = process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:55432/freefirst_app';

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
}

function section(title) {
  console.log(`\n${title}`);
}

/** Set equality with a readable diff. */
function checkSet(name, actual, expected) {
  const a = [...actual].sort();
  const e = [...expected].sort();
  const missing = e.filter((x) => !a.includes(x));
  const extra = a.filter((x) => !e.includes(x));
  const detail = missing.length || extra.length
    ? `missing=[${missing.join(', ')}] extra=[${extra.join(', ')}]`
    : `${e.length} item(s)`;
  check(name, missing.length === 0 && extra.length === 0, detail);
}

const client = new pg.Client({ connectionString: URL });
await client.connect();

try {
  // ---------------------------------------------------------------- tables
  section('1. Tables');
  const tables = (await client.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
  )).rows.map((r) => r.table_name);

  checkSet('exact table set', tables, [
    'app_users', 'chat_requests', 'conversations', 'messages', 'schema_migrations', 'sessions',
  ]);

  // ---------------------------------------------------------------- migrations
  section('2. Migration ledger');
  const applied = (await client.query('SELECT name FROM schema_migrations ORDER BY name')).rows.map((r) => r.name);
  checkSet('all five migrations recorded', applied, [
    '001_init.sql', '002_sessions_roles.sql', '003_usage_indexes.sql',
    '004_integrity_cleanup.sql', '005_chat_requests.sql',
  ]);

  // ---------------------------------------------------------------- columns
  section('3. Columns, types and nullability');
  const cols = (await client.query(
    `SELECT table_name, column_name, udt_name, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = 'public'`,
  )).rows;

  const byTable = new Map();
  for (const c of cols) {
    if (!byTable.has(c.table_name)) byTable.set(c.table_name, new Map());
    byTable.get(c.table_name).set(c.column_name, c);
  }

  const EXPECTED = {
    app_users: {
      id: ['uuid', false], email: ['text', false], password_hash: ['text', false],
      created_at: ['timestamptz', false], role: ['text', false],
      display_name: ['text', true], updated_at: ['timestamptz', false],
    },
    conversations: {
      id: ['uuid', false], user_id: ['uuid', false], title: ['text', false],
      created_at: ['timestamptz', false], updated_at: ['timestamptz', false], model: ['text', true],
    },
    messages: {
      id: ['uuid', false], conversation_id: ['uuid', false], role: ['text', false],
      content: ['text', false], created_at: ['timestamptz', false], model: ['text', true],
      route_id: ['text', true], tier: ['text', true], tokens_in: ['int4', true],
      tokens_out: ['int4', true], cost_usd: ['numeric', true], finish_reason: ['text', true],
      meta: ['jsonb', true],
    },
    sessions: {
      id: ['uuid', false], user_id: ['uuid', false], jti: ['text', false],
      user_agent: ['text', true], ip_hash: ['text', true], created_at: ['timestamptz', false],
      expires_at: ['timestamptz', false], revoked_at: ['timestamptz', true],
    },
    chat_requests: {
      request_id: ['text', false], user_id: ['uuid', false], created_at: ['timestamptz', false],
    },
    schema_migrations: {
      name: ['text', false], applied_at: ['timestamptz', false],
    },
  };

  for (const [table, expected] of Object.entries(EXPECTED)) {
    const actual = byTable.get(table);
    checkSet(`${table}: exact column set`, [...(actual?.keys() || [])], Object.keys(expected));
    if (!actual) continue;

    const typeMismatch = [];
    const nullMismatch = [];
    for (const [col, [type, nullable]] of Object.entries(expected)) {
      const found = actual.get(col);
      if (!found) continue;
      if (found.udt_name !== type) typeMismatch.push(`${col}=${found.udt_name}`);
      const isNullable = found.is_nullable === 'YES';
      if (isNullable !== nullable) nullMismatch.push(`${col}=${isNullable ? 'null' : 'not null'}`);
    }
    check(`${table}: column types`, typeMismatch.length === 0, typeMismatch.join(', ') || 'all match');
    check(`${table}: nullability`, nullMismatch.length === 0, nullMismatch.join(', ') || 'all match');
  }

  // ---------------------------------------------------------------- primary keys
  section('4. Primary keys');
  const pks = (await client.query(
    `SELECT c.conrelid::regclass::text AS table_name,
            a.attname AS column_name
       FROM pg_constraint c
       JOIN unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
      WHERE c.contype = 'p' AND c.connamespace = 'public'::regnamespace
      ORDER BY table_name, k.ord`,
  )).rows;
  const pkMap = new Map();
  for (const r of pks) {
    if (!pkMap.has(r.table_name)) pkMap.set(r.table_name, []);
    pkMap.get(r.table_name).push(r.column_name);
  }
  for (const [table, col] of [
    ['app_users', 'id'], ['conversations', 'id'], ['messages', 'id'],
    ['sessions', 'id'], ['chat_requests', 'request_id'], ['schema_migrations', 'name'],
  ]) {
    check(`PK ${table}(${col})`, (pkMap.get(table) || []).join(',') === col, (pkMap.get(table) || []).join(',') || 'missing');
  }

  // ---------------------------------------------------------------- foreign keys
  section('5. Foreign keys and delete rules');
  const fks = (await client.query(
    `SELECT c.conrelid::regclass::text AS table_name,
            a.attname AS column_name,
            c.confrelid::regclass::text AS ref_table,
            fa.attname AS ref_column,
            c.confdeltype AS delete_action
       FROM pg_constraint c
       JOIN unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
       JOIN pg_attribute fa ON fa.attrelid = c.confrelid AND fa.attnum = c.confkey[k.ord]
      WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace
      ORDER BY table_name, column_name`,
  )).rows;
  const fkSet = fks.map((r) => `${r.table_name}.${r.column_name}->${r.ref_table}.${r.ref_column}`);
  checkSet('exact foreign key set', fkSet, [
    'conversations.user_id->app_users.id',
    'messages.conversation_id->conversations.id',
    'sessions.user_id->app_users.id',
    'chat_requests.user_id->app_users.id',
  ]);
  const notCascade = fks.filter((r) => r.delete_action !== 'c');
  check('every foreign key is ON DELETE CASCADE', notCascade.length === 0,
    notCascade.map((r) => `${r.table_name}.${r.column_name}=${r.delete_action}`).join(', ') || 'all cascade');

  // ---------------------------------------------------------------- unique + check
  section('6. Unique and CHECK constraints');
  const uniques = (await client.query(
    `SELECT c.conrelid::regclass::text AS table_name, a.attname AS column_name
       FROM pg_constraint c
       JOIN unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
      WHERE c.contype = 'u' AND c.connamespace = 'public'::regnamespace
      ORDER BY table_name, column_name`,
  )).rows.map((r) => `${r.table_name}.${r.column_name}`);
  checkSet('exact unique constraint set', uniques, [
    'app_users.email', 'sessions.jti',
  ]);

  const checks = (await client.query(
    `SELECT c.conrelid::regclass::text AS table_name,
            c.conname,
            pg_get_constraintdef(c.oid) AS def
       FROM pg_constraint c
      WHERE c.contype = 'c' AND c.connamespace = 'public'::regnamespace
      ORDER BY table_name, conname`,
  )).rows;
  const checkDefs = checks.map((r) => r.def.replace(/\s+/g, ' '));
  check('messages.role CHECK allows only user/assistant',
    checkDefs.some((d) => /role = ANY/.test(d) && /user/.test(d) && /assistant/.test(d)),
    checkDefs.find((d) => /assistant/.test(d)) || 'missing');
  check('app_users.role CHECK allows only user/admin',
    checkDefs.some((d) => /role = ANY/.test(d) && /admin/.test(d)),
    checkDefs.find((d) => /admin/.test(d)) || 'missing');
  check('exactly two CHECK constraints', checks.length === 2, `${checks.length} found`);

  // ---------------------------------------------------------------- indexes
  section('7. Indexes');
  const indexes = (await client.query(
    `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY indexname`,
  )).rows;
  const names = indexes.map((r) => r.indexname);

  for (const expected of [
    'conversations_user_updated_idx',
    'messages_conversation_created_idx',
    'sessions_user_idx',
    'sessions_expiry_idx',
    'messages_usage_idx',
    'messages_route_idx',
    'chat_requests_created_idx',
  ]) {
    check(`index ${expected} exists`, names.includes(expected));
  }

  check('duplicate index messages_conv_created_desc_idx removed (004)',
    !names.includes('messages_conv_created_desc_idx'));
  check('duplicate index sessions_jti_idx removed (004)',
    !names.includes('sessions_jti_idx'));

  const defOf = (n) => indexes.find((r) => r.indexname === n)?.indexdef || '';
  check('conversations_user_updated_idx is (user_id, updated_at DESC)',
    /\(user_id, updated_at DESC\)/.test(defOf('conversations_user_updated_idx')),
    defOf('conversations_user_updated_idx'));
  check('messages_conversation_created_idx is (conversation_id, created_at)',
    /\(conversation_id, created_at\)/.test(defOf('messages_conversation_created_idx')),
    defOf('messages_conversation_created_idx'));
  check('chat_requests_created_idx is (created_at)',
    /\(created_at\)/.test(defOf('chat_requests_created_idx')),
    defOf('chat_requests_created_idx'));

  // ---------------------------------------------------------------- defaults
  section('8. Defaults');
  const defaults = (await client.query(
    `SELECT table_name, column_name, column_default
       FROM information_schema.columns
      WHERE table_schema = 'public' AND column_default IS NOT NULL`,
  )).rows;
  const hasDefault = (t, c, re) => {
    const row = defaults.find((d) => d.table_name === t && d.column_name === c);
    return Boolean(row && re.test(row.column_default));
  };
  check('app_users.role defaults to user', hasDefault('app_users', 'role', /'user'/));
  check('conversations.title has a default', hasDefault('conversations', 'title', /Percakapan/));
  check('created_at columns default to now()',
    hasDefault('app_users', 'created_at', /now\(\)/) &&
    hasDefault('messages', 'created_at', /now\(\)/) &&
    hasDefault('sessions', 'created_at', /now\(\)/));
} finally {
  await client.end();
}

const total = passed + failed;
console.log(`\n${'-'.repeat(64)}`);
console.log(`Schema assertions: ${total}  |  PASS: ${passed}  |  FAIL: ${failed}`);
if (failed) {
  console.log('Failed assertions:');
  for (const f of failures) console.log(`  - ${f}`);
}
console.log(`${'-'.repeat(64)}`);
process.exit(failed === 0 ? 0 : 1);
