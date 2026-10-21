import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createStateStore } from '../ext/state.js';
import { createLifecycle } from '../ext/lifecycle.js';
import { createOffscreenBridge } from '../ext/offscreen.js';

globalThis.crypto ??= webcrypto;
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
async function until(check) {
  const deadline = Date.now() + 500;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Test condition timed out');
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function memoryStorage(initial = {}) {
  const data = structuredClone(initial);
  return {
    async get(keys) { return Object.fromEntries(keys.map(key => [key, structuredClone(data[key])])); },
    async set(values) { Object.assign(data, structuredClone(values)); },
    async remove(keys) { for (const key of [].concat(keys)) delete data[key]; },
  };
}
const defaults = {
  tsState: { epoch: 1, values: {} }, hostname: 'golink-ext-abcdef',
  golinkHost: 'go', controlURL: 'https://controlplane.tailscale.com',
};
function fixture({ apiFactory, ready = true, timeoutMs = 1000, storage = memoryStorage(defaults), session = memoryStorage(), now = () => 1000 } = {}) {
  const calls = [], events = [], apis = [], bridges = [];
  let contexts = [], bridge, lifecycle, createCount = 0, closeCount = 0;
  const loading = deferred();
  if (ready) loading.resolve();
  const sender = name => ({ id: 'test', url: `chrome-extension://test/${name}` });
  const runtime = {
    id: 'test', getURL: name => `chrome-extension://test/${name}`,
    async getContexts() { return contexts; },
    async sendMessage(message) {
      calls.push(structuredClone(message));
      if (message.target === 'worker') {
        events.push(structuredClone(message));
        return lifecycle.handleEvent(message, sender('offscreen.html'));
      }
      if (!bridge) throw new Error('No receiving end');
      return bridge.handleMessage(message, sender('background.js'));
    },
  };
  const offscreen = {
    async createDocument(options) {
      createCount++;
      assert.deepEqual(options.reasons, ['WORKERS']);
      contexts = [{ documentUrl: runtime.getURL('offscreen.html') }];
      let callbacks;
      const api = {
        start: async (config, handlers) => { callbacks = handlers; return { ok: true }; },
        status: async () => ({ state: 'NeedsLogin', loginName: '', tailnet: '', hostname: defaults.hostname, golinkReachable: false }),
        login: async () => ({ ok: true }), logout: async () => ({ ok: true }),
        resolve: async () => ({ notFound: true }), save: async () => ({ ok: true }), links: async () => [],
      };
      apiFactory?.(api, () => callbacks);
      apis.push(api);
      bridge = createOffscreenBridge({ runtime, docId: `doc-${createCount}`, timeoutMs,
        loadGo: async () => ({ apiReady: loading.promise.then(() => api), exited: new Promise(() => {}) }),
      });
      bridges.push(bridge);
    },
    async closeDocument() { closeCount++; contexts = []; bridge?.dispose(); bridge = undefined; },
  };
  const store = createStateStore(storage);
  const construct = () => createLifecycle({ runtime, offscreen, store, session, now, timeoutMs });
  lifecycle = construct();
  return {
    runtime, offscreen, store, storage, session, calls, events, apis, bridges, loading,
    get lifecycle() { return lifecycle; }, get bridge() { return bridge; },
    get createCount() { return createCount; }, get closeCount() { return closeCount; },
    sender, reconstruct() { lifecycle.dispose(); lifecycle = construct(); return lifecycle; },
    async removeDocument() { await offscreen.closeDocument(); },
    async dispose() { lifecycle.dispose(); for (const item of bridges) item.dispose(); },
  };
}

test('twenty ensures share one document and never start before API readiness', async t => {
  const f = fixture({ ready: false });
  t.after(() => f.dispose());
  const pending = Array.from({ length: 20 }, () => f.lifecycle.ensureOffscreen());
  await nextTurn();
  assert.equal(f.createCount, 1);
  assert.equal(f.calls.filter(call => call.method === 'start').length, 0);
  f.loading.resolve();
  const results = await Promise.all(pending);
  assert.deepEqual(results, Array.from({ length: 20 }, () => ({ docId: 'doc-1', epoch: 1 })));
  assert.equal(f.calls.filter(call => call.method === 'start').length, 1);
});

test('a restarted worker recovers hello and reuses the started document and epoch', async t => {
  const f = fixture();
  t.after(() => f.dispose());
  await f.lifecycle.ensureOffscreen();
  f.reconstruct();
  assert.deepEqual(await f.lifecycle.ensureOffscreen(), { docId: 'doc-1', epoch: 1 });
  assert.equal(f.createCount, 1);
  assert.equal(f.calls.filter(call => call.method === 'start').length, 1);
});

test('hello works while compiling and recovers a missed ready event', async t => {
  const f = fixture({ ready: false });
  t.after(() => f.dispose());
  await f.offscreen.createDocument({ reasons: ['WORKERS'] });
  const hello = await f.bridge.handleMessage({ channel: 'golink', target: 'offscreen', method: 'hello', requestId: 'hello', args: [] }, f.sender('background.js'));
  assert.deepEqual(hello, { ok: true, value: { docId: 'doc-1', ready: false, started: false, epoch: null } });
  f.loading.resolve();
  await nextTurn();
  f.reconstruct();
  assert.deepEqual(await f.lifecycle.ensureOffscreen(), { docId: 'doc-1', epoch: 1 });
  assert.equal(f.createCount, 1);
});

function request(f, method, args = [], identity = { docId: 'doc-1', epoch: 1 }) {
  return f.bridge.handleMessage({ channel: 'golink', target: 'offscreen', requestId: 'direct', method, args, ...identity }, f.sender('background.js'));
}

test('start holds Running and completion until state writes are durable', async t => {
  const ack = deferred();
  const storage = memoryStorage(defaults);
  const set = storage.set.bind(storage);
  storage.set = async values => { await ack.promise; await set(values); };
  const f = fixture({ storage, apiFactory(api) {
    api.start = async (_config, callbacks) => {
      callbacks.onStateWrite('identity', 'aWQ=');
      callbacks.onState('Running');
      return { ok: true };
    };
  } });
  t.after(() => f.dispose());
  let completed = false;
  const start = f.lifecycle.ensureOffscreen().then(value => { completed = true; return value; });
  await until(() => f.events.some(event => event.type === 'stateWrite'));
  assert.equal(completed, false);
  assert.equal(f.events.some(event => event.type === 'state' && event.state === 'Running'), false);
  assert.deepEqual((await storage.get(['tsState'])).tsState.values, {});
  ack.resolve();
  await start;
  await nextTurn();
  assert.deepEqual((await f.store.snapshot()).values, { identity: 'aWQ=' });
  assert.equal(f.events.some(event => event.type === 'state' && event.state === 'Running'), true);
});

test('Running status and login completion share the persistence barrier and preserve state publication order', async t => {
  let callbacks;
  const f = fixture({ apiFactory(api) {
    api.start = async (_config, handlers) => { callbacks = handlers; return { ok: true }; };
    api.login = async () => {
      callbacks.onStateWrite('identity', 'aWQ=');
      callbacks.onState('Running');
      callbacks.onState('NeedsLogin');
      return { ok: true };
    };
    api.status = async () => ({ state: 'Running' });
  } });
  t.after(() => f.dispose());
  await f.lifecycle.ensureOffscreen();
  const ack = deferred();
  const set = f.storage.set.bind(f.storage);
  f.storage.set = async values => { await ack.promise; await set(values); };
  let loginDone = false, statusDone = false;
  const login = request(f, 'login').then(value => { loginDone = true; return value; });
  await nextTurn();
  const status = request(f, 'status').then(value => { statusDone = true; return value; });
  await nextTurn();
  assert.equal(loginDone, false);
  assert.equal(statusDone, false);
  assert.deepEqual(f.events.filter(event => event.type === 'state'), []);
  ack.resolve();
  assert.deepEqual(await login, { ok: true, value: { ok: true } });
  assert.deepEqual(await status, { ok: true, value: { state: 'Running' } });
  await nextTurn();
  assert.deepEqual(f.events.filter(event => event.type === 'state').map(event => event.state), ['Running', 'NeedsLogin']);
});

test('failed persistence fails startup, suppresses Running, and emits one fatal', async t => {
  const storage = memoryStorage(defaults);
  storage.set = async () => { throw new Error('storage quota exceeded'); };
  const f = fixture({ storage, apiFactory(api) {
    api.start = async (_config, callbacks) => {
      callbacks.onStateWrite('identity', 'aWQ=');
      callbacks.onState('Running');
      callbacks.onStateWrite('another', 'aWQ=');
      return { ok: true };
    };
  } });
  t.after(() => f.dispose());
  await assert.rejects(f.lifecycle.ensureOffscreen(), /storage quota exceeded/);
  await nextTurn();
  assert.equal(f.events.filter(event => event.type === 'fatal').length, 1);
  assert.equal(f.events.some(event => event.type === 'state' && event.state === 'Running'), false);
  assert.deepEqual((await f.store.snapshot()).values, {});
});

test('logout waits for identity deletion and null differs from empty state', async t => {
  let callbacks;
  const f = fixture({ storage: memoryStorage({ ...defaults, tsState: { epoch: 1, values: { identity: 'aWQ=' } } }), apiFactory(api) {
    api.start = async (_config, handlers) => { callbacks = handlers; return { ok: true }; };
    api.logout = async () => {
      callbacks.onStateWrite('identity', null);
      callbacks.onStateWrite('empty', '');
      return { ok: true };
    };
  } });
  t.after(() => f.dispose());
  await f.lifecycle.ensureOffscreen();
  const ack = deferred();
  const set = f.storage.set.bind(f.storage);
  f.storage.set = async values => { await ack.promise; await set(values); };
  let done = false;
  const logout = f.lifecycle.call('logout').then(value => { done = true; return value; });
  await nextTurn();
  assert.equal(done, false);
  ack.resolve();
  await logout;
  assert.deepEqual((await f.store.snapshot()).values, { empty: '' });
});

test('bridge rejects arbitrary methods, wrong senders, documents and epochs', async t => {
  const f = fixture();
  t.after(() => f.dispose());
  await f.lifecycle.ensureOffscreen();
  for (const method of ['constructor', 'toString', 'reset', 'authKey']) assert.equal((await request(f, method)).ok, false);
  assert.equal((await request(f, 'status', [], { docId: 'old', epoch: 1 })).ok, false);
  assert.equal((await request(f, 'status', [], { docId: 'doc-1', epoch: 2 })).ok, false);
  const message = { channel: 'golink', target: 'offscreen', requestId: 'invalid', method: 'status', args: [], docId: 'doc-1', epoch: 1 };
  assert.equal((await f.bridge.handleMessage(message, f.sender('status.html'))).ok, false);
  assert.equal((await f.bridge.handleMessage(message, { id: 'evil', url: f.runtime.getURL('background.js') })).ok, false);
  await assert.rejects(f.lifecycle.call('start'), /Unknown node method/);
});

test('missing documents advance the epoch and preserve durable identity', async t => {
  const configs = [];
  const f = fixture({ apiFactory(api) { api.start = async config => { configs.push(structuredClone(config)); return { ok: true }; }; } });
  t.after(() => f.dispose());
  await f.lifecycle.ensureOffscreen();
  await f.store.write({ epoch: 1, key: 'identity', value: 'aWQ=' });
  await f.removeDocument();
  assert.deepEqual(await f.lifecycle.ensureOffscreen(), { docId: 'doc-2', epoch: 2 });
  assert.deepEqual(configs[1].state, { identity: 'aWQ=' });
});

test('failed startup closes the document and permits a later retry', async t => {
  let attempts = 0;
  const f = fixture({ apiFactory(api) { api.start = async () => { if (++attempts === 1) throw new Error('Start failed'); return { ok: true }; }; } });
  t.after(() => f.dispose());
  await assert.rejects(f.lifecycle.ensureOffscreen(), /Start failed/);
  assert.equal(f.closeCount, 1);
  assert.deepEqual(await f.lifecycle.ensureOffscreen(), { docId: 'doc-2', epoch: 2 });
});

test('readiness is bounded and a timed out startup releases the operation gate', async t => {
  const f = fixture({ ready: false, timeoutMs: 30 });
  t.after(() => f.dispose());
  await assert.rejects(f.lifecycle.ensureOffscreen(), /timed out/);
  f.loading.resolve();
  assert.equal((await f.lifecycle.call('status')).state, 'NeedsLogin');
});

test('reset while a login write awaits acknowledgement finishes with an empty new epoch', async t => {
  let callbacks;
  const f = fixture({ storage: memoryStorage({ ...defaults, linksCache: { fetchedAt: 123, links: [] } }), apiFactory(api) {
    api.start = async (_config, handlers) => { callbacks = handlers; return { ok: true }; };
    api.login = async () => { callbacks.onStateWrite('identity', 'aWQ='); return { ok: true }; };
  } });
  t.after(() => f.dispose());
  await f.lifecycle.ensureOffscreen();
  const ack = deferred();
  const set = f.storage.set.bind(f.storage);
  f.storage.set = async values => { await ack.promise; await set(values); };
  const login = f.lifecycle.call('login');
  await until(() => f.events.some(event => event.type === 'stateWrite'));
  const reset = f.lifecycle.restart({ clear: true, reset: true });
  const after = f.lifecycle.call('status');
  await nextTurn();
  assert.equal(f.createCount, 1);
  ack.resolve();
  await Promise.all([login, reset, after]);
  assert.equal(f.createCount, 2);
  assert.deepEqual(await f.store.snapshot(), { epoch: 2, values: {} });
  assert.equal((await f.storage.get(['linksCache'])).linksCache, undefined);
  assert.deepEqual(await f.lifecycle.handleEvent({ channel: 'golink', target: 'worker', type: 'stateWrite', docId: 'doc-1', epoch: 1, key: 'identity', value: 'b2xk' }, f.sender('offscreen.html')), { ok: true, value: { applied: false } });
  assert.deepEqual(await f.store.snapshot(), { epoch: 2, values: {} });
});

test('logout errors stop replacement; reset can ignore them and clears only after closing', async t => {
  const f = fixture({ storage: memoryStorage({ ...defaults, tsState: { epoch: 1, values: { identity: 'aWQ=' } } }), apiFactory(api) {
    api.logout = async () => { throw new Error('Backend logout failed'); };
  } });
  t.after(() => f.dispose());
  await f.lifecycle.ensureOffscreen();
  await assert.rejects(f.lifecycle.restart({ clear: true }), /Backend logout failed/);
  assert.equal(f.closeCount, 0);
  assert.deepEqual((await f.store.snapshot()).values, { identity: 'aWQ=' });
  const close = f.offscreen.closeDocument.bind(f.offscreen);
  f.offscreen.closeDocument = async () => {
    assert.deepEqual((await f.store.snapshot()).values, { identity: 'aWQ=' });
    await close();
  };
  await f.lifecycle.restart({ clear: true, reset: true });
  assert.deepEqual(await f.store.snapshot(), { epoch: 3, values: {} });
});

test('cache removal failure is exposed and cannot report a successful reset', async t => {
  const f = fixture();
  t.after(() => f.dispose());
  await f.lifecycle.ensureOffscreen();
  f.storage.remove = async () => { throw new Error('Cache removal failed'); };
  await assert.rejects(f.lifecycle.restart({ clear: true, reset: true }), /Cache removal failed/);
  assert.equal(f.closeCount, 1);
  assert.equal(f.createCount, 1);
  assert.deepEqual(await f.store.snapshot(), { epoch: 2, values: {} });
});

test('auth keys start a replacement only from NeedsLogin and never reach storage', async t => {
  const configs = [];
  let state = 'Running';
  const f = fixture({ apiFactory(api) {
    api.start = async config => { configs.push(structuredClone(config)); return { ok: true }; };
    api.status = async () => ({ state });
  } });
  t.after(() => f.dispose());
  await f.lifecycle.ensureOffscreen();
  await assert.rejects(f.lifecycle.restart({ clear: true, authKey: 'tskey-secret' }), /NeedsLogin/);
  assert.equal(f.createCount, 1);
  state = 'NeedsLogin';
  await f.lifecycle.restart({ clear: true, authKey: 'tskey-secret' });
  assert.equal(configs[1].authKey, 'tskey-secret');
  assert.deepEqual(await f.store.snapshot(), { epoch: 2, values: {} });
  assert.equal(JSON.stringify(await f.storage.get(['tsState', 'hostname', 'golinkHost', 'controlURL', 'authKey'])).includes('tskey-secret'), false);
  assert.equal(JSON.stringify(await f.session.get(['golinkFatalTimestamps', 'golinkOffscreenUsed', 'authKey'])).includes('tskey-secret'), false);
  await f.removeDocument();
  await f.lifecycle.ensureOffscreen();
  assert.equal(configs[2].authKey, undefined);
});

test('a worker awakened by a write validates hello without starting or deadlocking the node', async t => {
  let callbacks;
  const f = fixture({ apiFactory(api) { api.start = async (_config, handlers) => { callbacks = handlers; return { ok: true }; }; } });
  t.after(() => f.dispose());
  await f.lifecycle.ensureOffscreen();
  f.reconstruct();
  callbacks.onStateWrite('identity', 'aWQ=');
  await until(() => f.events.some(event => event.type === 'stateWrite'));
  await f.store.idle();
  assert.deepEqual((await f.store.snapshot()).values, { identity: 'aWQ=' });
  assert.equal(f.calls.filter(call => call.method === 'start').length, 1);
});

test('worker rejects spoofed events and stale document or epoch callbacks', async t => {
  const f = fixture();
  t.after(() => f.dispose());
  await f.lifecycle.ensureOffscreen();
  const event = { channel: 'golink', target: 'worker', type: 'state', docId: 'doc-1', epoch: 1, state: 'Running' };
  assert.equal((await f.lifecycle.handleEvent(event, f.sender('status.html'))).ok, false);
  assert.equal((await f.lifecycle.handleEvent(event, { id: 'evil', url: f.runtime.getURL('offscreen.html') })).ok, false);
  assert.equal((await f.lifecycle.handleEvent({ ...event, docId: 'old' }, f.sender('offscreen.html'))).ok, false);
  assert.equal((await f.lifecycle.handleEvent({ ...event, epoch: 2 }, f.sender('offscreen.html'))).ok, false);
  assert.equal((await f.lifecycle.handleEvent({ ...event, type: 'unknown' }, f.sender('offscreen.html'))).ok, false);
});

test('two fatals across worker reconstruction stop recovery until expiry', async t => {
  let callbacks, time = 1000;
  const f = fixture({ now: () => time, apiFactory(api) { api.start = async (_config, handlers) => { callbacks = handlers; return { ok: true }; }; } });
  t.after(() => f.dispose());
  await f.lifecycle.ensureOffscreen();
  callbacks.onFatal('First crash');
  callbacks.onFatal('Duplicate crash');
  await until(() => f.closeCount === 1);
  assert.deepEqual((await f.session.get(['golinkFatalTimestamps'])).golinkFatalTimestamps, [1000]);
  await f.lifecycle.ensureOffscreen();
  f.reconstruct();
  time = 2000;
  callbacks.onFatal('Second crash');
  await until(() => f.closeCount === 2);
  await assert.rejects(f.lifecycle.ensureOffscreen(), /fatal|crash/i);
  assert.equal(f.createCount, 2);
  time = 62_001;
  assert.deepEqual(await f.lifecycle.ensureOffscreen(), { docId: 'doc-3', epoch: 3 });
});

test('explicit reset clears a blocked crash window without reentering the operation gate', async t => {
  let callbacks;
  const f = fixture({ apiFactory(api) { api.start = async (_config, handlers) => { callbacks = handlers; return { ok: true }; }; } });
  t.after(() => f.dispose());
  await f.lifecycle.ensureOffscreen();
  callbacks.onFatal('First crash');
  await until(() => f.closeCount === 1);
  await f.lifecycle.ensureOffscreen();
  callbacks.onFatal('Second crash');
  await until(() => f.closeCount === 2);
  await assert.rejects(f.lifecycle.ensureOffscreen(), /fatal|crash/i);
  await f.lifecycle.restart({ clear: true, reset: true });
  assert.deepEqual((await f.session.get(['golinkFatalTimestamps'])).golinkFatalTimestamps, []);
  assert.deepEqual(await f.store.snapshot(), { epoch: 3, values: {} });
});

test('fatal events reject an RPC whose transport never replies', async t => {
  let callbacks;
  const f = fixture({ apiFactory(api) { api.start = async (_config, handlers) => { callbacks = handlers; return { ok: true }; }; } });
  t.after(() => f.dispose());
  await f.lifecycle.ensureOffscreen();
  const send = f.runtime.sendMessage.bind(f.runtime);
  let requested = false;
  f.runtime.sendMessage = message => {
    if (message.method === 'resolve') { requested = true; return new Promise(() => {}); }
    return send(message);
  };
  const pending = f.lifecycle.call('resolve', ['docs']);
  const rejected = assert.rejects(pending, /Node crashed/);
  await until(() => requested);
  callbacks.onFatal('Node crashed');
  await rejected;
});

function standaloneBridge(loadGo, timeoutMs = 100) {
  const events = [], listeners = [];
  const runtime = {
    id: 'test', getURL: name => `chrome-extension://test/${name}`,
    onMessage: { addListener(listener) { listeners.push(listener); }, removeListener(listener) { listeners.splice(listeners.indexOf(listener), 1); } },
    async sendMessage(message) { events.push(message); return { ok: true }; },
  };
  const bridge = createOffscreenBridge({ runtime, docId: 'standalone', timeoutMs, loadGo: () => loadGo(listeners) });
  return { bridge, events, runtime, listeners };
}

test('listener registration precedes WASM loading and failed loads emit one fatal', async t => {
  const f = standaloneBridge(listeners => {
    assert.equal(listeners.length, 1);
    throw new Error('WASM compilation failed');
  });
  t.after(() => f.bridge.dispose());
  await until(() => f.events.some(event => event.type === 'fatal'));
  assert.equal(f.events.filter(event => event.type === 'fatal').length, 1);
  assert.equal(f.events[0].message, 'WASM compilation failed');
});

test('normal and rejected Go exits emit one fatal and fail pending calls', async t => {
  for (const rejectExit of [false, true]) {
    const exit = deferred();
    const f = standaloneBridge(() => ({ apiReady: new Promise(() => {}), exited: exit.promise }));
    t.after(() => f.bridge.dispose());
    await nextTurn();
    if (rejectExit) exit.reject(new Error('Go runtime rejected')); else exit.resolve();
    await until(() => f.events.some(event => event.type === 'fatal'));
    assert.equal(f.events.filter(event => event.type === 'fatal').length, 1);
    const reply = await f.bridge.handleMessage({ channel: 'golink', target: 'offscreen', method: 'start', args: [{}], docId: 'standalone', epoch: 1, requestId: 'exit' }, { id: 'test', url: f.runtime.getURL('background.js') });
    assert.equal(reply.ok, false);
    assert.match(reply.error.message, /exit|reject/i);
  }
});

test('same-session worker reconstruction advances an empty identity when its document is missing', async t => {
  const f = fixture();
  t.after(() => f.dispose());
  assert.deepEqual(await f.lifecycle.ensureOffscreen(), { docId: 'doc-1', epoch: 1 });
  await f.removeDocument();
  f.reconstruct();
  assert.deepEqual(await f.lifecycle.ensureOffscreen(), { docId: 'doc-2', epoch: 2 });
  assert.deepEqual((await f.store.snapshot()).values, {});
  assert.equal((await f.storage.get(['hostname'])).hostname, 'golink-ext-abcdef');
});

test('worker recovery during a start attaches to the existing start without waiting on its own write', async t => {
  let callbacks, starts = 0;
  const f = fixture({ apiFactory(api) {
    api.start = async (_config, handlers) => {
      callbacks = handlers;
      starts++;
      callbacks.onStateWrite('identity', 'aWQ=');
      return { ok: true };
    };
  } });
  t.after(() => f.dispose());
  const ack = deferred();
  const set = f.storage.set.bind(f.storage);
  f.storage.set = async values => { await ack.promise; await set(values); };
  const oldStart = f.lifecycle.ensureOffscreen();
  const oldRejected = assert.rejects(oldStart, /disposed/);
  await until(() => f.events.some(event => event.type === 'stateWrite'));
  f.reconstruct();
  const recovered = f.lifecycle.ensureOffscreen();
  ack.resolve();
  await oldRejected;
  assert.deepEqual(await recovered, { docId: 'doc-1', epoch: 1 });
  assert.equal(f.createCount, 1);
  assert.deepEqual((await f.store.snapshot()).values, { identity: 'aWQ=' });
  assert.equal(starts, 1);
});

test('hello rejects explicitly supplied stale epochs and bridge preserves typed Go failures', async t => {
  const f = fixture({ apiFactory(api) { api.resolve = async () => ({ error: 'golink unreachable', kind: 'unreachable' }); } });
  t.after(() => f.dispose());
  await f.lifecycle.ensureOffscreen();
  assert.equal((await request(f, 'hello', [], { docId: 'doc-1', epoch: 2 })).ok, false);
  assert.deepEqual(await request(f, 'resolve', ['docs']), { ok: false, error: { kind: 'unreachable', message: 'golink unreachable' } });
});

test('a slow hello cannot extend the overall readiness deadline', async t => {
  const f = fixture({ ready: false, timeoutMs: 1000 });
  const lifecycle = createLifecycle({ runtime: f.runtime, offscreen: f.offscreen, store: f.store, session: f.session, timeoutMs: 100 });
  t.after(() => { lifecycle.dispose(); return f.dispose(); });
  const send = f.runtime.sendMessage.bind(f.runtime);
  let probes = 0;
  f.runtime.sendMessage = async message => {
    if (message.method === 'hello') {
      if (++probes === 1) await new Promise(resolve => setTimeout(resolve, 80));
      else return new Promise(() => {});
    }
    return send(message);
  };
  const began = Date.now();
  await assert.rejects(lifecycle.ensureOffscreen(), /timed out/);
  assert.ok(Date.now() - began < 160, 'readiness must share one deadline across hello probes');
});
