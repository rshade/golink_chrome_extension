import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackground } from '../ext/background.js';
import { createStateStore } from '../ext/state.js';
import { createOffscreenBridge } from '../ext/offscreen.js';

const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); }, removeListener(fn) { this.listeners = this.listeners.filter(listener => listener !== fn); } });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
function storage(initial = {}) {
  const data = structuredClone(initial);
  return { data, async get(keys) { return Object.fromEntries(keys.filter(key => key in data).map(key => [key, structuredClone(data[key])])); }, async set(values) { Object.assign(data, structuredClone(values)); }, async remove(keys) { for (const key of keys) delete data[key]; } };
}
function fixture({ cache, session, node = {}, handleEvent } = {}) {
  const local = storage({ tsState: { epoch: 1, values: {} }, hostname: 'golink-ext-aabbcc', golinkHost: 'go', controlURL: 'https://controlplane.tailscale.com', ...(cache ? { linksCache: cache } : {}) });
  const calls = [], tabs = [], rules = [];
  const contexts = [{ contextType: 'TAB', contextId: 'status-context', documentId: 'status-document', documentUrl: 'chrome-extension://extension/status.html?resolve=foo', documentOrigin: 'chrome-extension://extension', frameId: 0, tabId: 42, windowId: 1, incognito: false }];
  const chrome = {
    runtime: { id: 'extension', getURL: path => 'chrome-extension://extension/' + path, onMessage: event(), onInstalled: event(), onStartup: event(), async getContexts(filter) {
      return contexts.filter(context => ['contextType', 'documentId', 'documentUrl', 'tabId'].every(key => {
        const values = filter[key === 'contextType' ? 'contextTypes' : key + 's'];
        return !values || values.includes(context[key]);
      }));
    } },
    omnibox: { onInputChanged: event(), onInputEntered: event() },
    storage: { local, session: session ?? storage() },
    tabs: { async create(options) { tabs.push({ action: 'create', ...options }); return { id: 10 }; }, async update(id, options) { tabs.push({ action: 'update', id, ...options }); return { id }; }, async remove(id) { tabs.push({ action: 'remove', id }); }, async query() { return [{ id: 7 }]; } },
    declarativeNetRequest: { async getDynamicRules() { return structuredClone(rules); }, async updateDynamicRules(update) { calls.push(['rules', update]); rules.splice(0, rules.length, ...update.addRules); } },
  };
  const lifecycle = {
    async call(method, args = []) { calls.push([method, args]); if (node[method]) return node[method](...args); if (method === 'status') return { state: 'Running', loginName: 'test', tailnet: 'tailnet', hostname: 'golink-ext-aabbcc', golinkReachable: true }; if (method === 'links') return []; return { ok: true }; },
    async restart(options) { calls.push(['restart', options]); if (node.restart) return node.restart(options); const state = local.data.tsState; local.data.tsState = { epoch: state.epoch + 1, values: options.clear ? {} : state.values }; if (options.clear) delete local.data.linksCache; return { ok: true }; },
    async handleEvent(message, sender) { calls.push(['event', message, sender]); return handleEvent ? handleEvent(message, sender) : { ok: true, value: { accepted: true } }; },
  };
  const store = createStateStore(local);
  const background = createBackground({ chrome, lifecycle, store, now: () => 1_000_000 });
  const sender = { id: 'extension', url: 'chrome-extension://extension/status.html?resolve=foo', documentId: 'status-document', frameId: 0, tab: { id: 42 } };
  const page = (method, args = []) => background.handleMessage({ channel: 'golink', target: 'worker', method, args }, sender);
  const offscreen = message => background.handleMessage({ channel: 'golink', target: 'worker', docId: 'doc', epoch: 1, ...message }, { id: 'extension', url: 'chrome-extension://extension/offscreen.html' });
  return { background, chrome, lifecycle, local, store, calls, tabs, rules, contexts, page, offscreen, sender };
}

test('typing filters stale local links without starting or refreshing the node', async () => {
  const f = fixture({ cache: { fetchedAt: 1, links: [{ short: 'foo', long: 'https://example.com', owner: 'test' }] } });
  f.background.register();
  let found;
  await f.chrome.omnibox.onInputChanged.listeners[0]('fo', values => { found = values; });
  assert.equal(found[0].content, 'foo');
  assert.equal(f.calls.filter(([method]) => method !== 'rules').length, 0);
});

