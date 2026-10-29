// Drives the extension in headless Chromium against a golink server on a real
// tailnet. Covers the auth-key paths of docs/testing-on-a-test-tailnet.md
// (B, C, F); interactive login (A) and Chrome restarts (E) stay manual.
//
//   GOLINK_E2E_AUTHKEY  tag:golink-ext auth key, pre-approved (required)
// golink must be seeded with testdata/e2e/links.jsonl. Each run creates its
// own links, so the same server can be reused.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require('playwright-core');

const authKey = process.env.GOLINK_E2E_AUTHKEY;
if (!authKey) { console.error('GOLINK_E2E_AUTHKEY is required'); process.exit(2); }

const extPath = path.resolve('ext');
const suffix = Date.now().toString(36);
const results = [];

async function check(id, description, fn) {
  try {
    await fn();
    results.push({id, description, ok: true});
  } catch (error) {
    results.push({id, description, ok: false, detail: String(error.message ?? error).split('\n')[0]});
  }
  report(results.at(-1));
  return results.at(-1).ok;
}

function report(r) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.id.padEnd(4)} ${r.description}${r.ok ? '' : `\n         ${r.detail}`}`);
}

(async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'golink-e2e-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`],
  });
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', {timeout: 15000});
    const statusURL = `chrome-extension://${new URL(worker.url()).host}/status.html`;
    const page = await context.newPage();

    const text = id => page.locator(id).textContent();
    const open = async url => {
      await page.goto(url, {waitUntil: 'commit'}).catch(() => {});
    };
    const landsOn = async (url, expected) => {
      await open(url);
      await page.waitForURL(expected, {timeout: 60000});
    };
    const showsStatusPage = async url => {
      await open(url);
      await page.locator('#ui-panel:not([hidden]), #error:not([hidden])').first().waitFor({timeout: 60000});
    };
    const save = async (short, long) => {
      await page.goto(statusURL);
      await page.locator('#short').fill(short);
      await page.locator('#long').fill(long);
      await page.locator('#save-form button[type=submit]').click();
    };

    const loggedIn = await check('F1', 'auth key login reaches Connected', async () => {
      await page.goto(statusURL);
      await page.locator('#auth-key').fill(authKey);
      await page.getByRole('button', {name: 'Use auth key'}).click();
      await page.locator('#status', {hasText: 'Connected'}).waitFor({timeout: 120000});
      await page.locator('#reachability:not([hidden])').waitFor({timeout: 60000});
      assert.match(await text('#reachability'), /Golink is reachable/);
    });

    if (!loggedIn) throw new Error('not logged in, skipping the remaining checks');
    await check('B1', 'resolve a simple link', () => landsOn('http://go/ext-simple', 'https://example.com/'));
    await check('B2', 'path and query pass through', () =>
      landsOn('http://go/ext-simple/a/b?x=1&x=2', 'https://example.com/a/b?x=1&x=2'));
    await check('B5', 'relative alias', () => landsOn('http://go/ext-alias', 'https://example.com/'));
    await check('B6', 'absolute alias', () => landsOn('http://go/ext-alias-abs', 'https://example.com/'));
    await check('B7', 'alias loop is reported', async () => {
      await showsStatusPage('http://go/ext-loop-a');
      assert.match(await text('#error'), /too many go link aliases/);
    });
    await check('B8', 'fragment is kept', () => landsOn('http://go/ext-page#section', 'https://example.com/page#section'));
    await check('B9', 'case-insensitive short name', () => landsOn('http://go/EXT-MIXED-CASE', 'https://example.com/mixed'));
    await check('B10', 'plus suffix shows the cached link', async () => {
      await showsStatusPage('http://go/ext-simple+');
      assert.equal(await text('#ui-heading'), "Open golink's web UI");
      assert.equal(await text('#cached-short'), 'ext-simple');
      assert.equal(await text('#cached-long'), 'https://example.com/');
    });
    await check('B12', 'bare go/ shows the web UI page', async () => {
      await showsStatusPage('http://go/');
      assert.equal(await text('#ui-heading'), "Open golink's web UI");
    });

    await check('F2', 'golink sees the tag, not a person', () =>
      landsOn('http://go/ext-user', 'https://example.com/u/tagged-devices'));

    const created = `ext-e2e-${suffix}`;
    await check('C1', 'unknown link opens the save form', async () => {
      await open(`http://go/${created}`);
      await page.locator('#message', {hasText: 'Link not found. Enter a target URL to create it.'}).waitFor({timeout: 60000});
      assert.equal(await page.locator('#short').inputValue(), created);
    });
    await check('C2', 'save then resolve', async () => {
      await page.locator('#long').fill('https://example.org/');
      await page.locator('#save-form button[type=submit]').click();
      await page.locator('#message', {hasText: 'Link saved.'}).waitFor({timeout: 30000});
      await landsOn(`http://go/${created}`, 'https://example.org/');
    });
    const replacement = `https://example.com/new-${suffix}`;
    await check('C4', 'saving over an existing link asks first', async () => {
      await save('ext-replace', replacement);
      await page.locator('#warning:not([hidden])').waitFor({timeout: 30000});
      assert.match(await text('#warning'), /go\/ext-replace already points to https:\/\/example\.com\/\S+\. Replace it for everyone in the tailnet\?/);
      await landsOn('http://go/ext-replace', url => url.href.startsWith('https://example.com/') && url.href !== replacement);
    });
    await check('C5', 'replace existing link', async () => {
      await save('ext-replace', replacement);
      await page.locator('#replace:not([hidden])').click();
      await page.locator('#message', {hasText: 'Link saved.'}).waitFor({timeout: 30000});
      await landsOn('http://go/ext-replace', replacement);
    });
    await check('F3', 'saved link is owned by tagged-devices', async () => {
      await showsStatusPage(`http://go/${created}+`);
      assert.equal(await text('#cached-owner'), 'tagged-devices');
    });
    await check('F4', 'auth key is not in extension storage', async () => {
      const dump = await worker.evaluate(async () => JSON.stringify(await chrome.storage.local.get(null)));
      assert.ok(!dump.includes('tskey'), 'storage contains an auth key');
    });

    await check('F6', 'reset then a bad key is rejected', async () => {
      await page.goto(statusURL);
      await page.locator('#reset').click();
      await page.locator('#auth-key').waitFor({timeout: 60000});
      await page.locator('#auth-key').fill('tskey-auth-invalid');
      await page.getByRole('button', {name: 'Use auth key'}).click();
      await page.locator('#error:not([hidden])').waitFor({timeout: 120000});
      assert.match(await text('#error'), /Auth-key login failed\. Check the key and try again\./);
    });
  } finally {
    await context.close();
    fs.rmSync(userDataDir, {recursive: true, force: true});
  }

  const failed = results.filter(r => !r.ok).length;
  console.log(`${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch(error => { console.error(error); process.exit(1); });
