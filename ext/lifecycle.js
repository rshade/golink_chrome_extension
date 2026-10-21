import { recordFatal } from './lib.js';

const methods = new Set(['login', 'logout', 'status', 'resolve', 'save', 'links']);
const eventTypes = new Set(['ready', 'stateWrite', 'state', 'browseToURL', 'fatal']);
const success = value => ({ ok: true, value });
const failure = error => ({ ok: false, error: { kind: error.kind ?? 'lifecycle', message: error.message ?? String(error) } });
const fault = (message, kind = 'lifecycle') => Object.assign(new Error(message), { kind });

function bounded(promise, timeoutMs) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(fault('Offscreen request timed out', 'timeout')), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

// The real worker passes chrome.storage.session. The memory fallback is for
// isolated consumers that do not need recovery across worker reconstruction.
export function createLifecycle({ runtime, offscreen, store, now = Date.now, session, timeoutMs = 30_000 }) {
  if (!session) {
    const values = {};
    session = { async get() { return { ...values }; }, async set(update) { Object.assign(values, update); } };
  }
  let current, tail = Promise.resolve(), fatalTail = Promise.resolve(), ensureRequest;
  let disposed = false, requestId = 0;
  const fatalDocuments = new Set();
  const url = runtime.getURL('offscreen.html');
  const identity = () => ({ docId: current.docId, epoch: current.epoch });

  function schedule(work) {
    const result = tail.then(() => {
      if (disposed) throw fault('Lifecycle is disposed');
      return work();
    });
    tail = result.catch(() => {});
    return result;
  }
  function invalidate(error = fault('Offscreen document replaced')) {
    current?.reject(error);
    current = undefined;
  }
  function adopt(docId, epoch) {
    if (current?.docId === docId && current.epoch === epoch) return;
    invalidate();
    let reject;
    const exited = new Promise((_, fail) => { reject = fail; });
    exited.catch(() => {});
    current = { docId, epoch, exited, reject };
  }
  async function rpc(method, args = [], document = current, budgetMs = timeoutMs) {
    const message = { channel: 'golink', target: 'offscreen', method, args, requestId: String(++requestId) };
    if (document) Object.assign(message, { docId: document.docId, epoch: document.epoch });
    const reply = await bounded(Promise.race([
      Promise.resolve().then(() => runtime.sendMessage(message)),
      ...(document?.exited ? [document.exited] : []),
    ]), budgetMs);
    if (!reply?.ok) throw fault(reply?.error?.message ?? 'Offscreen request failed', reply?.error?.kind ?? 'lifecycle');
    return reply.value;
  }
  async function exists() {
    const contexts = await runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] });
    return contexts.some(context => context.documentUrl === url);
  }
  async function close(error) {
    if (await exists()) await offscreen.closeDocument();
    invalidate(error);
  }
  async function checkCrashWindow() {
    const { golinkFatalTimestamps = [] } = await session.get(['golinkFatalTimestamps']);
    if (golinkFatalTimestamps.filter(timestamp => now() - timestamp < 60_000).length >= 2) {
      throw fault('Node crashed twice within 60 seconds. Reset the device or retry later.', 'fatal');
    }
  }
  async function waitHello(deadline = Date.now() + timeoutMs) {
    while (true) {
      if (disposed) throw fault('Lifecycle is disposed');
      let hello;
      try { hello = await rpc('hello', [], null, Math.max(1, deadline - Date.now())); } catch (error) {
        if (Date.now() >= deadline) throw error;
      }
      if (hello) return hello;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }
  async function ensure({ preparedEpoch, authKey } = {}) {
    let attemptedDocument, created = false;
    try {
      await fatalTail;
      await checkCrashWindow();
      const config = await store.initialize();
      if (!await exists()) {
        invalidate(fault('Offscreen document disappeared'));
        if (preparedEpoch === undefined) {
          const { golinkOffscreenUsed } = await session.get(['golinkOffscreenUsed']);
          const initial = !golinkOffscreenUsed && config.tsState.epoch === 1 && Object.keys(config.tsState.values).length === 0;
          if (!initial) config.tsState = await store.advance({ clear: false });
        }
        await session.set({ golinkOffscreenUsed: true });
        await offscreen.createDocument({ url: 'offscreen.html', reasons: ['WORKERS'], justification: 'Hosts the long-running WebAssembly Tailscale network node.' });
        created = true;
      }
      const deadline = Date.now() + timeoutMs;
      let hello = await waitHello(deadline);
      attemptedDocument = hello.docId;
      if (hello.epoch !== null && hello.epoch !== config.tsState.epoch) {
        await close(fault('Stale offscreen epoch'));
        return ensure();
      }
      adopt(hello.docId, config.tsState.epoch);
      const document = current;
      while (!hello.ready) {
        if (hello.fatal) throw fault(hello.fatal, 'fatal');
        if (Date.now() >= deadline) throw fault('Offscreen startup timed out', 'timeout');
        await bounded(Promise.race([new Promise(resolve => setTimeout(resolve, 5)), document.exited]), timeoutMs);
        hello = await waitHello(deadline);
        if (hello.docId !== document.docId) throw fault('Offscreen document changed during startup');
      }
      await session.set({ golinkOffscreenUsed: true });
      if (!hello.started) {
        const startConfig = { hostname: config.hostname, golinkHost: config.golinkHost, controlURL: config.controlURL, state: config.tsState.values };
        if (authKey !== undefined) startConfig.authKey = authKey;
        try { await rpc('start', [startConfig], document); }
        finally { delete startConfig.authKey; authKey = undefined; }
      }
      if (disposed || current !== document) throw fault('Offscreen document closed during startup');
      return identity();
    } catch (error) {
      // Fatal processing owns its close. Disposal represents a worker restart
      // and must leave the live offscreen document available to the next worker.
      await fatalTail;
      if (!disposed && (current?.docId === attemptedDocument || (created && !current))) await close(error);
      throw error;
    } finally { authKey = undefined; }
  }

  async function validateEvent(message) {
    if (!await exists()) throw fault('Offscreen document is gone', 'stale');
    const hello = await rpc('hello', [], null);
    if (hello.docId !== message.docId) throw fault('Stale offscreen document', 'stale');
    const epoch = current?.docId === hello.docId ? current.epoch : (await store.snapshot()).epoch;
    const bootstrap = (message.type === 'ready' || message.type === 'fatal') && hello.epoch === null && message.epoch === null;
    if (!bootstrap && (message.epoch !== epoch || hello.epoch !== epoch)) throw fault('Stale offscreen epoch', 'stale');
    adopt(hello.docId, epoch);
    return hello;
  }
  async function handleEvent(message, sender) {
    try {
      if (disposed) throw fault('Lifecycle is disposed');
      if (sender?.id !== runtime.id || sender.url !== url) throw fault('Invalid offscreen sender', 'unauthorized');
      if (message?.channel !== 'golink' || message.target !== 'worker' || !eventTypes.has(message.type)) throw fault('Invalid offscreen event');
      if (message.type === 'fatal') {
        const processing = fatalTail.then(async () => {
          if (fatalDocuments.has(message.docId)) return { accepted: false };
          await validateEvent(message);
          fatalDocuments.add(message.docId);
          const error = fault(message.message ?? 'Node crashed', 'fatal');
          current.reject(error);
          try {
            const { golinkFatalTimestamps = [] } = await session.get(['golinkFatalTimestamps']);
            const result = recordFatal(golinkFatalTimestamps, now());
            await session.set({ golinkFatalTimestamps: result.timestamps });
            return { accepted: true, blocked: result.blocked };
          } finally { await close(error); }
        });
        fatalTail = processing.catch(() => {});
        return success(await processing);
      }
      try { await validateEvent(message); } catch (error) {
        if (message.type === 'stateWrite' && error.kind === 'stale') return success({ applied: false });
        throw error;
      }
      if (message.type === 'stateWrite') {
        if (typeof message.key !== 'string' || (typeof message.value !== 'string' && message.value !== null)) throw fault('Invalid identity state write');
        // This path deliberately bypasses schedule. Go operations wait for it.
        return success(await store.write(message));
      }
      return success({ accepted: true });
    } catch (error) { return failure(error); }
  }
  return {
    ensureOffscreen() {
      if (!ensureRequest) {
        const request = schedule(() => ensure());
        ensureRequest = request;
        request.finally(() => { if (ensureRequest === request) ensureRequest = undefined; }).catch(() => {});
      }
      return ensureRequest;
    },
    call(method, args = []) {
      return schedule(async () => {
        if (!methods.has(method) || !Array.isArray(args)) throw fault('Unknown node method');
        await ensure();
        return rpc(method, args);
      });
    },
    restart({ clear = false, reset = false, authKey } = {}) {
      // Requests arriving after this point must wait for the replacement.
      ensureRequest = undefined;
      return schedule(async () => {
        try {
          await fatalTail;
          if (authKey !== undefined) {
            if (typeof authKey !== 'string' || !authKey) throw fault('An auth key is required');
            await ensure();
            if ((await rpc('status')).state !== 'NeedsLogin') throw fault('Auth keys are allowed only in NeedsLogin');
            clear = true;
          } else if (clear && !reset) {
            await ensure();
            await rpc('logout');
          } else if (reset && await exists()) {
            // Reset can recover a document that cannot start or log out.
            try {
              const hello = await rpc('hello', [], null);
              if (hello.started) { adopt(hello.docId, (await store.snapshot()).epoch); await rpc('logout'); }
            } catch { /* Backend logout is best effort for explicit reset. */ }
          }
          await close();
          if (reset) await session.set({ golinkFatalTimestamps: [] });
          const state = await store.advance({ clear: clear || reset });
          await ensure({ preparedEpoch: state.epoch, authKey });
          return { ok: true };
        } finally { authKey = undefined; }
      });
    },
    handleEvent,
    dispose() { disposed = true; invalidate(fault('Lifecycle is disposed')); },
  };
}
