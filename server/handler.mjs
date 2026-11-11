// Cloud storage API for budget.txt (AWS Lambda behind an API Gateway HTTP API).
//
// Security model:
// - API Gateway's JWT authorizer has already checked the Cognito token's signature, issuer,
//   client and expiry. This code additionally requires an *access* token.
// - The user is always the token's `sub`. No request field can name another user, and there is
//   no listing route, so a user can only ever read or change their own budget.
// - Every save is checked with the same core.checkStorable() the app uses: size limit and the
//   budget text format. Arbitrary files are rejected even if the app is bypassed.
// - The admin route returns totals only, never user ids or budget content.
// - Budget text is never logged.
//
// Routes: GET /api/budget, PUT /api/budget, DELETE /api/account, GET /api/admin/stats

import { checkStorable, MAX_STORED_BYTES } from '../core.js';

const HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' };
const reply = (statusCode, body) =>
  body === undefined ? { statusCode, headers: HEADERS } : { statusCode, headers: HEADERS, body: JSON.stringify(body) };

// Cognito puts groups in the token as a list; API Gateway passes lists on as "[a b]" strings.
export function groupsOf(claims) {
  const g = claims['cognito:groups'];
  if (Array.isArray(g)) return g;
  if (typeof g !== 'string' || !g) return [];
  return g.replace(/^\[|\]$/g, '').split(/[\s,]+/).filter(Boolean);
}

export class Conflict extends Error {}

export function makeHandler(deps) {
  return async function handler(event) {
    const claims = event.requestContext?.authorizer?.jwt?.claims || {};
    const sub = claims.sub;
    if (claims.token_use !== 'access' || typeof sub !== 'string' || !sub) return reply(401, { error: 'unauthorized' });

    try {
      switch (event.routeKey) {
        case 'GET /api/budget': {
          const item = await deps.getBudget(sub);
          return item ? reply(200, item) : reply(404, { error: 'notFound' });
        }

        case 'PUT /api/budget': {
          let raw = event.body || '';
          if (event.isBase64Encoded) raw = Buffer.from(raw, 'base64').toString('utf8');
          // JSON escaping can at most ~6x a character; anything larger is not a budget.
          if (raw.length > MAX_STORED_BYTES * 6 + 1024) return reply(413, { error: 'storeTooLarge', args: [] });
          let body;
          try { body = JSON.parse(raw); } catch { return reply(400, { error: 'badRequest' }); }
          const { text, version } = body || {};
          if (!(version === null || (Number.isInteger(version) && version > 0)))
            return reply(400, { error: 'badRequest' });
          let bytes;
          try {
            bytes = checkStorable(text);
          } catch (e) {
            if (e.key === 'storeTooLarge') return reply(413, { error: e.key, args: e.args });
            return reply(422, { error: e.key || 'storeInvalid', args: e.args || [] });
          }
          try {
            const newVersion = await deps.putBudget(sub, text, bytes, version);
            return reply(200, { version: newVersion, bytes });
          } catch (e) {
            if (e instanceof Conflict) return reply(409, { error: 'conflict' });
            throw e;
          }
        }

        case 'DELETE /api/account': {
          // Data first: if deleting the user fails, the budget is already gone and a retry
          // (the user is still signed in) finishes the job.
          await deps.deleteBudget(sub);
          await deps.deleteUser(claims.username);
          return reply(204);
        }

        case 'GET /api/admin/stats': {
          if (!groupsOf(claims).includes('admin')) return reply(403, { error: 'forbidden' });
          return reply(200, await deps.stats());
        }

        default:
          return reply(404, { error: 'notFound' });
      }
    } catch (e) {
      console.error('request failed', event.routeKey, e?.name, e?.message);
      return reply(500, { error: 'server' });
    }
  };
}

// ---------- AWS implementation (DynamoDB + Cognito) ----------
// Items: { pk: "user#<sub>", text, version, bytes, updatedAt } and one { pk: "stats", users, bytes }.