test('omnibox opens the pending page first in each requested disposition', async () => {
  for (const [disposition, expected] of [
    ['currentTab', { action: 'update', id: 7, url: 'chrome-extension://extension/status.html?resolve=foo%2Fa%252Fb%3Fx%3D1%26x%3D2' }],
    ['newForegroundTab', { action: 'create', active: true, url: 'chrome-extension://extension/status.html?resolve=foo%2Fa%252Fb%3Fx%3D1%26x%3D2' }],
    ['newBackgroundTab', { action: 'create', active: false, url: 'chrome-extension://extension/status.html?resolve=foo%2Fa%252Fb%3Fx%3D1%26x%3D2' }],
  ]) {
    const pending = deferred();
    const f = fixture({ node: { status: () => pending.promise } });
    f.background.register();
    await f.chrome.omnibox.onInputEntered.listeners[0]('go/foo/a%2Fb?x=1&x=2', disposition);
    assert.deepEqual(f.tabs[0], expected);
    assert.equal(f.calls.filter(([method]) => method !== 'rules').length, 0);
  }
});

test('registration synchronously attaches the runtime listener and repairs one persistent redirect rule', async () => {
  const f = fixture();
  f.background.register();
  assert.equal(f.chrome.runtime.onMessage.listeners.length, 1);
  await tick();
  assert.equal(f.rules.length, 1);
  const rule = f.rules[0];
  const input = 'http://go/foo/a%2Fb?x=1&x=2';
  const redirected = input.replace(new RegExp(rule.condition.regexFilter), rule.action.redirect.regexSubstitution.replace('\\1', '$1'));
  assert.equal(redirected, 'chrome-extension://extension/status.html#http://go/foo/a%2Fb?x=1&x=2');
  assert.deepEqual(rule.condition.resourceTypes, ['main_frame']);
  assert.equal(rule.id, 1);
  await f.chrome.runtime.onStartup.listeners[0]();
  assert.equal(f.calls.filter(([method]) => method === 'rules').length, 1);
  f.rules[0].priority = 2;
  await f.chrome.runtime.onInstalled.listeners[0]();
  assert.equal(f.calls.filter(([method]) => method === 'rules').length, 2);
});

test('resolve waits for Running and sends the raw path unchanged', async () => {
  let running = false;
  const f = fixture({ node: { status: () => ({ state: running ? 'Running' : 'NeedsLogin' }), resolve: path => ({ redirect: 'https://target.example/' + path }) } });
  assert.deepEqual(await f.page('resolve', ['foo/a%2Fb?x=1&x=2']), { ok: true, value: { pending: true } });
  assert.equal(f.calls.some(([method]) => method === 'resolve'), false);
  running = true;
  const result = await f.page('resolve', ['foo/a%2Fb?x=1&x=2']);
  assert.equal(result.ok, true);
  assert.deepEqual(f.tabs[0], { action: 'update', id: 42, url: 'https://target.example/foo/a%2Fb?x=1&x=2' });
});

test('only http and https resolve targets navigate the sender tab', async () => {
  for (const target of ['javascript:alert(1)', 'data:text/html,bad', 'file:///etc/passwd', '/relative']) {
    const f = fixture({ node: { resolve: () => ({ redirect: target }) } });
    const reply = await f.page('resolve', ['foo']);
    assert.equal(reply.ok, false, target);
    assert.equal(reply.error.kind, 'url');
    assert.equal(f.tabs.length, 0);
  }
  const f = fixture({ node: { resolve: () => ({ redirect: 'http://example.com/a%2Fb?x=1&x=2#part' }) } });
  const reply = await f.background.handleMessage({ channel: 'golink', target: 'worker', method: 'resolve', args: ['foo'], tabId: 999 }, f.sender);
  assert.equal(reply.ok, true);
  assert.equal(f.tabs[0].id, 42);
  assert.equal(f.tabs[0].url, 'http://example.com/a%2Fb?x=1&x=2#part');
});

