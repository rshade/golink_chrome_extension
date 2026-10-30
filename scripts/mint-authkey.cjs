// Mints a short-lived, single-use, ephemeral Tailscale auth key from an OAuth
// client, so no long-lived auth key has to be stored anywhere.
//
//   TS_OAUTH_CLIENT_ID, TS_OAUTH_CLIENT_SECRET  OAuth client with the auth_keys
//                                               write scope for the tag below
//   TS_TAILNET                                  tailnet name; default "-" (the client's own)
//
//   node scripts/mint-authkey.cjs tag:golink    prints only the key to stdout
//
// In GitHub Actions the key is registered as a masked value before it is printed.
const API = 'https://api.tailscale.com/api/v2';
const keyLifetimeSeconds = 3600;

async function mintAuthKey({tag, clientId, clientSecret, tailnet = '-', description = 'golink extension e2e', fetchImpl = fetch}) {
  if (!/^tag:[a-z][a-z0-9-]*$/i.test(tag ?? '')) throw new Error('A tag such as tag:golink is required');
  if (!clientId || !clientSecret) throw new Error('TS_OAUTH_CLIENT_ID and TS_OAUTH_CLIENT_SECRET are required');
  const token = await fetchImpl(`${API}/oauth/token`, {
    method: 'POST',
    headers: {'content-type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams({grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret}),
  });
  if (!token.ok) throw new Error(`OAuth token request failed: HTTP ${token.status}`);
  const {access_token: accessToken} = await token.json();
  if (!accessToken) throw new Error('OAuth token response had no access_token');
  const created = await fetchImpl(`${API}/tailnet/${encodeURIComponent(tailnet)}/keys`, {
    method: 'POST',
    headers: {authorization: `Bearer ${accessToken}`, 'content-type': 'application/json'},
    body: JSON.stringify({
      capabilities: {devices: {create: {reusable: false, ephemeral: true, preauthorized: true, tags: [tag]}}},
      expirySeconds: keyLifetimeSeconds,
      description,
    }),
  });
  if (!created.ok) throw new Error(`Auth key request for ${tag} failed: HTTP ${created.status}`);
  const {key} = await created.json();
  if (!key) throw new Error('Auth key response had no key');
  return key;
}

module.exports = {mintAuthKey};

if (require.main === module) {
  mintAuthKey({
    tag: process.argv[2],
    clientId: process.env.TS_OAUTH_CLIENT_ID,
    clientSecret: process.env.TS_OAUTH_CLIENT_SECRET,
    tailnet: process.env.TS_TAILNET || '-',
  }).then(key => {
    if (process.env.GITHUB_ACTIONS === 'true') console.error(`::add-mask::${key}`);
    process.stdout.write(`${key}\n`);
  }, error => {
    console.error(error.message);
    process.exit(1);
  });
}
