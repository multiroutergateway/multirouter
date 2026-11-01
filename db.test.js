// DB-level integration tests — the layer the HTTP suite does not look at.
//
// The 41 tests in test/*.test.js assert what the API *returns*. These assert what
// actually lands in PostgreSQL: the bcrypt hash, the session rows and their
// revocation timestamps, message metadata, cascade behaviour and the idempotency
// ledger. They are skipped (not silently passed) unless a real server is configured:
//
//   TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/freefirst_app \
//     node --test test/integration/*.test.js
import '../env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  makeTestApp,
  jsonRequest,
  registerUser,
  usingRealPostgres,
  installFakeGateway,
  sseResponse,
} from '../helpers.js';

const skip = usingRealPostgres
  ? false
  : 'DB-level integration tests need TEST_DATABASE_URL pointing at real PostgreSQL';

const PASSWORD = 'correct-horse-battery';

async function waitFor(fn, timeoutMs = 4000) {
  const started = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - started > timeoutMs) return null;
    await new Promise((r) => setTimeout(r, 40));
  }
}

async function userIdOf(pool, email) {
  const { rows } = await pool.query('SELECT id FROM app_users WHERE email = $1', [email]);
  return rows[0]?.id;
}

test('password is persisted as a bcrypt hash, never plaintext', { skip }, async (t) => {
  const app = await makeTestApp();
  t.after(async () => { await app.close(); });

  const email = 'hash@example.com';
  await registerUser(app.base, email, PASSWORD);

  const { rows } = await app.pool.query('SELECT password_hash FROM app_users WHERE email = $1', [email]);
  assert.equal(rows.length, 1);
  const hash = rows[0].password_hash;

  assert.notEqual(hash, PASSWORD, 'password must not be stored verbatim');
  assert.ok(!hash.includes(PASSWORD), 'hash must not embed the password');
  assert.match(hash, /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/, 'expected a bcrypt hash');
});

test('login writes a session row and logout revokes it in the database', { skip }, async (t) => {
  const app = await makeTestApp();
  t.after(async () => { await app.close(); });

  const email = 'session@example.com';
  await registerUser(app.base, email, PASSWORD);
  const userId = await userIdOf(app.pool, email);

  const login = await jsonRequest(app.base, '/api/auth/login', {
    method: 'POST',
    body: { email, password: PASSWORD },
  });
  assert.equal(login.status, 200);
  const token = login.data.token;
  assert.ok(token, 'login must return a token');

  // Registration already created one session; the login adds another.
  const active = await app.pool.query(
    'SELECT jti FROM sessions WHERE user_id = $1 AND revoked_at IS NULL',
    [userId],
  );
  assert.ok(active.rowCount >= 2, `expected >= 2 active sessions, got ${active.rowCount}`);

  const logout = await jsonRequest(app.base, '/api/auth/logout', { method: 'POST', token });
  assert.equal(logout.status, 204, 'logout returns 204 No Content');

  // Revocation is per session, not per user: exactly the logged-out session is
  // marked, and the other one keeps working.
  const loginJti = JSON.parse(Buffer.from(token.split('.')[1], 'base64url')).jti;
  const revoked = await app.pool.query(
    'SELECT revoked_at FROM sessions WHERE user_id = $1 AND jti = $2',
    [userId, loginJti],
  );
  assert.equal(revoked.rowCount, 1, 'the login session row must exist');
  assert.ok(revoked.rows[0].revoked_at, 'logout must stamp revoked_at on that session');

  const stillActive = await app.pool.query(
    'SELECT COUNT(*)::int AS n FROM sessions WHERE user_id = $1 AND revoked_at IS NULL',
    [userId],
  );
  assert.equal(stillActive.rows[0].n, active.rowCount - 1, 'only one session may be revoked');

  // The token itself is still cryptographically valid — the server must reject it
  // because the session row is revoked.
  const me = await jsonRequest(app.base, '/api/auth/me', { token });
  assert.equal(me.status, 401, 'a revoked session must not authenticate');
});

test('logout-all revokes every active session for the user', { skip }, async (t) => {
  const app = await makeTestApp();
  t.after(async () => { await app.close(); });

  const email = 'revoke-all@example.com';
  await registerUser(app.base, email, PASSWORD);
  const userId = await userIdOf(app.pool, email);

  const first = await jsonRequest(app.base, '/api/auth/login', { method: 'POST', body: { email, password: PASSWORD } });
  const second = await jsonRequest(app.base, '/api/auth/login', { method: 'POST', body: { email, password: PASSWORD } });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);

  const before = await app.pool.query(
    'SELECT COUNT(*)::int AS n FROM sessions WHERE user_id = $1 AND revoked_at IS NULL',
    [userId],
  );
  assert.ok(before.rows[0].n >= 2, `expected >= 2 active sessions, got ${before.rows[0].n}`);

  const res = await jsonRequest(app.base, '/api/auth/logout-all', { method: 'POST', token: first.data.token });
  assert.equal(res.status, 200);

  const after = await app.pool.query(
    'SELECT COUNT(*)::int AS n FROM sessions WHERE user_id = $1 AND revoked_at IS NULL',
    [userId],
  );
  assert.equal(after.rows[0].n, 0, 'logout-all must revoke every session row');

  for (const token of [first.data.token, second.data.token]) {
    const me = await jsonRequest(app.base, '/api/auth/me', { token });
    assert.equal(me.status, 401);
  }
});