export function awsDeps({ table, userPoolId, region }) {
  let clients;
  const aws = async () => {
    if (!clients) {
      const ddb = await import('@aws-sdk/client-dynamodb');
      const idp = await import('@aws-sdk/client-cognito-identity-provider');
      clients = { ddb, idp, db: new ddb.DynamoDBClient({ region }), cog: new idp.CognitoIdentityProviderClient({ region }) };
    }
    return clients;
  };
  const key = sub => ({ pk: { S: `user#${sub}` } });
  const isConditionFailure = e => e?.name === 'ConditionalCheckFailedException'
    || (e?.name === 'TransactionCanceledException'
      && (e.CancellationReasons || []).some(r => r?.Code === 'ConditionalCheckFailed'));

  async function readItem(sub) {
    const { ddb, db } = await aws();
    const r = await db.send(new ddb.GetItemCommand({ TableName: table, Key: key(sub), ConsistentRead: true }));
    const i = r.Item;
    return i ? { text: i.text.S, version: +i.version.N, bytes: +i.bytes.N, updatedAt: i.updatedAt?.S } : null;
  }

  const statsUpdate = (deltaUsers, deltaBytes) => ({
    Update: {
      TableName: table, Key: { pk: { S: 'stats' } },
      UpdateExpression: 'ADD #u :u, #b :b',
      ExpressionAttributeNames: { '#u': 'users', '#b': 'bytes' },
      ExpressionAttributeValues: { ':u': { N: String(deltaUsers) }, ':b': { N: String(deltaBytes) } },
    },
  });

  return {
    getBudget: readItem,

    async putBudget(sub, text, bytes, expected) {
      const { ddb, db } = await aws();
      const old = await readItem(sub);
      if (expected === null ? old : (!old || old.version !== expected)) throw new Conflict();
      const version = (old?.version || 0) + 1;
      try {
        await db.send(new ddb.TransactWriteItemsCommand({
          TransactItems: [
            {
              Put: {
                TableName: table,
                Item: {
                  ...key(sub), text: { S: text }, version: { N: String(version) },
                  bytes: { N: String(bytes) }, updatedAt: { S: new Date().toISOString() },
                },
                ConditionExpression: old ? 'version = :v' : 'attribute_not_exists(pk)',
                ...(old ? { ExpressionAttributeValues: { ':v': { N: String(old.version) } } } : {}),
              },
            },
            statsUpdate(old ? 0 : 1, bytes - (old?.bytes || 0)),
          ],
        }));
      } catch (e) {
        if (isConditionFailure(e)) throw new Conflict();
        throw e;
      }
      return version;
    },

    async deleteBudget(sub) {
      const { ddb, db } = await aws();
      for (let attempt = 0; attempt < 3; attempt++) {
        const old = await readItem(sub);
        if (!old) return;
        try {
          await db.send(new ddb.TransactWriteItemsCommand({
            TransactItems: [
              {
                Delete: {
                  TableName: table, Key: key(sub),
                  ConditionExpression: 'version = :v',
                  ExpressionAttributeValues: { ':v': { N: String(old.version) } },
                },
              },
              statsUpdate(-1, -old.bytes),
            ],
          }));
          return;
        } catch (e) {
          if (!isConditionFailure(e)) throw e;  // saved meanwhile: read again and retry
        }
      }
      throw new Error('could not delete budget');
    },

    async deleteUser(username) {
      const { idp, cog } = await aws();
      if (!username) throw new Error('token has no username');
      try {
        await cog.send(new idp.AdminDeleteUserCommand({ UserPoolId: userPoolId, Username: username }));
      } catch (e) {
        if (e?.name !== 'UserNotFoundException') throw e;
      }
    },

    async stats() {
      const { ddb, idp, db, cog } = await aws();
      const [s, pool] = await Promise.all([
        db.send(new ddb.GetItemCommand({ TableName: table, Key: { pk: { S: 'stats' } }, ConsistentRead: true })),
        cog.send(new idp.DescribeUserPoolCommand({ UserPoolId: userPoolId })),
      ]);
      return {
        registeredUsers: pool.UserPool?.EstimatedNumberOfUsers ?? null,
        storedBudgets: +(s.Item?.users?.N || 0),
        totalBytes: +(s.Item?.bytes?.N || 0),
        maxBytesPerUser: MAX_STORED_BYTES,
      };
    },
  };
}

export const handler = process.env.TABLE_NAME
  ? makeHandler(awsDeps({ table: process.env.TABLE_NAME, userPoolId: process.env.USER_POOL_ID, region: process.env.AWS_REGION }))
  : undefined;
