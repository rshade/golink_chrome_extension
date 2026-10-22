const methods = new Set(['start', 'login', 'logout', 'status', 'resolve', 'save', 'links']);
const failure = error => ({ ok: false, error: { kind: error.kind ?? 'node', message: error.message ?? String(error) } });

function bounded(promise, timeoutMs) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Go API startup timed out')), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

function goResult(value) {
  if (value?.error) throw Object.assign(new Error(value.error), { kind: value.kind ?? 'node' });
  return value;
}

export function createOffscreenBridge({ runtime, loadGo, docId, timeoutMs = 30_000 }) {
  let api, started = false, epoch = null, startPromise, disposed = false;
  let persistenceFailure, fatalError, haltError, publication = Promise.resolve();
  const pendingWrites = new Set();
  // Racing each request against one long-lived fatal promise would keep every
  // settled result reachable from it. Waiters remove themselves instead.
  const fatalWaiters = new Set();
  function halt(error) {
    if (haltError) return;
    haltError = error;
    for (const reject of fatalWaiters) reject(error);
    fatalWaiters.clear();
  }
  function untilFatal(promise) {
    if (haltError) return Promise.reject(haltError);
    return new Promise((resolve, reject) => {
      fatalWaiters.add(reject);
      promise.then(resolve, reject).finally(() => fatalWaiters.delete(reject));
    });
  }
  const send = (type, fields = {}) => runtime.sendMessage({ channel: 'golink', target: 'worker', type, docId, epoch, ...fields });

  function reportFatal(error) {
    if (fatalError || disposed) return;
    fatalError = error instanceof Error ? error : new Error(String(error));
    halt(fatalError);
    Promise.resolve().then(() => send('fatal', { message: fatalError.message })).catch(() => {});
  }
  async function flushWrites() {
    while (pendingWrites.size) await Promise.all([...pendingWrites]);
    if (persistenceFailure) throw persistenceFailure;
  }
  function onStateWrite(key, value) {
    const pending = Promise.resolve().then(() => send('stateWrite', { key, value })).then(reply => {
      if (!reply?.ok) throw new Error(reply?.error?.message ?? 'State write failed');
    });
    pendingWrites.add(pending);
    pending.catch(error => { persistenceFailure = error; reportFatal(error); })
      .finally(() => pendingWrites.delete(pending));
  }
  function onState(state) {
    // Chain every publication so a delayed Running cannot follow NeedsLogin.
    publication = publication.then(async () => {
      if (state === 'Running') await flushWrites();
      if (!fatalError && !disposed) await send('state', { state });
    });
    publication.catch(reportFatal);
  }
  const callbacks = {
    onState, onStateWrite, onFatal: reportFatal,
    onBrowseToURL: url => { Promise.resolve().then(() => send('browseToURL', { url })).catch(reportFatal); },
  };
  const listener = (message, sender, sendResponse) => {
    if (message?.channel !== 'golink' || message.target !== 'offscreen') return false;
    handleMessage(message, sender).then(sendResponse);
    return true;
  };
  // hello must already be available while fetch and WebAssembly compilation run.
  runtime.onMessage?.addListener(listener);
  const loading = Promise.resolve().then(loadGo).then(loaded => {
    if (loaded.exited) Promise.resolve(loaded.exited).then(
      () => reportFatal(new Error('Go runtime exited unexpectedly')),
      reportFatal,
    );
    return loaded.apiReady;
  });
  const ready = bounded(untilFatal(loading), timeoutMs).then(value => {
    if (disposed) throw new Error('Offscreen document closed');
    api = value;
    // A worker may have restarted while compiling. hello recovers a missed ready.
    Promise.resolve().then(() => send('ready')).catch(() => {});
  });
  ready.catch(reportFatal);

  async function handleMessage(message, sender) {
    try {
      if (sender?.id !== runtime.id || sender.url !== runtime.getURL('background.js')) throw new Error('Invalid worker sender');
      if (message?.channel !== 'golink' || message.target !== 'offscreen' || typeof message.requestId !== 'string' || !Array.isArray(message.args)) throw new Error('Invalid RPC request');
      if (message.method === 'hello') {
        if ((message.docId !== undefined && message.docId !== docId) || (message.epoch !== undefined && message.epoch !== epoch)) throw new Error('Stale document or epoch');
        return { ok: true, value: { docId, ready: !!api && !fatalError, started, epoch, ...(fatalError ? { fatal: fatalError.message } : {}) } };
      }
      if (!methods.has(message.method)) throw new Error('Unknown node method');
      if (message.docId !== docId || !Number.isSafeInteger(message.epoch) || message.epoch < 1 || (epoch !== null && message.epoch !== epoch)) throw new Error('Stale document or epoch');
      await untilFatal(ready);
      let operation;
      if (message.method === 'start') {
        if (!startPromise) {
          epoch = message.epoch;
          const config = { ...message.args[0] };
          startPromise = Promise.resolve().then(() => api.start(config, callbacks)).then(goResult)
            .then(async result => { await flushWrites(); started = true; return result; })
            .finally(() => { delete config.authKey; });
        }
        operation = startPromise;
      } else {
        if (!started) throw new Error('Node is not started');
        operation = Promise.resolve().then(() => api[message.method](...message.args)).then(goResult)
          .then(async result => { await flushWrites(); return result; });
      }
      return { ok: true, value: await untilFatal(operation) };
    } catch (error) { return failure(error); }
  }
  return {
    handleMessage,
    dispose() {
      disposed = true;
      halt(new Error('Offscreen document closed'));
      runtime.onMessage?.removeListener(listener);
    },
  };
}

// Only runtime is used here. The worker owns all Chrome storage access.
export async function loadGo() {
  const go = new globalThis.Go();
  const response = await fetch(chrome.runtime.getURL('main.wasm'));
  if (!response.ok) throw new Error(`WASM fetch failed (${response.status})`);
  const { instance } = await WebAssembly.instantiate(await response.arrayBuffer(), go.importObject);
  const exited = go.run(instance);
  const apiReady = (async () => {
    const deadline = Date.now() + 30_000;
    while (!globalThis.golinkExt) {
      if (Date.now() >= deadline) throw new Error('Go API startup timed out');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    return globalThis.golinkExt;
  })();
  return { apiReady, exited };
}

if (globalThis.chrome?.runtime && globalThis.document) {
  createOffscreenBridge({ runtime: chrome.runtime, loadGo, docId: crypto.randomUUID() });
}