test('not found and golink UI resolve results open safe local modes', async () => {
  const missing = fixture({ node: { resolve: () => ({ notFound: true }) } });
  await missing.page('resolve', ['bad<img>/a?x=1']);
  assert.equal(missing.tabs[0].url, 'chrome-extension://extension/status.html?create=bad%3Cimg%3E');
  const ui = fixture({ node: { resolve: () => ({ golinkUI: '/.detail/foo?x=<script>' }) } });
  await ui.page('resolve', ['foo+']);
  assert.equal(ui.tabs[0].url, 'chrome-extension://extension/status.html?golinkUI=%2F.detail%2Ffoo%3Fx%3D%3Cscript%3E');
});

const navigationResults = [
  ['redirect', { redirect: 'https://target.example/foo' }, 'https://target.example/foo'],
  ['create', { notFound: true }, 'chrome-extension://extension/status.html?create=foo'],
  ['golinkUI', { golinkUI: '/.detail/foo' }, 'chrome-extension://extension/status.html?golinkUI=%2F.detail%2Ffoo'],
];

for (const [mode, result, destination] of navigationResults) {
  test(`delayed ${mode} result leaves a navigated-away document alone`, async () => {
    const lookup = deferred(), started = deferred();
    const f = fixture({ node: { resolve() { started.resolve(); return lookup.promise; } } });
    const pending = f.page('resolve', ['foo']);
    await started.promise;
    // Chrome no longer exposes the original extension document after navigation.
    f.contexts.splice(0);
    lookup.resolve(result);
    await pending;
    assert.deepEqual(f.tabs, []);
  });

  for (const sameDocument of [true, false]) {
    test(`delayed ${mode} result cannot replace a newer request in ${sameDocument ? 'the same' : 'a new'} document`, async () => {
      const lookup = deferred(), started = deferred(), newStatus = deferred();
      let statuses = 0;
      const f = fixture({ node: {
        status() { return ++statuses === 1 ? { state: 'Running' } : newStatus.promise; },
        resolve(path) { if (path === 'foo') { started.resolve(); return lookup.promise; } return { redirect: 'https://new.example/bar' }; },
      } });
      const pending = f.page('resolve', ['foo']);
      await started.promise;
      const sender = { ...f.sender, documentId: sameDocument ? f.sender.documentId : 'new-status-document' };
      if (!sameDocument) f.contexts.splice(0, 1, { ...f.contexts[0], documentId: sender.documentId });
      const newer = f.background.handleMessage({ channel: 'golink', target: 'worker', method: 'resolve', args: ['bar'] }, sender);
      lookup.resolve(result);
      await pending;
      assert.deepEqual(f.tabs, []);
      newStatus.resolve({ state: 'Running' });
      assert.equal((await newer).ok, true);
      assert.deepEqual(f.tabs, [{ action: 'update', id: 42, url: 'https://new.example/bar' }]);
    });
  }

  test(`delayed ${mode} result navigates its live originating document`, async () => {
    const lookup = deferred(), started = deferred();
    const f = fixture({ node: { resolve() { started.resolve(); return lookup.promise; } } });
    const pending = f.page('resolve', ['foo']);
    await started.promise;
    lookup.resolve(result);
    assert.equal((await pending).ok, true);
    assert.deepEqual(f.tabs, [{ action: 'update', id: 42, url: destination }]);
  });
}

test('resolve fails closed when the originating document cannot be verified', async () => {
  for (const reason of ['missing document ID', 'missing API', 'API failure', 'wrong tab', 'wrong document', 'subframe']) {
    const f = fixture({ node: { resolve: () => ({ redirect: 'https://target.example/' }) } });
    if (reason === 'missing document ID') delete f.sender.documentId;
    if (reason === 'missing API') delete f.chrome.runtime.getContexts;
    if (reason === 'API failure') f.chrome.runtime.getContexts = async () => { throw new Error('Context lookup failed'); };
    if (reason === 'wrong tab') f.contexts[0].tabId = 99;
    if (reason === 'wrong document') f.contexts[0].documentId = 'other-document';
    if (reason === 'subframe') f.contexts[0].frameId = 1;
    await f.page('resolve', ['foo']);
    assert.deepEqual(f.tabs, [], reason);
  }
});

test('a newer resolve arriving during the document check keeps navigation ownership', async () => {
  const release = deferred();
  const f = fixture({ node: { resolve: path => ({ redirect: 'https://target.example/' + path }) } });
  const getContexts = f.chrome.runtime.getContexts;
  let checks = 0;
  f.chrome.runtime.getContexts = async filter => {
    const contexts = await getContexts(filter);
    if (++checks === 1) await release.promise;
    return contexts;
  };
  const older = f.page('resolve', ['foo']);
  await tick();
  assert.equal((await f.page('resolve', ['bar'])).ok, true);
  release.resolve();
  await older;
  assert.deepEqual(f.tabs, [{ action: 'update', id: 42, url: 'https://target.example/bar' }]);
});