test('a streamed reply is persisted with route, tier and token metadata', { skip }, async (t) => {
  const app = await makeTestApp();
  t.after(async () => { await app.close(); });

  const restore = installFakeGateway(async () => sseResponse([
    'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"content":"Halo"}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"content":" dunia"}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":3}}\n\n',
    'data: [DONE]\n\n',
  ], { route: 'groq/llama-free', tier: 'free' }));
  t.after(restore);

  const user = await registerUser(app.base, 'persist@example.com');
  const conv = await jsonRequest(app.base, '/api/conversations', {
    method: 'POST', token: user.token, body: { title: 'Persist' },
  });
  const convId = conv.data.conversation.id;
  const requestId = randomUUID();

  const response = await fetch(`${app.base}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${user.token}` },
    body: JSON.stringify({
      conversationId: convId,
      requestId,
      stream: true,
      messages: [{ role: 'user', content: 'Halo' }],
    }),
  });
  assert.equal(response.status, 200);
  await response.text();

  const rows = await waitFor(async () => {
    const r = await app.pool.query(
      `SELECT role, content, route_id, tier, tokens_in, tokens_out, finish_reason
         FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC`,
      [convId],
    );
    return r.rowCount >= 2 ? r.rows : null;
  });
  assert.ok(rows, 'both turns must be persisted');

  assert.deepEqual(rows.map((r) => r.role), ['user', 'assistant']);
  assert.equal(rows[0].content, 'Halo');
  assert.equal(rows[1].content, 'Halo dunia');
  assert.equal(rows[1].route_id, 'groq/llama-free');
  assert.equal(rows[1].tier, 'free');
  assert.equal(rows[1].tokens_in, 12);
  assert.equal(rows[1].tokens_out, 3);
  assert.equal(rows[1].finish_reason, 'stop');

  // The idempotency ledger must hold exactly one row for this request id.
  const ledger = await app.pool.query('SELECT request_id FROM chat_requests WHERE request_id = $1', [requestId]);
  assert.equal(ledger.rowCount, 1);
});

test('deleting a conversation cascades to its messages in the database', { skip }, async (t) => {
  const app = await makeTestApp();
  t.after(async () => { await app.close(); });

  const user = await registerUser(app.base, 'cascade@example.com');
  const conv = await jsonRequest(app.base, '/api/conversations', {
    method: 'POST', token: user.token, body: { title: 'Cascade' },
  });
  const convId = conv.data.conversation.id;

  await app.pool.query(
    `INSERT INTO messages (id, conversation_id, role, content) VALUES
       (gen_random_uuid(), $1, 'user', 'satu'),
       (gen_random_uuid(), $1, 'assistant', 'dua')`,
    [convId],
  );
  const before = await app.pool.query('SELECT COUNT(*)::int AS n FROM messages WHERE conversation_id = $1', [convId]);
  assert.equal(before.rows[0].n, 2);

  const del = await jsonRequest(app.base, `/api/conversations/${convId}`, { method: 'DELETE', token: user.token });
  assert.ok(del.status === 200 || del.status === 204, `unexpected status ${del.status}`);

  const after = await app.pool.query('SELECT COUNT(*)::int AS n FROM messages WHERE conversation_id = $1', [convId]);
  assert.equal(after.rows[0].n, 0, 'ON DELETE CASCADE must remove the messages');
});

test('rows belonging to different users never share a conversation', { skip }, async (t) => {
  const app = await makeTestApp();
  t.after(async () => { await app.close(); });

  const alice = await registerUser(app.base, 'alice-db@example.com');
  const bob = await registerUser(app.base, 'bob-db@example.com');

  const aliceConv = await jsonRequest(app.base, '/api/conversations', {
    method: 'POST', token: alice.token, body: { title: 'Alice' },
  });
  const aliceConvId = aliceConv.data.conversation.id;

  await app.pool.query(
    `INSERT INTO messages (id, conversation_id, role, content)
     VALUES (gen_random_uuid(), $1, 'user', 'rahasia alice')`,
    [aliceConvId],
  );

  const bobRead = await jsonRequest(app.base, `/api/conversations/${aliceConvId}`, { token: bob.token });
  assert.equal(bobRead.status, 404, 'a foreign conversation must not be readable');

  const ownership = await app.pool.query(
    `SELECT c.user_id = u.id AS owned
       FROM conversations c JOIN app_users u ON u.email = $1
      WHERE c.id = $2`,
    ['alice-db@example.com', aliceConvId],
  );
  assert.equal(ownership.rows[0].owned, true, 'conversation must belong to its creator');
});
