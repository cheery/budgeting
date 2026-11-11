import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHandler, groupsOf, Conflict } from '../server/handler.mjs';

const BUDGET = 'currency EUR\ncategory Food expense\n2026-01-02 Food 12,50 lunch\n';

// In-memory stand-in for DynamoDB + Cognito with the same semantics as awsDeps().
function fakeDeps() {
  const items = new Map();
  const deleted = [];
  return {
    items, deleted,
    async getBudget(sub) { return items.get(sub) || null; },
    async putBudget(sub, text, bytes, expected) {
      const old = items.get(sub);
      if (expected === null ? old : (!old || old.version !== expected)) throw new Conflict();
      const version = (old?.version || 0) + 1;
      items.set(sub, { text, version, bytes });
      return version;
    },
    async deleteBudget(sub) { items.delete(sub); },
    async deleteUser(username) { deleted.push(username); },
    async stats() {
      return { registeredUsers: 7, storedBudgets: items.size,
        totalBytes: [...items.values()].reduce((s, i) => s + i.bytes, 0) };
    },
  };
}

const ev = (routeKey, { sub = 'user-a', body, groups, tokenUse = 'access', base64 = false } = {}) => ({
  routeKey,
  isBase64Encoded: base64,
  body: body === undefined ? undefined
    : base64 ? Buffer.from(JSON.stringify(body)).toString('base64') : JSON.stringify(body),
  requestContext: { authorizer: { jwt: { claims: {
    sub, token_use: tokenUse, username: 'google_' + sub,
    ...(groups ? { 'cognito:groups': groups } : {}),
  } } } },
});
const json = r => (r.body ? JSON.parse(r.body) : undefined);

test('server: requires an access token with a subject', async () => {
  const h = makeHandler(fakeDeps());
  assert.equal((await h(ev('GET /api/budget', { tokenUse: 'id' }))).statusCode, 401);
  assert.equal((await h(ev('GET /api/budget', { sub: '' }))).statusCode, 401);
  assert.equal((await h({ routeKey: 'GET /api/budget' })).statusCode, 401);
});

test('server: create, read, update with version check', async () => {
  const deps = fakeDeps();
  const h = makeHandler(deps);
  assert.equal((await h(ev('GET /api/budget'))).statusCode, 404);
  let r = await h(ev('PUT /api/budget', { body: { text: BUDGET, version: null } }));
  assert.equal(r.statusCode, 200);
  assert.deepEqual(json(r), { version: 1, bytes: BUDGET.length });
  assert.equal(r.headers['cache-control'], 'no-store');
  // Creating again, or saving over a version you have not seen, is a conflict.
  assert.equal((await h(ev('PUT /api/budget', { body: { text: BUDGET, version: null } }))).statusCode, 409);
  assert.equal((await h(ev('PUT /api/budget', { body: { text: BUDGET, version: 5 } }))).statusCode, 409);
  r = await h(ev('PUT /api/budget', { body: { text: BUDGET + '2026-01-03 Food 3\n', version: 1 }, base64: true }));
  assert.equal(json(r).version, 2);
  assert.equal(json(await h(ev('GET /api/budget'))).version, 2);
});

test('server: users only ever see their own budget', async () => {
  const h = makeHandler(fakeDeps());
  await h(ev('PUT /api/budget', { sub: 'user-a', body: { text: BUDGET, version: null } }));
  assert.equal((await h(ev('GET /api/budget', { sub: 'user-b' }))).statusCode, 404);
  // A user id in the body or query is ignored; only the token's sub counts.
  const r = await h({ ...ev('GET /api/budget', { sub: 'user-b' }), queryStringParameters: { sub: 'user-a' } });
  assert.equal(r.statusCode, 404);
});

test('server: rejects anything that is not a readable budget', async () => {
  const h = makeHandler(fakeDeps());
  const put = body => h(ev('PUT /api/budget', { body }));
  assert.equal((await put({ text: 'GIF89a binary junk', version: null })).statusCode, 422);
  assert.equal((await put({ text: 123, version: null })).statusCode, 422);
  assert.equal((await put({ text: BUDGET, version: '1' })).statusCode, 400);
  assert.equal((await put({ text: BUDGET, version: 0 })).statusCode, 400);
  assert.equal((await put({ text: BUDGET + '\u0001', version: null })).statusCode, 422);
  const big = await put({ text: '# ' + 'x'.repeat(300 * 1024), version: null });
  assert.equal(big.statusCode, 413);
  assert.equal(json(big).error, 'storeTooLarge');
  assert.equal((await h({ ...ev('PUT /api/budget'), body: '{not json' })).statusCode, 400);
});

test('server: account deletion removes the budget and the user', async () => {
  const deps = fakeDeps();
  const h = makeHandler(deps);
  await h(ev('PUT /api/budget', { body: { text: BUDGET, version: null } }));
  assert.equal((await h(ev('DELETE /api/account'))).statusCode, 204);
  assert.equal(deps.items.size, 0);
  assert.deepEqual(deps.deleted, ['google_user-a']);
});

test('server: admin stats need the admin group and contain totals only', async () => {
  const h = makeHandler(fakeDeps());
  await h(ev('PUT /api/budget', { body: { text: BUDGET, version: null } }));
  assert.equal((await h(ev('GET /api/admin/stats'))).statusCode, 403);
  assert.equal((await h(ev('GET /api/admin/stats', { groups: '[editors]' }))).statusCode, 403);
  const r = await h(ev('GET /api/admin/stats', { groups: '[admin]' }));
  assert.equal(r.statusCode, 200);
  assert.deepEqual(json(r), { registeredUsers: 7, storedBudgets: 1, totalBytes: BUDGET.length });
  assert.deepEqual(groupsOf({ 'cognito:groups': '[admin editors]' }), ['admin', 'editors']);
  assert.deepEqual(groupsOf({ 'cognito:groups': ['admin'] }), ['admin']);
  assert.deepEqual(groupsOf({}), []);
});

test('server: unknown routes and failures do not leak details', async () => {
  const deps = fakeDeps();
  deps.getBudget = async () => { throw new Error('secret internals'); };
  const h = makeHandler(deps);
  const orig = console.error; console.error = () => {};
  try {
    const r = await h(ev('GET /api/budget'));
    assert.equal(r.statusCode, 500);
    assert.ok(!r.body.includes('secret'));
  } finally { console.error = orig; }
  assert.equal((await h(ev('GET /api/other'))).statusCode, 404);
});
