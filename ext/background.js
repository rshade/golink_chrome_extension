import { inputPath, suggestions } from './lib.js';
import { createStateStore } from './state.js';
import { createLifecycle } from './lifecycle.js';

const success = value => ({ ok: true, value });
const errorInfo = error => ({ kind: error.kind ?? 'worker', message: error.message ?? String(error) });
const failure = error => ({ ok: false, error: errorInfo(error) });
const fault = (message, kind = 'request') => Object.assign(new Error(message), { kind });
const eventTypes = new Set(['ready', 'stateWrite', 'state', 'browseToURL', 'fatal']);
const pageMethods = new Set(['status', 'login', 'authKey', 'logout', 'reset', 'resolve', 'save', 'cachedLinks', 'configure']);
const cacheMaxAge = 5 * 60_000;
const canonicalJSON = value => JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);

function supportedURL(value) {
  let url;
  try { url = new URL(value); } catch { throw fault('Expected an absolute http or https URL', 'url'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw fault('Only http and https URLs are supported', 'url');
  return value;
}

export function createBackground({ chrome, lifecycle, store, now = Date.now }) {
  let registered = false, repairRequest, refreshRequest, lastState;
  let generation = 0, replacing = 0;
  let cacheWrites = Promise.resolve(), tabOperations = Promise.resolve(), replacements = Promise.resolve();
  const pendingNavigations = new Map();
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
  function openLoginTab(url) {
    supportedURL(url);
    return queueTab(async () => {
      const { golinkLoginTabId } = await session.get(['golinkLoginTabId']);
      if (Number.isInteger(golinkLoginTabId)) {
        try { await chrome.tabs.update(golinkLoginTabId, { url, active: true }); return; }
        catch { /* The user may have already closed the login tab. */ }
      }
      const tab = await chrome.tabs.create({ url, active: true });
      await session.set({ golinkLoginTabId: tab.id });
    });
  }
  function closeLoginTab() {
    return queueTab(async () => {
      const { golinkLoginTabId } = await session.get(['golinkLoginTabId']);
      if (!Number.isInteger(golinkLoginTabId)) return;
      try { await chrome.tabs.remove(golinkLoginTabId); }
      catch { /* Closing an already closed login tab is harmless. */ }
      await session.remove(['golinkLoginTabId']);
    });
  }
  function refreshCache({ force = false } = {}) {
    if (replacing) return Promise.resolve();
    if (refreshRequest) return refreshRequest;
    const startedGeneration = generation;
    const request = (async () => {
      const cache = await cachedLinks();
      if (!force && now() - cache.fetchedAt < cacheMaxAge) return;
      const { epoch } = await store.snapshot();
      if (generation !== startedGeneration || replacing) return;
      const links = await lifecycle.call('links');
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
  function observeState(state) {
    const beganRunning = state === 'Running' && lastState !== 'Running';
    lastState = state;
    if (state === 'Running') {
      closeLoginTab().catch(() => {});
      // State callbacks must acknowledge without waiting for a queued node call.
      refreshCache({ force: beganRunning }).catch(() => {});
    }
  }
  function replace(options, config) {
    // Invalidate refreshes immediately, before any asynchronous replacement work.
    generation++;
    replacing++;
    lastState = undefined;
    refreshRequest = undefined;
    const request = replacements.then(async () => {
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
  }
  function validateArgs(method, args) {
    if (!Array.isArray(args)) throw fault('Arguments must be an array');
    const count = { authKey: 1, resolve: 1, save: 2, configure: 1 }[method] ?? 0;
    if (args.length !== count) throw fault('Invalid arguments');
    if (['authKey', 'resolve', 'save'].includes(method) && args.some(value => typeof value !== 'string')) throw fault('Text arguments are required');
    if (['authKey', 'save'].includes(method) && args.some(value => !value)) throw fault('Nonempty text arguments are required');
  }
  function configuration(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw fault('Invalid configuration');
    if (Object.keys(value).some(key => !['golinkHost', 'controlURL'].includes(key))) throw fault('Unknown configuration field');
    const config = {};
    if (value.golinkHost !== undefined) {
      const host = value.golinkHost;
      if (typeof host !== 'string' || !host || /[\s/?#@\\]/.test(host)) throw fault('golinkHost must be a host name or host:port');
      const parsed = new URL('http://' + host);
      if (!parsed.hostname || parsed.host !== host) throw fault('Invalid golinkHost');
      config.golinkHost = host;
    }
    if (value.controlURL !== undefined) config.controlURL = supportedURL(value.controlURL);
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
          if (!Number.isInteger(sender.tab?.id) || sender.frameId !== 0 || typeof sender.documentId !== 'string' || !sender.documentId) {
            throw fault('A status tab document is required to resolve a link');
          }
          const tabId = sender.tab.id, documentId = sender.documentId, request = Symbol();
          // Claim the tab before any await so a newer request supersedes this one.
          pendingNavigations.set(tabId, request);
          try {
            const status = await lifecycle.call('status');
            observeState(status.state);
            if (status.state !== 'Running') return success({ pending: true });
            const result = await lifecycle.call('resolve', args);
            let url;
            if (result.redirect) url = supportedURL(result.redirect);
            else if (result.notFound) url = pageURL('create', args[0].split(/[/?]/, 1)[0]);
            else if (result.golinkUI) url = pageURL('golinkUI', result.golinkUI);
            if (url && pendingNavigations.get(tabId) === request) {
              const contexts = await chrome.runtime.getContexts({ contextTypes: ['TAB'], tabIds: [tabId], documentIds: [documentId] });
              // Recheck ownership after Chrome replies; never navigate a replacement document.
              if (pendingNavigations.get(tabId) === request && contexts.some(context =>
                context.contextType === 'TAB' && context.tabId === tabId && context.documentId === documentId && context.frameId === 0)) {
                await chrome.tabs.update(tabId, { url });
              }
            }
            return success(result);
          } finally {
            if (pendingNavigations.get(tabId) === request) pendingNavigations.delete(tabId);
          }
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
