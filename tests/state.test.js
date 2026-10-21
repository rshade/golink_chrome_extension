import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createStateStore } from '../ext/state.js';

globalThis.crypto ??= webcrypto;

const defaults = {
  tsState: { epoch: 1, values: {} },
  hostname: 'golink-ext-abcdef',
  golinkHost: 'go',
  controlURL: 'https://controlplane.tailscale.com',
};

function deferred() {
  let resolve;
  const promise = new Promise(complete => { resolve = complete; });
  return { promise, resolve };
}

function nextTurn() {
  return new Promise(resolve => setImmediate(resolve));
}

function memoryStorage(initial = {}) {
  const data = structuredClone(initial);
  return {
    async get(keys) {
      return Object.fromEntries(keys.map(key => [key, structuredClone(data[key])]));
    },
    async set(values) {
      Object.assign(data, structuredClone(values));
    },
    async remove(keys) {
      for (const key of [].concat(keys)) delete data[key];
    },
  };
}

test('concurrent writes merge and stale writes cannot undo reset', async () => {
  const store = createStateStore(memoryStorage({
    tsState: { epoch: 1, values: {} }, hostname: 'golink-ext-abcdef',
  }));
  await store.initialize();
  await Promise.all([
    store.write({ epoch: 1, key: 'a', value: 'YQ==' }),
    store.write({ epoch: 1, key: 'b', value: 'Yg==' }),
  ]);
  assert.deepEqual((await store.snapshot()).values, { a: 'YQ==', b: 'Yg==' });
  assert.deepEqual(await store.advance({ clear: true }), { epoch: 2, values: {} });
  assert.deepEqual(await store.write({ epoch: 1, key: 'a', value: 'b2xk' }), { applied: false });
  assert.deepEqual((await store.snapshot()).values, {});
});

test('write acknowledges only after storage has persisted the value', async () => {
  const storage = memoryStorage(defaults);
  const store = createStateStore(storage);
  await store.initialize();
  const gate = deferred();
  const set = storage.set.bind(storage);
  storage.set = async values => { await gate.promise; await set(values); };
  let acknowledged = false;
  const write = store.write({ epoch: 1, key: 'node', value: 'eA==' })
    .then(result => { acknowledged = true; return result; });
  await nextTurn();
  assert.equal(acknowledged, false);
  assert.deepEqual((await storage.get(['tsState'])).tsState.values, {});
  gate.resolve();
  assert.deepEqual(await write, { applied: true });
  assert.deepEqual((await storage.get(['tsState'])).tsState.values, { node: 'eA==' });
});

test('snapshots, initialization, and idle wait for preceding writes in queue order', async () => {
  const storage = memoryStorage(defaults);
  const store = createStateStore(storage);
  await store.initialize();
  const gate = deferred();
  const set = storage.set.bind(storage);
  storage.set = async values => { await gate.promise; await set(values); };
  const first = store.write({ epoch: 1, key: 'a', value: 'YQ==' });
  let snapshotDone = false;
  const snapshot = store.snapshot().then(value => { snapshotDone = true; return value; });
  const second = store.write({ epoch: 1, key: 'b', value: 'Yg==' });
  let initialized = false;
  const initialization = store.initialize().then(value => { initialized = true; return value; });
  let idle = false;
  const drain = store.idle().then(() => { idle = true; });
  await nextTurn();
  assert.equal(snapshotDone, false);
  assert.equal(initialized, false);
  assert.equal(idle, false);
  gate.resolve();
  await Promise.all([first, second, drain]);
  assert.deepEqual(await snapshot, { epoch: 1, values: { a: 'YQ==' } });
  assert.deepEqual((await initialization).tsState.values, { a: 'YQ==', b: 'Yg==' });
});

test('a pending snapshot finishes before later mutations read or write state', async () => {
  const storage = memoryStorage(defaults);
  const store = createStateStore(storage);
  await store.initialize();
  const gate = deferred();
  const get = storage.get.bind(storage);
  storage.get = async keys => { await gate.promise; return get(keys); };
  const snapshot = store.snapshot();
  const write = store.write({ epoch: 1, key: 'node', value: 'eA==' });
  await nextTurn();
  assert.deepEqual((await get(['tsState'])).tsState.values, {});
  gate.resolve();
  assert.deepEqual(await snapshot, { epoch: 1, values: {} });
  await write;
  assert.deepEqual(await store.snapshot(), { epoch: 1, values: { node: 'eA==' } });
});

