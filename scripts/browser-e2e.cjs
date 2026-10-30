// Drives the extension in headless Chromium against a golink server on a real
// tailnet. Covers the auth-key paths of docs/testing-on-a-test-tailnet.md
// (B, C, F); interactive login (A) and Chrome restarts (E) stay manual.
//
//   GOLINK_E2E_AUTHKEY  tag:golink-ext auth key, pre-approved (required)
// golink must be seeded with testdata/e2e/links.jsonl. Each run creates its
// own links, so the same server can be reused.
//
// By default it loads ext/ unpacked. With GOLINK_E2E_INSTALLED=1 it instead
// force-installs the published release by policy from the manifest's real
// update_url into Google Chrome, as a managed device would; run that through
// scripts/check-release.sh, which gives Chrome a private /etc.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require('playwright-core');
const {extensionID} = require('./extension-id.cjs');
const {assertPrivateEtcOpt} = require('./private-etc.cjs');

const authKey = process.env.GOLINK_E2E_AUTHKEY;
if (!authKey) { console.error('GOLINK_E2E_AUTHKEY is required'); process.exit(2); }

const extPath = path.resolve('ext');
const manifest = JSON.parse(fs.readFileSync(path.join(extPath, 'manifest.json'), 'utf8'));
const extID = extensionID(manifest.key);
const installed = process.env.GOLINK_E2E_INSTALLED === '1';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
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

function launchOptions() {
  if (!installed) {
    return {channel: 'chromium', headless: true, args: [`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`]};
  }
  assertPrivateEtcOpt();
  const policyDir = '/etc/opt/chrome/policies/managed';
  fs.mkdirSync(policyDir, {recursive: true});
  // Chrome blocks DevTools, and so Playwright, on force-installed extensions by default and
  // closes any tab that opens one of their pages. Real users are unaffected; this only lets the test in.
  fs.writeFileSync(path.join(policyDir, 'golink-release.json'), JSON.stringify({
    DeveloperToolsAvailability: 1,
    ExtensionSettings: {[extID]: {installation_mode: 'force_installed', update_url: manifest.update_url}},
  }));
  return {
    channel: 'chrome', headless: true, args: ['--no-sandbox'],
    // Playwright's defaults turn off extensions and the background networking that installs them.
    ignoreDefaultArgs: ['--disable-extensions', '--disable-background-networking'],
  };
}

async function installedRecord(context) {
  const page = await context.newPage();
  try {
    await page.goto('chrome://extensions-internals');
    return JSON.parse(await page.evaluate(() => document.body.innerText)).find(item => item.id === extID);
  } catch { return undefined; } finally { await page.close().catch(() => {}); }
}

(async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'golink-e2e-'));
  const context = await chromium.launchPersistentContext(userDataDir, launchOptions());
  try {
    const statusURL = `chrome-extension://${extID}/status.html`;
    const findWorker = () => context.serviceWorkers().find(w => new URL(w.url()).host === extID);
    if (installed) {
      await check('I1', 'release is force-installed by policy from the real update_url', async () => {
        let record;
        for (let waited = 0; !record && waited < 120000; waited += 2000) {
          record = await installedRecord(context);
          if (!record) await sleep(2000);
        }
        assert.ok(record, `extension ${extID} was not installed from ${manifest.update_url}`);
        assert.equal(record.location, 'EXTERNAL_POLICY_DOWNLOAD');
        assert.deepEqual(record.disable_reasons, []);
        console.log(`     installed release ${record.version} of ${record.name}`);
      });
    } else {
      findWorker() ?? await context.waitForEvent('serviceworker', {timeout: 15000});
    }
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
    await check('C7', 'saved link appears in the status page list', async () => {
      await page.goto(statusURL);
      await page.locator('#links-list a', {hasText: created}).waitFor({timeout: 30000});
      await page.locator('#links-filter').fill(created);
      assert.equal(await page.locator('#links-list li').count(), 1);
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
      if (!findWorker()) {
        await page.goto(statusURL);
        await context.waitForEvent('serviceworker', {timeout: 15000}).catch(() => {});
      }
      const worker = findWorker();
      assert.ok(worker, 'extension service worker is not running');
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
