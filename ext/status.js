import { capturedFragment, originalURLPath, withFragment } from './lib.js';

const DEFAULT_CONTROL_URL = 'https://controlplane.tailscale.com';
const stateLabels = {
  NoState: 'Connecting…', Starting: 'Connecting…', NeedsLogin: 'Log in to Tailscale',
  NeedsMachineAuth: 'Waiting for an admin to approve this device', Running: 'Connected', Stopped: 'Stopped',
};

function errorText(error) {
  switch (error?.kind) {
    case 'unreachable': return 'Golink is unreachable. Check that ACLs allow this device to reach the golink server on port 80, and on 443 if it serves HTTPS.';
    case 'timeout': return 'The request to golink timed out. Try again.';
    case 'http': return `Golink HTTP error: ${error.message || 'Unexpected server response.'}`;
    default: return error?.message || 'Could not contact the extension. Try again or reset the device.';
  }
}

// golink matches short names without case or dashes.
const linkID = short => short.toLowerCase().replaceAll('-', '');

const maxLinkRows = 200;

export function createStatusController({ rpc, view, location, activeTab, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let disposed = false, started = false, timer, refreshing, unbind;
  let pending = null, fragment = null, resolved = false, paused = false, generation = 0, mode = 'popup';
  let allLinks = [], linksFetchedAt = null, linksFailed = '', filterText = '';
  const model = {
    state: 'Starting', status: 'Connecting…', connecting: true, resolving: false, busy: false,
    showLogin: false, showAuthKey: false, showSave: false, showReplace: false, showLogout: false, showReset: false,
    identity: '', reachability: '', error: '', message: '', warning: '', uiMessage: '', uiPath: '', cachedLink: null,
    showLinks: false, linkRows: [], linkTotal: 0, linkMatches: 0, linksNote: '',
  };
  const render = () => { if (!disposed) view.render({ ...model }); };
  const cancel = () => { if (timer !== undefined) clearTimer(timer); timer = undefined; };

  function applyLinks() {
    const needle = filterText.trim().toLowerCase();
    const matches = needle ? allLinks.filter(item => [item.short, item.long, item.owner].some(field => field?.toLowerCase().includes(needle))) : allLinks;
    let note = '';
    if (linksFailed) note = linksFailed;
    else if (!linksFetchedAt) note = 'The link list has not loaded yet. It loads after connecting; if it stays empty, check that golink is reachable.';
    else if (!allLinks.length) note = 'No go links yet. Save one above.';
    else if (!matches.length) note = 'No links match the filter.';
    else if (matches.length > maxLinkRows) note = `Showing ${maxLinkRows} of ${matches.length} links. Use the filter to narrow the list.`;
    Object.assign(model, { linkRows: matches.slice(0, maxLinkRows), linkTotal: allLinks.length, linkMatches: matches.length, linksNote: note });
  }

  async function loadLinks(version) {
    let cache, failure = '';
    try {
      cache = await rpc('cachedLinks', []);
      if (!Array.isArray(cache?.links)) failure = 'Could not load links. The extension returned an unexpected reply.';
    } catch (error) { failure = `Could not load links. ${errorText(error)}`; }
    if (disposed || version !== generation) return;
    if (failure) {
      if (failure === linksFailed) return;
      linksFailed = failure;
    } else if (!linksFailed && cache.fetchedAt === linksFetchedAt) return;
    else {
      linksFailed = '';
      linksFetchedAt = cache.fetchedAt;
      allLinks = [...cache.links].sort((a, b) => a.short.localeCompare(b.short));
    }
    applyLinks();
    render();
  }

  function showError(error) {
    if (disposed) return;
    paused = true;
    cancel();
    Object.assign(model, { error: errorText(error), connecting: false, resolving: false, showReset: true });
    render();
  }

  function showStatus(value) {
    const state = value.state || 'NoState';
    Object.assign(model, {
      state, status: Object.hasOwn(stateLabels, state) ? stateLabels[state] : state,
      connecting: state === 'NoState' || state === 'Starting',
      showLogin: state === 'NeedsLogin' || state === 'Stopped',
      showAuthKey: state === 'NeedsLogin', showSave: state === 'Running' && mode !== 'golinkUI',
      showLinks: state === 'Running' && mode === 'popup',
      showLogout: state === 'Running',
      showReset: state === 'Running' || state === 'NeedsMachineAuth' || !Object.hasOwn(stateLabels, state),
      identity: state === 'Running' ? [value.loginName, value.tailnet, value.hostname].filter(Boolean).join(' · ') : '',
      reachability: state === 'Running' ? (value.golinkReachable ? 'Golink is reachable.' : 'Golink is unreachable. Check ACL access to the golink server.') : '',
    });
  }

  function refresh() {
    if (disposed || model.busy) return Promise.resolve();
    if (refreshing) return refreshing;
    cancel();
    const version = generation;
    refreshing = (async () => {
      try {
        const value = await rpc('status', []);
        if (disposed || version !== generation) return;
        showStatus(value);
        render();
        if (model.showLinks) await loadLinks(version);
        if (disposed || version !== generation) return;
        if (value.state === 'Running' && pending !== null && !resolved) {
          model.resolving = true;
          render();
          // The worker performs navigation. Keep the raw pending path until it accepts a resolution.
          const result = await rpc('resolve', [pending]);
          if (disposed || version !== generation) return;
          if (!result.pending) resolved = true;
          if (result.navigate) {
            // Replacing this page keeps it out of session history, so Back
            // returns to the page before the go link instead of resolving again.
            location.replace(result.redirect ? withFragment(result.navigate, fragment) : result.navigate);
            return;
          }
          model.resolving = false;
          render();
        }
      } catch (error) {
        if (version === generation) showError(error);
      } finally {
        refreshing = undefined;
        if (!disposed && !paused && !model.busy) timer = setTimer(refresh, 2000);
      }
    })();
    return refreshing;
  }

  async function action(method, args = []) {
    if (disposed || model.busy) return;
    model.busy = true;
    model.connecting = false;
    model.resolving = false;
    model.error = model.warning = model.message = '';
    model.showReplace = false;
    paused = false;
    generation++;
    cancel();
    render();
    let succeeded = false, exists = false;
    try {
      // Let an older status/resolve settle before sending a state-changing request.
      await refreshing;
      if (disposed) return;
      const result = await rpc(method, args);
      if (disposed) return;
      succeeded = true;
      if (method === 'save') {
        model.message = 'Link saved.';
        if (result?.cacheRefreshError) model.warning = `The autocomplete cache could not refresh. ${errorText(result.cacheRefreshError)}`;
      } else if (method === 'configure') model.message = 'Settings saved. Reconnecting…';
    } catch (error) {
      if (method === 'save' && error?.kind === 'exists') {
        exists = true;
        // golink would let this save silently retarget a shared link.
        model.warning = `${error.message}. Replace it for everyone in the tailnet?`;
        model.showReplace = true;
      } else {
        // Backend errors can echo a submitted key. Never render their content.
        showError(method === 'authKey' ? { message: 'Auth-key login failed. Check the key and try again.' } : error);
      }
    } finally {
      model.busy = false;
      render();
    }
    if ((succeeded || exists) && !disposed) await refresh();
  }

  function retry() {
    if (disposed || model.busy) return Promise.resolve();
    if (refreshing) return refreshing;
    paused = false;
    model.error = '';
    render();
    return refresh();
  }

  return {
    async start() {
      if (started || disposed) return;
      started = true;
      unbind = view.bind({
        login: () => action('login'), logout: () => action('logout'), reset: () => action('reset'), retry,
        authKey(key) { view.clearAuthKey(); return action('authKey', [key]); },
        filter(text) { filterText = text; applyLinks(); render(); },
        save: ({ short, long }) => action('save', [short, long, false]),
        replace: ({ short, long }) => action('save', [short, long, true]),
        configure: ({ golinkHost, controlURL }) => action('configure', [{
          golinkHost: golinkHost.trim() || 'go', controlURL: controlURL.trim() || DEFAULT_CONTROL_URL,
        }]),
      });
      render();
      // URLSearchParams decodes query modes once. Fragment capture stays raw.
      const params = new URLSearchParams(location.search);
      try {
        if (params.has('resolve')) { mode = 'resolve'; pending = params.get('resolve'); }
        else if (params.has('create')) {
          mode = 'create';
          view.prefill({ short: params.get('create'), long: '' });
          model.message = 'Link not found. Enter a target URL to create it.';
        } else if (params.has('golinkUI')) {
          mode = 'golinkUI';
          model.uiMessage = "Golink's web UI needs native Tailscale on this computer. The extension can resolve and save links; browse, edit, and delete in golink with native Tailscale.";
          model.uiPath = params.get('golinkUI');
          let short = model.uiPath.replace(/^\/\.detail\//, '').replace(/\+$/, '').split(/[/?]/)[0];
          try { short = decodeURIComponent(short); } catch { /* A malformed server path simply has no cached match. */ }
          const cache = await rpc('cachedLinks', []);
          if (disposed) return;
          model.cachedLink = cache.links.find(link => linkID(link.short) === linkID(short)) ?? null;
        } else if (params.has('error')) {
          mode = 'error';
          showError({ kind: params.get('error'), message: params.get('msg') || 'The extension could not complete this request.' });
          return;
        } else if (location.hash) {
          mode = 'resolve';
          try { pending = originalURLPath(location.hash.slice(1)); fragment = capturedFragment(location.hash.slice(1)); }
          catch { showError({ message: 'Invalid go-link navigation. Use http://go/name or the go omnibox keyword.' }); return; }
        } else {
          const tab = await activeTab();
          if (disposed) return;
          view.prefill({ long: tab?.url?.startsWith('chrome-extension:') ? '' : tab?.url ?? '' });
        }
        render();
        if (!disposed) await refresh();
      } catch (error) { showError(error); }
    },
    dispose() { disposed = true; generation++; cancel(); unbind?.(); },
  };
}

export function createDOMView(document) {
  const get = id => document.getElementById(id);
  const text = (id, value = '') => { get(id).textContent = value; };
  const visible = (id, show) => { get(id).hidden = !show; };
  let renderedRows;
  return {
    prefill(fields) { for (const [id, value] of Object.entries(fields)) get(id).value = value; },
    clearAuthKey() { get('auth-key').value = ''; },
    render(model) {
      text('status', model.resolving ? 'Opening go link…' : model.status);
      get('status').dataset.connecting = String(Boolean(model.connecting || model.resolving));
      get('main').setAttribute('aria-busy', String(Boolean(model.connecting || model.resolving || model.busy)));
      for (const id of ['identity', 'reachability', 'error', 'message', 'warning']) {
        text(id, model[id] || '');
        visible(id, Boolean(model[id]));
      }
      visible('login-panel', model.showLogin);
      visible('auth-form', model.showAuthKey);
      visible('save-form', model.showSave);
      visible('replace', model.showReplace);
      visible('logout', model.showLogout);
      visible('reset', model.showReset);
      visible('retry', Boolean(model.error));
      visible('ui-panel', Boolean(model.uiMessage));
      text('ui-message', model.uiMessage || '');
      text('ui-path', model.uiPath || '');
      visible('links-panel', Boolean(model.showLinks));
      if (model.linkRows !== renderedRows) {
        renderedRows = model.linkRows;
        get('links-list').replaceChildren(...(model.linkRows ?? []).map(item => {
          const row = document.createElement('li');
          const name = document.createElement('a');
          name.textContent = item.short;
          name.href = `http://go/${encodeURIComponent(item.short)}`;
          name.setAttribute('target', '_blank');
          const target = document.createElement('span');
          target.textContent = item.long;
          const owner = document.createElement('span');
          owner.textContent = item.owner || '';
          row.append(name, target, owner);
          return row;
        }));
      }
      text('links-note', model.linksNote || '');
      visible('links-note', Boolean(model.linksNote));
      visible('cached-link', Boolean(model.cachedLink));
      visible('no-cached-link', Boolean(model.uiMessage && !model.cachedLink));
      for (const key of ['short', 'long', 'owner']) text(`cached-${key}`, model.cachedLink?.[key] || '');
      for (const control of document.querySelectorAll('button,input')) control.disabled = Boolean(model.busy);
    },
    bind(handlers) {
      const listeners = [];
      const on = (id, event, handler) => {
        const element = get(id);
        element.addEventListener(event, handler);
        listeners.push(() => element.removeEventListener(event, handler));
      };
      for (const id of ['login', 'logout', 'reset', 'retry']) on(id, 'click', () => handlers[id]());
      on('auth-form', 'submit', event => { event.preventDefault(); return handlers.authKey(get('auth-key').value); });
      on('save-form', 'submit', event => {
        event.preventDefault();
        return handlers.save({ short: get('short').value, long: get('long').value });
      });
      on('links-filter', 'input', () => handlers.filter(get('links-filter').value));
      on('replace', 'click', () => handlers.replace({ short: get('short').value, long: get('long').value }));
      on('settings-form', 'submit', event => {
        event.preventDefault();
        return handlers.configure({ golinkHost: get('golink-host').value, controlURL: get('control-url').value });
      });
      return () => { for (const remove of listeners) remove(); };
    },
  };
}

// A framed copy cannot issue commands (the worker rejects it), so say why
// instead of polling into errors.
if (globalThis.document && globalThis.chrome?.runtime && globalThis.top !== globalThis) {
  document.getElementById('main').replaceChildren(Object.assign(document.createElement('p'), {
    textContent: 'This page cannot be embedded in another site.',
  }));
} else if (globalThis.document && globalThis.chrome?.runtime) {
  const controller = createStatusController({
    rpc: async (method, args) => {
      const reply = await chrome.runtime.sendMessage({ channel: 'golink', target: 'worker', method, args });
      if (!reply?.ok) throw Object.assign(new Error(reply?.error?.message || 'No response from the extension worker.'), { kind: reply?.error?.kind });
      return reply.value;
    },
    view: createDOMView(document), location: globalThis.location,
    activeTab: async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0],
  });
  addEventListener('pagehide', () => controller.dispose(), { once: true });
  addEventListener('unload', () => controller.dispose(), { once: true });
  void controller.start();
}