test('a rejected state write reaches its caller without poisoning queued writes', async () => {
  const storage = memoryStorage(defaults);
  const store = createStateStore(storage);
  await store.initialize();
  const failure = new Error('storage quota exceeded');
  const set = storage.set.bind(storage);
  let rejectNext = true;
  storage.set = async values => {
    if (rejectNext) { rejectNext = false; throw failure; }
    await set(values);
  };
  const failed = store.write({ epoch: 1, key: 'lost', value: 'YQ==' });
  const rejected = assert.rejects(failed, error => error === failure);
  const following = store.write({ epoch: 1, key: 'saved', value: 'Yg==' });
  await rejected;
  assert.deepEqual(await following, { applied: true });
  await store.idle();
  assert.deepEqual(await store.snapshot(), { epoch: 1, values: { saved: 'Yg==' } });
});

test('null deletes a key while empty base64 remains a stored zero-byte value', async () => {
  const storage = memoryStorage({ ...defaults, tsState: { epoch: 1, values: { node: 'eA==', keep: 'aw==' } } });
  const store = createStateStore(storage);
  await store.initialize();
  assert.deepEqual(await store.write({ epoch: 1, key: 'empty', value: '' }), { applied: true });
  assert.deepEqual(await store.write({ epoch: 1, key: 'node', value: null }), { applied: true });
  assert.deepEqual(await store.write({ epoch: 1, key: 'absent', value: null }), { applied: true });
  assert.deepEqual((await store.snapshot()).values, { keep: 'aw==', empty: '' });
});

test('writes require an exact current epoch and retain base64 strings verbatim', async () => {
  const storage = memoryStorage(defaults);
  const store = createStateStore(storage);
  await store.initialize();
  assert.deepEqual(await store.write({ epoch: 0, key: 'old', value: 'b2xk' }), { applied: false });
  assert.deepEqual(await store.write({ epoch: 2, key: 'future', value: 'bmV3' }), { applied: false });
  assert.deepEqual(await store.write({ epoch: '1', key: 'string', value: '' }), { applied: false });
  assert.deepEqual(await store.write({ epoch: 1, key: '__proto__', value: 'AP/+AA==' }), { applied: true });
  assert.deepEqual((await store.snapshot()).values, { ['__proto__']: 'AP/+AA==' });
});

test('clearing advances the epoch and removes only the link cache', async () => {
  const storage = memoryStorage({
    ...defaults,
    tsState: { epoch: 7, values: { node: 'eA==' } },
    linksCache: { fetchedAt: 123, links: [{ short: 'docs' }] },
    unrelated: 'keep',
  });
  const store = createStateStore(storage);
  await store.initialize();
  assert.deepEqual(await store.advance({ clear: true }), { epoch: 8, values: {} });
  assert.deepEqual(await storage.get(['tsState', 'linksCache', 'hostname', 'golinkHost', 'controlURL', 'unrelated']), {
    tsState: { epoch: 8, values: {} },
    linksCache: undefined,
    hostname: 'golink-ext-abcdef',
    golinkHost: 'go',
    controlURL: 'https://controlplane.tailscale.com',
    unrelated: 'keep',
  });
});

test('ordinary recovery advances the epoch while preserving identity and cache', async () => {
  const cache = { fetchedAt: 123, links: [{ short: 'docs' }] };
  const storage = memoryStorage({ ...defaults, tsState: { epoch: 3, values: { node: '', machine: 'eA==' } }, linksCache: cache });
  const store = createStateStore(storage);
  await store.initialize();
  assert.deepEqual(await store.advance({ clear: false }), { epoch: 4, values: { node: '', machine: 'eA==' } });
  assert.deepEqual((await storage.get(['linksCache'])).linksCache, cache);
  assert.deepEqual(await store.write({ epoch: 3, key: 'machine', value: 'b2xk' }), { applied: false });
  assert.deepEqual(await store.snapshot(), { epoch: 4, values: { node: '', machine: 'eA==' } });
});