test('unreachable resolves return an error envelope and leave the status tab in place', async () => {
  const f = fixture({ node: { resolve() { throw Object.assign(new Error('Check ACLs for go:80'), { kind: 'unreachable' }); } } });
  assert.deepEqual(await f.page('resolve', ['foo']), { ok: false, error: { kind: 'unreachable', message: 'Check ACLs for go:80' } });
  assert.equal(f.tabs.length, 0);
});

test('page routing rejects foreign senders, offscreen pages, start, persistence, and malformed requests', async () => {
  const f = fixture();
  const request = { channel: 'golink', target: 'worker', method: 'status', args: [] };
  for (const sender of [{ ...f.sender, id: 'foreign' }, { ...f.sender, url: 'https://example.com/status.html' }, { ...f.sender, url: 'chrome-extension://extension/offscreen.html' }, { ...f.sender, url: 'chrome-extension://extension/status.html.evil' }]) {
    assert.equal((await f.background.handleMessage(request, sender)).error.kind, 'unauthorized');
  }
  assert.equal((await f.page('start')).ok, false);
  assert.equal((await f.page('authKey', [''])).ok, false);
  assert.equal((await f.page('resolve', [null])).ok, false);
  assert.equal((await f.background.handleMessage({ ...request, args: {} }, f.sender)).ok, false);
  const persistence = await f.background.handleMessage({ channel: 'golink', target: 'worker', type: 'stateWrite', docId: 'fake', epoch: 1, key: 'key', value: 'bad' }, f.sender);
  assert.equal(persistence.error.kind, 'unauthorized');
  assert.equal(f.calls.length, 0);
});

test('runtime listener keeps the response channel open for async page replies', async () => {
  const f = fixture({ node: { status: () => ({ state: 'NeedsLogin' }) } });
  f.background.register();
  const listener = f.chrome.runtime.onMessage.listeners[0];
  let reply;
  assert.equal(listener({ channel: 'elsewhere' }, f.sender, () => {}), false);
  assert.equal(listener({ channel: 'golink', target: 'worker', method: 'status', args: [] }, f.sender, value => { reply = value; }), true);
  await tick();
  assert.deepEqual(reply, { ok: true, value: { state: 'NeedsLogin' } });
});

test('offscreen events retain the sender and only accepted state events cause browser effects', async () => {
  let accepted = false;
  const f = fixture({ session: storage({ golinkLoginTabId: 77 }), handleEvent: () => ({ ok: true, value: { accepted } }) });
  assert.deepEqual(await f.offscreen({ type: 'state', state: 'Running' }), { ok: true, value: { accepted: false } });
  await tick();
  assert.equal(f.tabs.length, 0);
  assert.equal(f.calls.some(([method]) => method === 'links'), false);
  assert.deepEqual(f.calls[0][2], { id: 'extension', url: 'chrome-extension://extension/offscreen.html' });
  accepted = true;
  assert.deepEqual(await f.offscreen({ type: 'state', state: 'Running' }), { ok: true, value: { accepted: true } });
  await tick();
  assert.deepEqual(f.tabs[0], { action: 'remove', id: 77 });
  assert.equal(f.calls.filter(([method]) => method === 'links').length, 1);
});

test('state write acknowledgements bypass nested node work and preserve stale applied false', async () => {
  const f = fixture({ handleEvent: message => ({ ok: true, value: { applied: message.epoch === 1 } }), node: { links: () => new Promise(() => {}) } });
  assert.deepEqual(await f.offscreen({ type: 'stateWrite', key: 'key', value: 'AA==' }), { ok: true, value: { applied: true } });
  assert.deepEqual(await f.offscreen({ type: 'stateWrite', epoch: 0, key: 'key', value: 'old' }), { ok: true, value: { applied: false } });
  assert.equal(f.calls.filter(([method]) => method !== 'event').length, 0);
});

