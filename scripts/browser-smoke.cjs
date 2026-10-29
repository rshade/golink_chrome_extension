const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require('playwright-core');
const {extensionID} = require('./extension-id.cjs');

const extPath = path.resolve('ext');
const workerRequest = method => ({channel: 'golink', target: 'worker', method, args: []});

(async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'golink-ext-'));
  const errors = [];
  // channel 'chromium' selects new headless mode, the only one that loads extensions.
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`],
  });
  context.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  context.on('weberror', error => errors.push(String(error.error())));
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', {timeout: 15000});
    const extensionId = new URL(worker.url()).host;
    const manifest = JSON.parse(fs.readFileSync(path.join(extPath, 'manifest.json'), 'utf8'));
    assert.equal(extensionId, extensionID(manifest.key), 'Chrome derives the ID from the manifest key');
    const offscreenDocuments = () => worker.evaluate(async () =>
      (await chrome.runtime.getContexts({contextTypes: ['OFFSCREEN_DOCUMENT']})).map(c => c.documentUrl));

    assert.deepEqual(await offscreenDocuments(), [], 'the offscreen document is created on first use');

    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/status.html`);
    await page.getByRole('button', {name: 'Use auth key'}).waitFor();

    const reply = await page.evaluate(request => chrome.runtime.sendMessage(request), workerRequest('status'));
    assert.equal(reply.ok, true, JSON.stringify(reply));
    assert.equal(reply.value.state, 'NeedsLogin');
    assert.equal(reply.value.golinkReachable, false);
    assert.match(reply.value.hostname, /^golink-ext-/);

    assert.deepEqual(await offscreenDocuments(), [`chrome-extension://${extensionId}/offscreen.html`]);
    assert.deepEqual(errors, [], 'no console or uncaught errors');
  } finally {
    await context.close();
    fs.rmSync(userDataDir, {recursive: true, force: true});
  }
})().catch(error => { console.error(error); process.exit(1); });
