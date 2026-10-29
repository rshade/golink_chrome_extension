// Proves a released package installs and updates the way a managed fleet would:
// pack a signed CRX, serve it from localhost, force-install it into Chromium with
// an ExtensionSettings policy, then publish a newer version and watch Chrome update.
// Run through scripts/check-install.sh, which gives Chromium a private /etc.
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const {chromium} = require('playwright-core');
const {extensionID} = require('./extension-id.cjs');
const {updateXML} = require('./update-xml.cjs');

const repo = path.resolve(__dirname, '..');
const POLICY_DIR = '/etc/opt/chrome_for_testing/policies/managed';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function releaseDir(extDir, keyFile, version, origin, outDir) {
  const manifestPath = path.join(extDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  fs.writeFileSync(manifestPath, JSON.stringify({...manifest, version}));
  const run = spawnSync('scripts/package-release.sh', [], {
    cwd: repo, encoding: 'utf8',
    env: {...process.env, EXT_DIR: extDir, OUT_DIR: outDir, RELEASE_KEY_FILE: keyFile, RELEASE_VERSION: version},
  });
  assert.equal(run.status, 0, run.stderr);
  const id = extensionID(manifest.key);
  const xml = updateXML({id, version, codebase: 'https://placeholder.invalid/x.crx'})
    .replace('https://placeholder.invalid/x.crx', `${origin}/golink-ext-${version}.crx`);
  fs.writeFileSync(path.join(outDir, 'update.xml'), xml);
}

(async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'check-install-'));
  const extDir = path.join(work, 'ext');
  fs.cpSync(path.join(repo, 'ext'), extDir, {recursive: true});
  const {publicKey, privateKey} = crypto.generateKeyPairSync('rsa', {modulusLength: 2048});
  const keyFile = path.join(work, 'key.pem');
  fs.writeFileSync(keyFile, privateKey.export({type: 'pkcs8', format: 'pem'}), {mode: 0o600});
  const manifestPath = path.join(extDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.key = publicKey.export({type: 'spki', format: 'der'}).toString('base64');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const id = extensionID(manifest.key);

  const out = path.join(work, 'served');
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    const file = path.join(out, path.basename(req.url.split('?')[0]));
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404).end(); return; }
    const type = file.endsWith('.crx') ? 'application/x-chrome-extension' : 'text/xml';
    res.writeHead(200, {'Content-Type': type}).end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  releaseDir(extDir, keyFile, '0.1.0', origin, out);

  const policy = JSON.stringify({ExtensionSettings: {[id]: {
    installation_mode: 'force_installed', update_url: `${origin}/update.xml`, override_update_url: true,
  }}});
  fs.mkdirSync(POLICY_DIR, {recursive: true});
  fs.writeFileSync(path.join(POLICY_DIR, 'golink-check-install.json'), policy);

  const profileDir = path.join(work, 'profile');
  const context = await chromium.launchPersistentContext(profileDir, {
    channel: 'chromium', headless: true,
    // Playwright's defaults turn off extensions and the background networking that updates them.
    ignoreDefaultArgs: ['--disable-extensions', '--disable-background-networking'],
    args: ['--no-sandbox'],
  });

  // chrome://extensions-internals reports what Chrome itself has loaded. Opening the
  // extension's own pages is not an option: headless Chrome closes such a tab.
  const loadedExtension = async () => {
    const page = await context.newPage();
    try {
      await page.goto('chrome://extensions-internals');
      const list = JSON.parse(await page.evaluate(() => document.body.innerText));
      return list.find(item => item.id === id);
    } catch { return undefined; } finally { await page.close().catch(() => {}); }
  };
  // Developer mode shows an Update button on chrome://extensions that asks every extension for updates now.
  const checkForUpdatesNow = async () => {
    const page = await context.newPage();
    try {
      await page.goto('chrome://extensions');
      await page.locator('#devMode').click();
      await page.locator('#updateNow').click();
      await page.waitForTimeout(2000);
    } finally { await page.close().catch(() => {}); }
  };
  const waitForVersion = async (version, label) => {
    for (let waited = 0; waited < 90000; waited += 2000) {
      const loaded = await loadedExtension();
      if (loaded?.version === version) return loaded;
      if (label === 'update' && waited % 10000 === 0) await checkForUpdatesNow();
      await sleep(2000);
    }
    throw new Error(`${label}: extension ${id} never reached ${version}; server saw ${JSON.stringify(requests.map(url => url.split('?')[0]))}`);
  };

  let failed = false;
  try {
    const installed = await waitForVersion('0.1.0', 'force-install');
    assert.equal(installed.location, 'EXTERNAL_POLICY_DOWNLOAD');
    assert.deepEqual(installed.disable_reasons, []);
    assert.equal(installed.name, 'Golink over Tailscale');
    console.log(`PASS force-install: ${id} installed at 0.1.0 by policy from ${origin}`);

    releaseDir(extDir, keyFile, '0.1.1', origin, out);
    await waitForVersion('0.1.1', 'update');
    console.log('PASS update: Chrome moved to 0.1.1 from the update XML after an update check');
  } catch (error) {
    failed = true;
    console.error(`FAIL ${error.message}`);
    for (const name of ['Secure Preferences', 'Preferences']) {
      try {
        const prefs = JSON.parse(fs.readFileSync(path.join(profileDir, 'Default', name), 'utf8'));
        const record = prefs.extensions?.settings?.[id];
        if (record) console.error(`${name}: ${JSON.stringify({state: record.state, location: record.location, disable_reasons: record.disable_reasons, from_webstore: record.from_webstore, version: record.manifest?.version, withholding: record.withholding_permissions})}`);
      } catch { /* the file may not exist yet */ }
    }
    try {
      const page = await context.newPage();
      await page.goto('chrome://policy');
      await page.waitForTimeout(1500);
      const shown = await page.evaluate(() => {
        const text = node => (node.shadowRoot ? [...node.shadowRoot.children] : []).concat([...node.children])
          .map(child => (child.children.length || child.shadowRoot ? text(child) : child.textContent.trim())).filter(Boolean).join(' | ');
        return text(document.body);
      });
      console.error(`chrome://policy says: ${shown.replace(/\s+/g, ' ').slice(0, 1500)}`);
    } catch (diagnosticError) { console.error(`could not read chrome://policy: ${diagnosticError.message}`); }
  } finally {
    await context.close();
    server.close();
    fs.rmSync(work, {recursive: true, force: true});
  }
  process.exit(failed ? 1 : 0);
})().catch(error => { console.error(error); process.exit(1); });
