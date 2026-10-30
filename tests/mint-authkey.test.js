import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { mintAuthKey } = createRequire(import.meta.url)('../scripts/mint-authkey.cjs');

const reply = (body, status = 200) => ({ ok: status < 300, status, json: async () => body });
const base = { tag: 'tag:golink-ext', clientId: 'id', clientSecret: 'secret' };

test('mints an ephemeral, single-use, pre-approved key for the tag using an OAuth token', async () => {
  const requests = [];
  const key = await mintAuthKey({ ...base, tailnet: 'example.ts.net', fetchImpl: async (url, init) => {
    requests.push({ url, init });
    return url.endsWith('/oauth/token') ? reply({ access_token: 'tok' }) : reply({ key: 'tskey-auth-new' });
  } });
  assert.equal(key, 'tskey-auth-new');
  assert.equal(requests[0].init.body.get('client_id'), 'id');
  assert.equal(requests[1].url, 'https://api.tailscale.com/api/v2/tailnet/example.ts.net/keys');
  assert.equal(requests[1].init.headers.authorization, 'Bearer tok');
  const body = JSON.parse(requests[1].init.body);
  assert.deepEqual(body.capabilities.devices.create, { reusable: false, ephemeral: true, preauthorized: true, tags: ['tag:golink-ext'] });
  assert.ok(body.expirySeconds <= 3600);
});

test('errors name the failing step and never include the OAuth secret', async () => {
  await assert.rejects(mintAuthKey({ ...base, fetchImpl: async () => reply({}, 401) }), error => /token request failed: HTTP 401/.test(error.message) && !error.message.includes('secret'));
  await assert.rejects(mintAuthKey({ ...base, fetchImpl: async url => url.endsWith('/oauth/token') ? reply({ access_token: 'tok' }) : reply({}, 403) }), /tag:golink-ext failed: HTTP 403/);
});

test('rejects a missing tag or credentials before any request', async () => {
  const fetchImpl = async () => { throw new Error('should not be called'); };
  await assert.rejects(mintAuthKey({ ...base, tag: 'golink', fetchImpl }), /tag/);
  await assert.rejects(mintAuthKey({ ...base, clientSecret: '', fetchImpl }), /TS_OAUTH_CLIENT_SECRET/);
});