test('writes on either side of a pending reset cannot restore the old identity', async () => {
  const storage = memoryStorage(defaults);
  const store = createStateStore(storage);
  await store.initialize();
  const gate = deferred();
  const set = storage.set.bind(storage);
  storage.set = async values => { await gate.promise; await set(values); };
  const before = store.write({ epoch: 1, key: 'old', value: 'b2xk' });
  const reset = store.advance({ clear: true });
  const after = store.write({ epoch: 1, key: 'late', value: 'b2xk' });
  const replacement = store.write({ epoch: 2, key: 'new', value: 'bmV3' });
  gate.resolve();
  assert.deepEqual(await before, { applied: true });
  assert.deepEqual(await reset, { epoch: 2, values: {} });
  assert.deepEqual(await after, { applied: false });
  assert.deepEqual(await replacement, { applied: true });
  assert.deepEqual(await store.snapshot(), { epoch: 2, values: { new: 'bmV3' } });
});

test('advance persists the new epoch and values together before acknowledging', async () => {
  const storage = memoryStorage({ ...defaults, tsState: { epoch: 5, values: { machine: 'eA==' } } });
  const store = createStateStore(storage);
  await store.initialize();
  const gate = deferred();
  const set = storage.set.bind(storage);
  const persisted = [];
  storage.set = async values => {
    await gate.promise;
    await set(values);
    persisted.push((await storage.get(['tsState'])).tsState);
  };
  let advanced = false;
  const advance = store.advance({ clear: true }).then(value => { advanced = true; return value; });
  await nextTurn();
  assert.equal(advanced, false);
  assert.deepEqual((await storage.get(['tsState'])).tsState, { epoch: 5, values: { machine: 'eA==' } });
  gate.resolve();
  assert.deepEqual(await advance, { epoch: 6, values: {} });
  assert.deepEqual(persisted, [{ epoch: 6, values: {} }]);
  assert.deepEqual((await storage.get(['tsState'])).tsState, { epoch: 6, values: {} });
});

test('clear waits for cache deletion before releasing the queue', async () => {
  const storage = memoryStorage({ ...defaults, linksCache: { fetchedAt: 123, links: [] } });
  const store = createStateStore(storage);
  await store.initialize();
  const gate = deferred();
  const remove = storage.remove.bind(storage);
  storage.remove = async keys => { await gate.promise; await remove(keys); };
  let advanced = false;
  const advance = store.advance({ clear: true }).then(value => { advanced = true; return value; });
  let snapped = false;
  const snapshot = store.snapshot().then(value => { snapped = true; return value; });
  await nextTurn();
  assert.equal(advanced, false);
  assert.equal(snapped, false);
  assert.deepEqual((await storage.get(['tsState'])).tsState, { epoch: 2, values: {} });
  gate.resolve();
  await advance;
  assert.deepEqual(await snapshot, { epoch: 2, values: {} });
  assert.equal((await storage.get(['linksCache'])).linksCache, undefined);
});

test('failed epoch persistence retains the old identity and cache', async () => {
  const cache = { fetchedAt: 123, links: [] };
  const storage = memoryStorage({ ...defaults, tsState: { epoch: 1, values: { machine: 'eA==' } }, linksCache: cache });
  const store = createStateStore(storage);
  await store.initialize();
  const failure = new Error('state unavailable');
  const set = storage.set.bind(storage);
  storage.set = async () => { throw failure; };
  await assert.rejects(store.advance({ clear: true }), error => error === failure);
  assert.deepEqual(await store.snapshot(), { epoch: 1, values: { machine: 'eA==' } });
  assert.deepEqual((await storage.get(['linksCache'])).linksCache, cache);
  storage.set = set;
  assert.deepEqual(await store.advance({ clear: false }), { epoch: 2, values: { machine: 'eA==' } });
});

test('cache removal failure rejects reset while retaining the persisted epoch fence', async () => {
  const storage = memoryStorage({ ...defaults, tsState: { epoch: 1, values: { machine: 'eA==' } }, linksCache: { fetchedAt: 123, links: [] } });
  const store = createStateStore(storage);
  await store.initialize();
  const failure = new Error('cannot remove cache');
  const remove = storage.remove.bind(storage);
  storage.remove = async () => { throw failure; };
  await assert.rejects(store.advance({ clear: true }), error => error === failure);
  assert.deepEqual(await store.write({ epoch: 1, key: 'machine', value: 'b2xk' }), { applied: false });
  assert.deepEqual(await store.snapshot(), { epoch: 2, values: {} });
  storage.remove = remove;
  assert.deepEqual(await store.advance({ clear: true }), { epoch: 3, values: {} });
  assert.equal((await storage.get(['linksCache'])).linksCache, undefined);
});