test('login events reuse one session login tab and durable Running closes it after worker reconstruction', async () => {
  const session = storage();
  const f = fixture({ session });
  assert.deepEqual(await f.page('login'), { ok: true, value: { ok: true } });
  await Promise.all([f.offscreen({ type: 'browseToURL', url: 'https://login.example/one' }), f.offscreen({ type: 'browseToURL', url: 'https://login.example/two' })]);
  assert.equal(f.tabs.filter(tab => tab.action === 'create').length, 1);
  assert.equal(session.data.golinkLoginTabId, 10);
  assert.equal(f.tabs.at(-1).url, 'https://login.example/two');
  const recovered = fixture({ session });
  await recovered.offscreen({ type: 'state', state: 'Running' });
  await tick();
  assert.deepEqual(recovered.tabs[0], { action: 'remove', id: 10 });
  assert.equal(session.data.golinkLoginTabId, undefined);
});

test('browse rejects unsafe URLs and handles an already closed login tab', async () => {
  const f = fixture({ session: storage({ golinkLoginTabId: 99 }) });
  f.chrome.tabs.update = async () => { throw new Error('No tab'); };
  const bad = await f.offscreen({ type: 'browseToURL', url: 'javascript:bad()' });
  assert.equal(bad.ok, false);
  assert.equal(f.tabs.length, 0);
  await f.offscreen({ type: 'browseToURL', url: 'https://login.example' });
  assert.equal(f.tabs[0].action, 'create');
  f.chrome.tabs.remove = async () => { throw new Error('No tab'); };
  await f.offscreen({ type: 'state', state: 'Running' });
  await tick();
  assert.equal(f.chrome.storage.session.data.golinkLoginTabId, undefined);
});

test('cachedLinks is local-only and concurrent stale status requests share one refresh', async () => {
  const links = deferred();
  const f = fixture({ cache: { fetchedAt: 1, links: [{ short: 'old', long: 'https://old', owner: 'test' }] }, node: { links: () => links.promise } });
  assert.equal((await f.page('cachedLinks')).value.links[0].short, 'old');
  assert.equal(f.calls.length, 0);
  await Promise.all([f.page('status'), f.page('status'), f.page('status')]);
  await tick();
  assert.equal(f.calls.filter(([method]) => method === 'links').length, 1);
  links.resolve([{ short: 'new', long: 'https://new', owner: 'test' }]);
  await tick();
  assert.deepEqual(f.local.data.linksCache, { fetchedAt: 1_000_000, links: [{ short: 'new', long: 'https://new', owner: 'test' }] });
});

test('successful save refreshes fresh cache and survives refresh failure', async () => {
  const f = fixture({ cache: { fetchedAt: 999_999, links: [] }, node: { links: () => [{ short: 'saved', long: 'https://saved', owner: 'test' }] } });
  assert.deepEqual(await f.page('save', ['saved', 'https://saved']), { ok: true, value: { ok: true } });
  assert.equal(f.local.data.linksCache.links[0].short, 'saved');
  const failed = fixture({ cache: { fetchedAt: 999_999, links: [] }, node: { links() { throw Object.assign(new Error('temporarily unreachable'), { kind: 'unreachable' }); } } });
  const reply = await failed.page('save', ['saved', 'https://saved']);
  assert.equal(reply.ok, true);
  assert.equal(reply.value.ok, true);
  assert.deepEqual(reply.value.cacheRefreshError, { kind: 'unreachable', message: 'temporarily unreachable' });
  assert.deepEqual(failed.local.data.linksCache, { fetchedAt: 999_999, links: [] });
});

test('reset fences an older links request so its late completion cannot restore cleared cache', async () => {
  const links = deferred();
  const f = fixture({ cache: { fetchedAt: 1, links: [] }, node: { links: () => links.promise } });
  await f.page('status');
  await tick();
  assert.equal(f.calls.some(([method]) => method === 'links'), true);
  assert.deepEqual(await f.page('reset'), { ok: true, value: { ok: true } });
  links.resolve([{ short: 'old', long: 'https://old', owner: 'test' }]);
  await tick();
  assert.equal(f.local.data.linksCache, undefined);
  assert.deepEqual(f.calls.find(([method]) => method === 'restart'), ['restart', { clear: true, reset: true }]);
});

