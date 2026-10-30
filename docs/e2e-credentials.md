# E2E credentials

The real-tailnet checks need two Tailscale auth keys: one for golink
(`tag:golink`) and one for the extension (`tag:golink-ext`). Nothing stores
either key. One OAuth client is stored instead, and `scripts/mint-authkey.cjs`
turns it into ephemeral, single-use, one-hour keys on each run. A leaked key
is useless within the hour; the OAuth client can only create keys for the two
tags.

The same two values feed local runs and GitHub Actions:

| Name | Kind | Value |
| --- | --- | --- |
| `TS_OAUTH_CLIENT_ID` | secret | OAuth client ID |
| `TS_OAUTH_CLIENT_SECRET` | secret | OAuth client secret |
| `TS_TAILNET` | variable | Tailnet name; leave unset to use the client's own |

## One-time setup on the test tailnet

1. Merge `testdata/e2e/policy.hujson` into the tailnet policy (see
   `docs/testing-on-a-test-tailnet.md`). `tagOwners` must let the OAuth
   client's owner assign both tags.
2. **Settings → OAuth clients → Generate**, with only the **Auth Keys**
   scope set to **Write**, and tags `tag:golink` and `tag:golink-ext`.
3. Turn on **MagicDNS** and **HTTPS Certificates**, and turn off **Device
   approval**.

## Local runs: Pulumi ESC

Create an ESC environment that exposes the client as environment variables
and keep the secret values encrypted:

```yaml
values:
  tailscale:
    oauthClientId:
      fn::secret: <client id>
    oauthClientSecret:
      fn::secret: <client secret>
  environmentVariables:
    TS_OAUTH_CLIENT_ID: ${tailscale.oauthClientId}
    TS_OAUTH_CLIENT_SECRET: ${tailscale.oauthClientSecret}
```

Then run the whole check without the secret reaching your shell history or
the agent's context:

```sh
pulumi env run <org>/<project>/<env> -- mise run test-e2e-minted
```

## GitHub Actions

`.github/workflows/e2e.yml` runs `mise run test-e2e-minted` on pushes to
`main`, weekly, and on manual dispatch. It never runs for pull requests, so a
fork cannot reach the secrets. Create the `e2e-tailnet` environment, restrict
it to the `main` branch, optionally require a reviewer, and add the secrets to
it:

```sh
gh api --method PUT repos/rshade/golink_chrome_extension/environments/e2e-tailnet
gh secret set TS_OAUTH_CLIENT_ID --env e2e-tailnet
gh secret set TS_OAUTH_CLIENT_SECRET --env e2e-tailnet
```

`gh secret set` prompts for each value, so nothing lands in shell history.

## Rotation

Delete the OAuth client in the Tailscale admin console and generate a new one,
then update the ESC environment and both GitHub secrets.
