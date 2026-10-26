import { inputPath, originalURLPath, suggestions } from './lib.js';
import { createStateStore } from './state.js';
import { createLifecycle } from './lifecycle.js';

const success = value => ({ ok: true, value });
const errorInfo = error => ({ kind: error.kind ?? 'worker', message: error.message ?? String(error) });
const failure = error => ({ ok: false, error: errorInfo(error) });
const fault = (message, kind = 'request') => Object.assign(new Error(message), { kind });
const eventTypes = new Set(['ready', 'stateWrite', 'state', 'browseToURL', 'fatal']);
const pageMethods = new Set(['status', 'login', 'authKey', 'logout', 'reset', 'resolve', 'save', 'cachedLinks', 'configure']);
const cacheMaxAge = 5 * 60_000;
const refreshRetryDelay = 60_000;
const maxGoLinkHops = 10;
const canonicalJSON = value => JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);

function supportedURL(value) {
  let url;
  try { url = new URL(value); } catch { throw fault('Expected an absolute http or https URL', 'url'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw fault('Only http and https URLs are supported', 'url');
  return value;
}

// Store settings in the normalized form that Go's net/url also accepts. The
// browser parser lowercases host names, drops port 80, and repairs forms such
// as http:host or backslashes that Go rejects.
function golinkHostSetting(host) {
  if (typeof host !== 'string' || !host || /[\s/?#@\\%]/.test(host)) throw fault('golinkHost must be a host name or host:port');
  let parsed;
  try { parsed = new URL('http://' + host); } catch { throw fault('Invalid golinkHost'); }
  if (!/^(?:[a-z0-9_-]+(?:\.[a-z0-9_-]+)*\.?|\[[0-9a-f:.]+\])(?::\d{1,5})?$/.test(parsed.host)) throw fault('Invalid golinkHost');
  return parsed.host;
}

function controlURLSetting(value) {
  supportedURL(value);
  const url = new URL(value);
  if (url.username || url.password) throw fault('The control URL must not contain credentials', 'url');
  return url.pathname === '/' && !url.search && !url.hash ? url.origin : url.href;
}

// The redirect rule captures http://go/ navigations, so a link target there
// must be resolved here rather than navigated to.
function goLinkPath(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.host !== 'go') return undefined;
  url.hash = '';
  return originalURLPath(url.href);
}

// The login tab may be reused by the user. Only treat it as ours while it
// still shows the control server's login pages, not its admin console.
function showsLogin(tab, loginURL) {
  try {
    const current = new URL(tab.pendingUrl || tab.url);
    return current.origin === new URL(loginURL).origin && !/^\/admin(?:\/|$)/.test(current.pathname);
  } catch { return false; }
}

export function createBackground({ chrome, lifecycle, store, now = Date.now }) {
  let registered = false, repairRequest, refreshRequest, lastState, refreshFailedAt = -Infinity;
  let generation = 0, replacing = 0;
  let cacheWrites = Promise.resolve(), tabOperations = Promise.resolve(), replacements = Promise.resolve();
  const local = chrome.storage.local, session = chrome.storage.session;
  const statusURL = chrome.runtime.getURL('status.html');
  const offscreenURL = chrome.runtime.getURL('offscreen.html');
  const pageURL = (key, value) => {
    const url = new URL(statusURL);
    url.searchParams.set(key, value);
    return url.href;
  };
  async function cachedLinks() {
    return (await local.get(['linksCache'])).linksCache ?? { fetchedAt: 0, links: [] };
  }
  function repairRule() {
    if (!repairRequest) {
      const rule = {
        id: 1, priority: 1,
        action: { type: 'redirect', redirect: { regexSubstitution: statusURL + '#\\1' } },
        condition: { regexFilter: '^(http://go/.*)$', resourceTypes: ['main_frame'] },
      };
      repairRequest = (async () => {
        const rules = await chrome.declarativeNetRequest.getDynamicRules();
        if (canonicalJSON(rules.find(existing => existing.id === 1)) !== canonicalJSON(rule)) {
          await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [1], addRules: [rule] });
        }
      })().finally(() => { repairRequest = undefined; });
    }
    return repairRequest;
  }
  function queueTab(operation) {
    const result = tabOperations.then(operation);
    tabOperations = result.catch(() => {});
    return result;
  }
  // Returns the recorded login tab ID if that tab still shows the login flow.
  async function ownedLoginTab() {
    const { golinkLoginTab } = await session.get(['golinkLoginTab']);
    if (!Number.isInteger(golinkLoginTab?.id)) return undefined;
    try { if (showsLogin(await chrome.tabs.get(golinkLoginTab.id), golinkLoginTab.url)) return golinkLoginTab.id; }
    catch { /* The user may have already closed the login tab. */ }
    await session.remove(['golinkLoginTab']);
    return undefined;
  }
  function openLoginTab(url) {
    supportedURL(url);
    return queueTab(async () => {
      const id = await ownedLoginTab();
      if (id !== undefined) {
        try { await chrome.tabs.update(id, { url, active: true }); await session.set({ golinkLoginTab: { id, url } }); return; }
        catch { /* The tab closed after the check. */ }
      }
      const tab = await chrome.tabs.create({ url, active: true });
      await session.set({ golinkLoginTab: { id: tab.id, url } });
    });
  }
  function closeLoginTab() {
    return queueTab(async () => {
      const id = await ownedLoginTab();
      if (id === undefined) return;
      try { await chrome.tabs.remove(id); }
      catch { /* Closing an already closed login tab is harmless. */ }
      await session.remove(['golinkLoginTab']);
    });
  }
  function refreshCache({ force = false } = {}) {
    if (replacing) return Promise.resolve();
    if (refreshRequest) return refreshRequest;
    const startedGeneration = generation;
    const request = (async () => {
      const cache = await cachedLinks();
      if (!force && (now() - cache.fetchedAt < cacheMaxAge || now() - refreshFailedAt < refreshRetryDelay)) return;
      const { epoch } = await store.snapshot();
      if (generation !== startedGeneration || replacing) return;
      let links;
      try { links = await lifecycle.call('links'); }
      catch (error) { refreshFailedAt = now(); throw error; }
      const commit = cacheWrites.then(async () => {
        if (generation !== startedGeneration || replacing) return;
        if ((await store.snapshot()).epoch !== epoch || generation !== startedGeneration) return;
        await local.set({ linksCache: { fetchedAt: now(), links } });
      });
      cacheWrites = commit.catch(() => {});
      await commit;
    })();
    refreshRequest = request;
    request.finally(() => { if (refreshRequest === request) refreshRequest = undefined; }).catch(() => {});
    return request;
  }
  // Returns a deferred cache refresh when refresh is false.
  function observeState(state, { refresh = true } = {}) {
    // An unknown previous state, as after a worker restart, is not a login.
    const beganRunning = state === 'Running' && lastState !== undefined && lastState !== 'Running';
    lastState = state;
    if (state !== 'Running') return () => {};
    closeLoginTab().catch(() => {});
    // State callbacks must acknowledge without waiting for a queued node call.
    const run = () => { refreshCache({ force: beganRunning }).catch(() => {}); };
    if (!refresh) return run;
    run();
    return () => {};
  }
  function replace(options, config) {
    // Invalidate refreshes immediately, before any asynchronous replacement work.
    generation++;
    replacing++;
    lastState = undefined;
    refreshRequest = undefined;
    const request = replacements.then(async () => {
      // A pending login URL belongs to the node being replaced.
      await closeLoginTab().catch(() => {});
      // A cache set already in storage must finish before lifecycle clears it.
      await cacheWrites;
      if (config) { await local.set(config); await local.remove(['linksCache']); }
      return lifecycle.restart(options);
    });
    replacements = request.catch(() => {});
    return request.finally(() => {
      replacing--;
      // A Running callback can acknowledge before restart releases its gate.
      if (!replacing && lastState === 'Running') refreshCache({ force: true }).catch(() => {});
    });
  }
  function validatePage(sender) {
    let url;
    try { url = new URL(sender?.url); } catch { throw fault('Invalid extension page sender', 'unauthorized'); }
    url.search = '';
    url.hash = '';
    if (sender?.id !== chrome.runtime.id || url.href !== statusURL) throw fault('Invalid extension page sender', 'unauthorized');
    // status.html is web accessible for the redirect rule, so any site can
    // frame it. Only the popup (no tab) and top-level tabs may issue commands.
    if (sender.tab && sender.frameId !== 0) throw fault('Extension page must not be framed', 'unauthorized');
  }
  function validateArgs(method, args) {
    if (!Array.isArray(args)) throw fault('Arguments must be an array');
    const count = { authKey: 1, resolve: 1, save: 3, configure: 1 }[method] ?? 0;
    if (args.length !== count) throw fault('Invalid arguments');
    const text = method === 'save' ? args.slice(0, 2) : args;
    if (['authKey', 'resolve', 'save'].includes(method) && text.some(value => typeof value !== 'string')) throw fault('Text arguments are required');
    if (['authKey', 'save'].includes(method) && text.some(value => !value)) throw fault('Nonempty text arguments are required');
    if (method === 'save' && typeof args[2] !== 'boolean') throw fault('The overwrite argument must be a boolean');
  }
  function configuration(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw fault('Invalid configuration');
    if (Object.keys(value).some(key => !['golinkHost', 'controlURL'].includes(key))) throw fault('Unknown configuration field');
    const config = {};
    if (value.golinkHost !== undefined) config.golinkHost = golinkHostSetting(value.golinkHost);
    if (value.controlURL !== undefined) config.controlURL = controlURLSetting(value.controlURL);
    return config;
  }
  async function handleMessage(message, sender) {
    try {
      if (message?.channel !== 'golink' || message.target !== 'worker') throw fault('Invalid worker request');
      if (eventTypes.has(message.type)) {
        if (sender?.id !== chrome.runtime.id || sender.url !== offscreenURL) throw fault('Invalid offscreen sender', 'unauthorized');
        const reply = await lifecycle.handleEvent(message, sender);
        if (reply?.ok && reply.value?.accepted === true) {
          if (message.type === 'state') observeState(message.state);
          else if (message.type === 'browseToURL') await openLoginTab(message.url);
          else if (message.type === 'fatal') lastState = undefined;
        }
        return reply;
      }
      validatePage(sender);
      const { method, args = [] } = message;
      if (!pageMethods.has(method)) throw fault('Unknown page method');
      validateArgs(method, args);
      switch (method) {
        case 'cachedLinks': return success(await cachedLinks());
        case 'status': {
          const status = await lifecycle.call('status');
          observeState(status.state);
          return success(status);
        }
        case 'login': return success(await lifecycle.call('login'));
        case 'logout': return success(await replace({ clear: true }));
        case 'reset': return success(await replace({ clear: true, reset: true }));
        case 'authKey': return success(await replace({ clear: true, authKey: args[0] }));
        case 'configure': return success(await replace({ clear: false }, configuration(args[0])));
        case 'save': {
          const result = await lifecycle.call('save', args);
          try {
            // A request begun before save may hold the old export snapshot.
            if (refreshRequest) await refreshRequest.catch(() => {});
            await refreshCache({ force: true });
            return success(result);
          } catch (error) { return success({ ...result, cacheRefreshError: errorInfo(error) }); }
        }
        case 'resolve': {
          const status = await lifecycle.call('status');
          // Let the user's resolve run before a background export in the node queue.
          const refresh = observeState(status.state, { refresh: false });
          if (status.state !== 'Running') return success({ pending: true });
          try {
            // The status page navigates itself with location.replace, so the
            // pending page does not remain in session history.
            let path = args[0];
            for (let hop = 0; ; hop++) {
              const result = await lifecycle.call('resolve', [path]);
              if (result.redirect) {
                const next = goLinkPath(supportedURL(result.redirect));
                if (next === undefined) return success({ ...result, navigate: result.redirect });
                if (hop === maxGoLinkHops) throw fault('This go link redirects to go links too many times.', 'loop');
                path = next;
              } else if (result.notFound) return success({ ...result, navigate: pageURL('create', path.split(/[/?]/, 1)[0]) });
              else if (result.golinkUI) return success({ ...result, navigate: pageURL('golinkUI', result.golinkUI) });
              else return success(result);
            }
          } finally { refresh(); }
        }
      }
    } catch (error) { return failure(error); }
  }
  return {
    handleMessage,
    register() {
      if (registered) return;
      registered = true;
      chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message?.channel !== 'golink' || message.target !== 'worker') return false;
        handleMessage(message, sender).then(sendResponse);
        return true;
      });
      chrome.runtime.onInstalled.addListener(repairRule);
      chrome.runtime.onStartup.addListener(repairRule);
      chrome.omnibox.onInputChanged.addListener(async (text, suggest) => {
        try { suggest(suggestions((await cachedLinks()).links, text)); }
        catch { suggest([]); }
      });
      chrome.omnibox.onInputEntered.addListener(async (text, disposition) => {
        const url = pageURL('resolve', inputPath(text));
        if (disposition === 'currentTab') {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          await chrome.tabs.update(tab.id, { url });
        } else await chrome.tabs.create({ url, active: disposition !== 'newBackgroundTab' });
      });
      repairRule().catch(() => {});
    },
  };
}

if (globalThis.chrome?.runtime?.onMessage) {
  const chrome = globalThis.chrome;
  const store = createStateStore(chrome.storage.local);
  const lifecycle = createLifecycle({ runtime: chrome.runtime, offscreen: chrome.offscreen, store, session: chrome.storage.session });
  createBackground({ chrome, lifecycle, store }).register();
}