test('logout, auth key, and configuration use lifecycle replacement with no key persistence', async () => {
  const f = fixture();
  assert.equal((await f.page('logout')).ok, true);
  assert.deepEqual(f.calls.at(-1), ['restart', { clear: true }]);
  assert.equal((await f.page('authKey', ['tskey-secret'])).ok, true);
  assert.deepEqual(f.calls.at(-1), ['restart', { clear: true, authKey: 'tskey-secret' }]);
  assert.equal(JSON.stringify(f.local.data).includes('tskey-secret'), false);
  assert.equal((await f.page('configure', [{ golinkHost: 'go.example.ts.net', controlURL: 'https://control.example' }])).ok, true);
  assert.equal(f.local.data.golinkHost, 'go.example.ts.net');
  assert.equal(f.local.data.controlURL, 'https://control.example');
  assert.deepEqual(f.calls.at(-1), ['restart', { clear: false }]);
  assert.equal((await f.page('configure', [{ golinkHost: 'https://evil/path' }])).ok, false);
});

test('the empty root path resolves to the golink UI explanation', async () => {
  const f = fixture({ node: { resolve: path => { assert.equal(path, ''); return { golinkUI: '/' }; } } });
  assert.deepEqual(await f.page('resolve', ['']), { ok: true, value: { golinkUI: '/' } });
  assert.equal(f.tabs[0].url, 'chrome-extension://extension/status.html?golinkUI=%2F');
});

test('an equivalent Chrome rule with reordered object keys does not cause a repair', async () => {
  const f = fixture();
  f.rules.push({ condition: { resourceTypes: ['main_frame'], regexFilter: '^(http://go/.*)$' }, action: { redirect: { regexSubstitution: 'chrome-extension://extension/status.html#\\1' }, type: 'redirect' }, priority: 1, id: 1 });
  f.background.register();
  await tick();
  assert.equal(f.calls.filter(([method]) => method === 'rules').length, 0);
});

test('rejected browse events cannot open a login tab', async () => {
  const f = fixture({ handleEvent: () => ({ ok: true, value: { accepted: false } }) });
  await f.offscreen({ type: 'browseToURL', url: 'https://login.example' });
  assert.equal(f.tabs.length, 0);
});

test('reset waits for a cache write already in progress before clearing it', async () => {
  const f = fixture();
  const writing = deferred(), release = deferred();
  const set = f.local.set;
  f.local.set = async values => {
    if (values.linksCache) { writing.resolve(); await release.promise; }
    await set(values);
  };
  await f.page('status');
  await writing.promise;
  let complete = false;
  const resetting = f.page('reset').then(reply => { complete = true; return reply; });
  await tick();
  assert.equal(complete, false);
  release.resolve();
  assert.equal((await resetting).ok, true);
  assert.equal(f.local.data.linksCache, undefined);
});