test('initialization creates defaults once and retains the hostname across store restarts', async () => {
  const storage = memoryStorage();
  const store = createStateStore(storage);
  const [first, second] = await Promise.all([store.initialize(), store.initialize()]);
  assert.match(first.hostname, /^golink-ext-[0-9a-f]{6}$/);
  assert.deepEqual(first, {
    tsState: { epoch: 1, values: {} },
    hostname: first.hostname,
    golinkHost: 'go',
    controlURL: 'https://controlplane.tailscale.com',
  });
  assert.deepEqual(second, first);
  assert.deepEqual(await storage.get(['tsState', 'hostname', 'golinkHost', 'controlURL']), first);
  storage.set = async () => { throw new Error('existing defaults must not be written again'); };
  assert.deepEqual(await createStateStore(storage).initialize(), first);
});

test('initialization preserves existing identity and configured endpoints while filling missing defaults', async () => {
  const storage = memoryStorage({
    tsState: { epoch: 9, values: { machine: 'eA==' } },
    hostname: 'golink-ext-123abc',
    golinkHost: 'go.example.ts.net',
    linksCache: { fetchedAt: 123, links: [] },
  });
  const store = createStateStore(storage);
  assert.deepEqual(await store.initialize(), {
    tsState: { epoch: 9, values: { machine: 'eA==' } },
    hostname: 'golink-ext-123abc',
    golinkHost: 'go.example.ts.net',
    controlURL: 'https://controlplane.tailscale.com',
  });
  await storage.set({ controlURL: 'https://control.example.test' });
  assert.equal((await store.initialize()).controlURL, 'https://control.example.test');
  assert.deepEqual((await storage.get(['linksCache'])).linksCache, { fetchedAt: 123, links: [] });
});

test('initialization acknowledges only after missing defaults are durable', async () => {
  const storage = memoryStorage();
  const store = createStateStore(storage);
  const gate = deferred();
  const set = storage.set.bind(storage);
  storage.set = async values => { await gate.promise; await set(values); };
  let initialized = false;
  const initialize = store.initialize().then(value => { initialized = true; return value; });
  await nextTurn();
  assert.equal(initialized, false);
  assert.equal((await storage.get(['tsState'])).tsState, undefined);
  gate.resolve();
  const value = await initialize;
  assert.deepEqual(await storage.get(['tsState', 'hostname', 'golinkHost', 'controlURL']), value);
});

test('initialization storage errors reject the caller and allow a later retry', async () => {
  const storage = memoryStorage();
  const store = createStateStore(storage);
  const failure = new Error('defaults unavailable');
  const set = storage.set.bind(storage);
  storage.set = async () => { throw failure; };
  await assert.rejects(store.initialize(), error => error === failure);
  storage.set = set;
  const initialized = await store.initialize();
  assert.match(initialized.hostname, /^golink-ext-[0-9a-f]{6}$/);
  assert.deepEqual(await store.snapshot(), { epoch: 1, values: {} });
});

test('failed storage reads reject without poisoning later queue operations', async () => {
  const storage = memoryStorage(defaults);
  const store = createStateStore(storage);
  await store.initialize();
  const failure = new Error('read unavailable');
  const get = storage.get.bind(storage);
  storage.get = async () => { throw failure; };
  await assert.rejects(store.snapshot(), error => error === failure);
  await assert.rejects(store.write({ epoch: 1, key: 'machine', value: '' }), error => error === failure);
  await assert.rejects(store.advance({ clear: true }), error => error === failure);
  await assert.rejects(store.initialize(), error => error === failure);
  storage.get = get;
  assert.deepEqual(await store.write({ epoch: 1, key: 'machine', value: '' }), { applied: true });
  await store.idle();
  assert.deepEqual(await store.snapshot(), { epoch: 1, values: { machine: '' } });
});


test('hostname renders three cryptographic random bytes with leading zeroes', async t => {
  t.mock.method(globalThis.crypto, 'getRandomValues', bytes => {
    assert.ok(bytes instanceof Uint8Array);
    assert.equal(bytes.length, 3);
    bytes.set([0, 15, 255]);
    return bytes;
  });
  const storage = memoryStorage();
  const store = createStateStore(storage);
  assert.equal((await store.initialize()).hostname, 'golink-ext-000fff');
  assert.equal((await createStateStore(storage).initialize()).hostname, 'golink-ext-000fff');
});