test('real worker registration routes durable writes through lifecycle without deadlock and injects session storage', { timeout: 2000 }, async t => {
  const f = fixture({ session: storage({ golinkLoginTabId: 77 }) });
  const { chrome } = f;
  let bridge, contexts = [], documentNumber = 0;
  const bridges = [], responses = [];
  const writing = deferred(), release = deferred();
  const set = f.local.set;
  f.local.set = async values => {
    if (values.tsState?.values.identity === 'aWQ=') { writing.resolve(); await release.promise; }
    await set(values);
  };
  const getTabContexts = chrome.runtime.getContexts;
  chrome.runtime.getContexts = async filter => filter.contextTypes.includes('TAB') ? getTabContexts(filter) : contexts;
  chrome.runtime.sendMessage = message => new Promise((resolve, reject) => {
    const sender = { id: 'extension', url: chrome.runtime.getURL(message.target === 'worker' ? 'offscreen.html' : 'background.js') };
    let handled = false;
    for (const listener of chrome.runtime.onMessage.listeners) {
      if (listener(message, sender, reply => { responses.push([message, reply]); resolve(reply); }) === true) handled = true;
    }
    if (!handled) reject(new Error('No receiving end'));
  });
  chrome.offscreen = {
    async createDocument() {
      contexts = [{ documentUrl: chrome.runtime.getURL('offscreen.html') }];
      const number = ++documentNumber;
      const state = number === 1 ? 'Running' : 'NeedsLogin';
      const api = {
        async start(_config, callbacks) {
          if (number === 1) callbacks.onStateWrite('identity', 'aWQ=');
          callbacks.onState(state);
          return { ok: true };
        },
        async status() { return { state, loginName: 'test', tailnet: 'tailnet', hostname: 'golink-ext-aabbcc', golinkReachable: state === 'Running' }; },
        async login() { return { ok: true }; }, async logout() { return { ok: true }; },
        async resolve() { return { redirect: 'https://target.example' }; }, async save() { return { ok: true }; }, async links() { return []; },
      };
      bridge = createOffscreenBridge({ runtime: chrome.runtime, docId: 'doc-' + number, timeoutMs: 500, loadGo: async () => ({ apiReady: Promise.resolve(api), exited: new Promise(() => {}) }) });
      bridges.push(bridge);
    },
    async closeDocument() { contexts = []; bridge.dispose(); bridge = undefined; },
  };
  globalThis.chrome = chrome;
  t.after(() => { delete globalThis.chrome; for (const item of bridges) item.dispose(); });
  await import('../ext/background.js?real-worker-integration');
  assert.equal(chrome.runtime.onMessage.listeners.length, 1);
  const request = (method, args = []) => new Promise(resolve => {
    assert.equal(chrome.runtime.onMessage.listeners[0]({ channel: 'golink', target: 'worker', method, args }, f.sender, resolve), true);
  });
  let finished = false;
  const status = request('status').then(reply => { finished = true; return reply; });
  await writing.promise;
  assert.equal(finished, false);
  assert.deepEqual(f.local.data.tsState.values, {});
  assert.equal(f.tabs.length, 0);
  release.resolve();
  assert.equal((await status).value.state, 'Running');
  await tick();
  assert.deepEqual(f.local.data.tsState.values, { identity: 'aWQ=' });
  assert.equal(chrome.storage.session.data.golinkOffscreenUsed, true);
  assert.deepEqual(f.tabs[0], { action: 'remove', id: 77 });
  assert.equal((await request('resolve', ['foo'])).ok, true);
  assert.deepEqual(f.tabs[1], { action: 'update', id: 42, url: 'https://target.example' });
  assert.deepEqual(await request('reset'), { ok: true, value: { ok: true } });
  assert.equal(f.local.data.tsState.epoch, 2);
  assert.deepEqual(f.local.data.tsState.values, {});
  const late = await chrome.runtime.sendMessage({ channel: 'golink', target: 'worker', type: 'stateWrite', docId: 'doc-1', epoch: 1, key: 'identity', value: 'b2xk' });
  assert.deepEqual(late, { ok: true, value: { applied: false } });
  assert.deepEqual(f.local.data.tsState.values, {});
  assert.equal(responses.some(([message, reply]) => message.type === 'stateWrite' && reply.value.applied === true), true);
});

for (const [method, args] of [
  ['configure', [{ golinkHost: 'go.example.ts.net' }]],
  ['authKey', ['tskey-replacement']],
]) {
  test(`${method} refreshes once when replacement Running arrives before restart completes`, async () => {
    const acknowledged = deferred(), finishRestart = deferred();
    const links = [{ short: 'replacement', long: 'https://replacement.example', owner: 'test' }];
    const f = fixture({
      cache: { fetchedAt: 999_999, links: [{ short: 'old', long: 'https://old.example', owner: 'test' }] },
      node: {
        links: () => links,
        async restart(options) {
          const current = f.local.data.tsState;
          f.local.data.tsState = { epoch: current.epoch + 1, values: options.clear ? {} : current.values };
          if (options.clear) delete f.local.data.linksCache;
          const event = { type: 'state', state: 'Running', epoch: current.epoch + 1 };
          assert.deepEqual(await f.offscreen(event), { ok: true, value: { accepted: true } });
          assert.deepEqual(await f.offscreen(event), { ok: true, value: { accepted: true } });
          acknowledged.resolve();
          await finishRestart.promise;
          return { ok: true };
        },
      },
    });
    const replacing = f.page(method, args);
    await acknowledged.promise;
    assert.equal(f.calls.filter(([name]) => name === 'links').length, 0);
    assert.equal(f.local.data.linksCache, undefined);
    finishRestart.resolve();
    assert.deepEqual(await replacing, { ok: true, value: { ok: true } });
    await tick();
    assert.deepEqual(f.local.data.linksCache, { fetchedAt: 1_000_000, links });
    assert.equal(f.calls.filter(([name]) => name === 'links').length, 1);
    assert.equal(f.calls.some(([name]) => name === 'status' || name === 'resolve'), false);
  });
}
