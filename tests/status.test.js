import test from 'node:test';
import assert from 'node:assert/strict';
import { createStatusController, createDOMView } from '../ext/status.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const status = (state, extra = {}) => ({ state, loginName: 'person@example.com', tailnet: 'example.ts.net', hostname: 'golink-ext-abcdef', golinkReachable: true, ...extra });

function fixture({ search = '', hash = '', reply, tab = { url: 'https://example.com/original?x=1' } } = {}) {
  const calls = [], renders = [], fields = {}, timers = new Map(), navigations = [];
  let handlers, cleared = 0, nextTimer = 0, unbound = false, activeQueries = 0;
  const controller = createStatusController({
    rpc: async (method, args = []) => { calls.push([method, args]); return reply ? reply(method, args) : status('Running'); },
    view: {
      bind(value) { handlers = value; return () => { unbound = true; }; },
      render(value) { renders.push(structuredClone(value)); },
      prefill(value) { Object.assign(fields, value); },
      clearAuthKey() { cleared++; },
    },
    location: { search, hash, replace(url) { navigations.push(url); } },
    activeTab: async () => { activeQueries++; return tab; },
    setTimer(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimer(id) { timers.delete(id); },
  });
  return { controller, calls, renders, fields, timers, navigations,
    get handlers() { return handlers; }, get cleared() { return cleared; }, get unbound() { return unbound; }, get activeQueries() { return activeQueries; },
    get last() { return renders.at(-1); },
    async poll() { assert.equal(timers.size, 1); const [id, timer] = [...timers][0]; assert.equal(timer.delay, 2000); timers.delete(id); await timer.callback(); },
  };
}

test('pending navigation waits through login and resolves once when Running', async () => {
  const states = ['Starting', 'NeedsLogin', 'Running', 'Running'];
  const f = fixture({ search: '?resolve=foo%252Fbar%3Fx%3D%2525%26x%3D2', reply: method => method === 'status' ? status(states.shift()) : { redirect: 'https://example.com' } });
  await f.controller.start();
  assert.equal(f.last.connecting, true);
  await f.poll();
  assert.equal(f.last.showAuthKey, true);
  assert.equal(f.calls.filter(([method]) => method === 'resolve').length, 0);
  await f.poll();
  assert.deepEqual(f.calls.filter(([method]) => method === 'resolve'), [['resolve', ['foo%2Fbar?x=%25&x=2']]]);
  await f.poll();
  assert.equal(f.calls.filter(([method]) => method === 'resolve').length, 1);
  f.controller.dispose();
});

test('dispose clears polling and ignores a late status reply', async () => {
  const wait = deferred();
  const f = fixture({ reply: () => wait.promise });
  const started = f.controller.start();
  await tick();
  const count = f.renders.length;
  f.controller.dispose();
  wait.resolve(status('Running'));
  await started;
  assert.equal(f.renders.length, count);
  assert.equal(f.timers.size, 0);
  assert.equal(f.unbound, true);
});

test('popup saves entered short name with original active URL and clears submitted auth key', async () => {
  const f = fixture({ reply: method => method === 'status' ? status('NeedsLogin') : { ok: true } });
  await f.controller.start();
  assert.equal(f.fields.long, 'https://example.com/original?x=1');
  await f.handlers.authKey('test-secret');
  assert.equal(f.cleared, 1);
  assert.deepEqual(f.calls.find(([method]) => method === 'authKey'), ['authKey', ['test-secret']]);
  await f.handlers.save({ short: 'docs', long: f.fields.long });
  assert.deepEqual(f.calls.find(([method]) => method === 'save'), ['save', ['docs', 'https://example.com/original?x=1', false]]);
  assert.match(f.last.message, /saved/i);
  f.controller.dispose();
});

test('saving an existing name asks before replacing the shared link', async () => {
  const f = fixture({ reply: (method, args) => {
    if (method !== 'save') return status('Running');
    if (!args[2]) throw Object.assign(new Error('go/docs already points to https://old.example'), { kind: 'exists' });
    return { ok: true };
  } });
  await f.controller.start();
  await f.handlers.save({ short: 'docs', long: 'https://new.example' });
  assert.match(f.last.warning, /already points to https:\/\/old\.example.*Replace/);
  assert.equal(f.last.showReplace, true);
  assert.equal(f.last.error, '');
  assert.equal(f.timers.size, 1, 'an existing link is not an error that stops polling');
  await f.handlers.replace({ short: 'docs', long: 'https://new.example' });
  assert.deepEqual(f.calls.filter(([method]) => method === 'save').map(([, args]) => args), [['docs', 'https://new.example', false], ['docs', 'https://new.example', true]]);
  assert.equal(f.last.showReplace, false);
  assert.match(f.last.message, /saved/i);
  f.controller.dispose();
});

for (const [state, expected] of [
  ['NoState', { status: /Connecting/, connecting: true }],
  ['Starting', { status: /Connecting/, connecting: true }],
  ['NeedsLogin', { status: /Log in/, showLogin: true, showAuthKey: true }],
  ['NeedsMachineAuth', { status: /admin.*approve/i, showReset: true }],
  ['Running', { status: /Connected/, showSave: true, showLogout: true, showReset: true }],
  ['Stopped', { status: /Stopped/, showLogin: true, showAuthKey: false }],
  ['UnexpectedFutureState', { status: /^UnexpectedFutureState$/, showReset: true }],
]) {
  test(`renders ${state} with the appropriate recovery controls`, async () => {
    const f = fixture({ reply: () => status(state) });
    await f.controller.start();
    for (const [key, value] of Object.entries(expected)) value instanceof RegExp ? assert.match(f.last[key], value) : assert.equal(f.last[key], value);
    f.controller.dispose();
  });
}

test('Running shows identity and unreachable ACL guidance', async () => {
  const f = fixture({ reply: () => status('Running', { golinkReachable: false }) });
  await f.controller.start();
  assert.match(f.last.identity, /person@example.com/);
  assert.match(f.last.identity, /example.ts.net/);
  assert.match(f.last.identity, /golink-ext-abcdef/);
  assert.match(f.last.reachability, /ACL.*golink server/);
  f.controller.dispose();
});

test('404 create mode prefills only the missing name without reading its extension tab URL', async () => {
  const f = fixture({ search: '?create=foo%2Bbar', tab: { url: 'chrome-extension://id/status.html?create=foo' } });
  await f.controller.start();
  assert.deepEqual(f.fields, { short: 'foo+bar', long: '' });
  assert.equal(f.activeQueries, 0);
  assert.match(f.last.message, /not found/i);
  f.controller.dispose();
});

test('golink UI mode reads only the matching cached record and explains native Tailscale', async () => {
  const f = fixture({ search: '?golinkUI=%2F.detail%2Ffoo', reply: method => method === 'cachedLinks' ? { fetchedAt: 123, links: [{ short: 'foo', long: 'https://example.com/<unsafe>', owner: 'person' }] } : status('Running') });
  await f.controller.start();
  assert.equal(f.activeQueries, 0);
  assert.equal(f.last.showSave, false);
  assert.match(f.last.uiMessage, /native Tailscale/i);
  assert.deepEqual(f.last.cachedLink, { short: 'foo', long: 'https://example.com/<unsafe>', owner: 'person' });
  assert.deepEqual(f.calls.filter(([method]) => method !== 'status'), [['cachedLinks', []]]);
  f.controller.dispose();
});

test('fragment capture preserves the raw suffix including encoded slash and repeated query', async () => {
  const f = fixture({ hash: '#http://go/foo%2Fbar/../x?x=%2525&x=a+b', reply: method => method === 'status' ? status('Running') : { pending: true } });
  await f.controller.start();
  assert.deepEqual(f.calls.find(([method]) => method === 'resolve'), ['resolve', ['foo%2Fbar/../x?x=%2525&x=a+b']]);
  assert.equal(f.activeQueries, 0);
  f.controller.dispose();
});

for (const [name, result, expected] of [
  ['a destination without a fragment inherits the captured one', { redirect: 'https://wiki.example/a', navigate: 'https://wiki.example/a' }, 'https://wiki.example/a#setup'],
  ['a destination keeps its own fragment', { redirect: 'https://wiki.example/a#top', navigate: 'https://wiki.example/a#top' }, 'https://wiki.example/a#top'],
  ['a local create page ignores the fragment', { notFound: true, navigate: 'chrome-extension://id/status.html?create=wiki' }, 'chrome-extension://id/status.html?create=wiki'],
]) {
  test(`direct capture with a fragment: ${name}`, async () => {
    const f = fixture({ hash: '#http://go/wiki#setup', reply: method => method === 'status' ? status('Running') : result });
    await f.controller.start();
    assert.deepEqual(f.calls.find(([method]) => method === 'resolve'), ['resolve', ['wiki']]);
    assert.deepEqual(f.navigations, [expected]);
    f.controller.dispose();
  });
}

test('golink UI mode matches cached names as golink does, without case or dashes', async () => {
  const f = fixture({ search: '?golinkUI=%2F.detail%2FMy-Docs', reply: method => method === 'cachedLinks' ? { fetchedAt: 1, links: [{ short: 'mydocs', long: 'https://example.com/', owner: 'person' }] } : status('Running') });
  await f.controller.start();
  assert.equal(f.last.cachedLink?.short, 'mydocs');
  f.controller.dispose();
});

test('invalid direct capture renders a recoverable error without sending a resolve', async () => {
  const f = fixture({ hash: '#https://other.example/foo' });
  await f.controller.start();
  assert.match(f.last.error, /invalid.*navigation/i);
  assert.equal(f.last.connecting, false);
  assert.equal(f.last.showReset, true);
  assert.equal(f.calls.length, 0);
  f.controller.dispose();
});

for (const [kind, message, expected] of [
  ['unreachable', 'dial failed', /ACL.*golink server.*port 80.*443/],
  ['timeout', 'deadline exceeded', /timed out/i],
  ['http', 'permission denied by golink', /HTTP.*permission denied by golink/],
]) {
  test(`error mode distinguishes ${kind} failures`, async () => {
    const f = fixture({ search: `?error=${kind}&msg=${encodeURIComponent(message)}` });
    await f.controller.start();
    assert.match(f.last.error, expected);
    assert.equal(f.last.connecting, false);
    assert.equal(f.last.showReset, true);
    assert.equal(f.activeQueries, 0);
    f.controller.dispose();
  });
}

test('RPC failure stops polling and retry resumes status and the pending path', async () => {
  let failing = true;
  const f = fixture({ search: '?resolve=foo', reply: method => {
    if (method === 'status') return status('Running');
    if (failing) throw Object.assign(new Error('timed out'), { kind: 'timeout' });
    return { redirect: 'https://example.com' };
  } });
  await f.controller.start();
  assert.match(f.last.error, /timed out/i);
  assert.equal(f.last.connecting, false);
  assert.equal(f.last.showReset, true);
  assert.equal(f.timers.size, 0);
  failing = false;
  await f.handlers.retry();
  assert.equal(f.last.error, '');
  assert.equal(f.calls.filter(([method]) => method === 'resolve').length, 2);
  assert.equal(f.timers.size, 1);
  f.controller.dispose();
});

test('pending reply can retry while repeated clicks never duplicate in-flight status or resolve', async () => {
  const wait = deferred();
  let resolves = 0;
  const f = fixture({ search: '?resolve=foo', reply: method => method === 'status' ? status('Running') : (++resolves === 1 ? { pending: true } : wait.promise) });
  await f.controller.start();
  const next = f.poll();
  await tick();
  const again = f.handlers.retry();
  const third = f.handlers.retry();
  await tick();
  assert.equal(f.calls.filter(([method]) => method === 'status').length, 2);
  assert.equal(resolves, 2);
  wait.resolve({ redirect: 'https://example.com' });
  await Promise.all([next, again, third]);
  await f.poll();
  assert.equal(resolves, 2);
  f.controller.dispose();
});

test('auth-key rejection clears the input immediately, hides raw error text, and restores controls', async () => {
  const wait = deferred();
  const f = fixture({ reply: method => method === 'status' ? status('NeedsLogin') : wait.promise });
  await f.controller.start();
  const action = f.handlers.authKey('private-auth-key');
  assert.equal(f.cleared, 1);
  assert.equal(f.last.busy, true);
  wait.reject(new Error('backend echoed private-auth-key'));
  await action;
  assert.equal(f.last.busy, false);
  assert.equal(f.last.showAuthKey, true);
  assert.match(f.last.error, /key.*try again/i);
  assert.equal(JSON.stringify(f.renders).includes('private-auth-key'), false);
  f.controller.dispose();
});

test('successful save reports a cache refresh warning separately', async () => {
  const f = fixture({ reply: method => method === 'status' ? status('Running') : { ok: true, cacheRefreshError: { kind: 'timeout', message: 'export timeout' } } });
  await f.controller.start();
  await f.handlers.save({ short: 'docs', long: f.fields.long });
  assert.match(f.last.message, /saved/i);
  assert.match(f.last.warning, /cache.*timed out/i);
  assert.equal(f.last.error, '');
  f.controller.dispose();
});

test('settings supply working defaults and support the full MagicDNS hostname', async () => {
  const f = fixture();
  await f.controller.start();
  await f.handlers.configure({ golinkHost: '', controlURL: '' });
  await f.handlers.configure({ golinkHost: 'go.example.ts.net', controlURL: 'https://control.example.com' });
  assert.deepEqual(f.calls.filter(([method]) => method === 'configure'), [
    ['configure', [{ golinkHost: 'go', controlURL: 'https://controlplane.tailscale.com' }]],
    ['configure', [{ golinkHost: 'go.example.ts.net', controlURL: 'https://control.example.com' }]],
  ]);
  f.controller.dispose();
});

test('login, logout, and reset use worker actions and refresh status', async () => {
  const f = fixture();
  await f.controller.start();
  await f.handlers.login();
  await f.handlers.logout();
  await f.handlers.reset();
  assert.deepEqual(f.calls.map(([method]) => method).filter(method => method !== 'cachedLinks'), ['status', 'login', 'status', 'logout', 'status', 'reset', 'status']);
  assert.equal(f.timers.size, 1);
  f.controller.dispose();
});

test('typing has no registered request handler and no network effect', async () => {
  const f = fixture();
  await f.controller.start();
  assert.equal(f.handlers.input, undefined);
  assert.equal(f.handlers.change, undefined);
  assert.deepEqual(f.calls, [['status', []], ['cachedLinks', []]]);
  f.controller.dispose();
});

test('reset waits for an outstanding status and discards its stale result', async () => {
  const wait = deferred();
  let statuses = 0;
  const f = fixture({ reply: method => method === 'status' ? (++statuses === 1 ? wait.promise : status('NeedsLogin')) : { ok: true } });
  const starting = f.controller.start();
  await tick();
  const resetting = f.handlers.reset();
  assert.equal(f.last.busy, true);
  wait.resolve(status('Running'));
  await Promise.all([starting, resetting]);
  assert.equal(f.renders.some(render => render.state === 'Running'), false);
  assert.equal(f.last.state, 'NeedsLogin');
  assert.deepEqual(f.calls.map(([method]) => method), ['status', 'reset', 'status']);
  assert.equal(f.timers.size, 1);
  f.controller.dispose();
});

test('disposing a scheduled refresh cancels it and prevents later actions', async () => {
  const f = fixture();
  await f.controller.start();
  assert.equal(f.timers.size, 1);
  f.controller.dispose();
  await f.handlers.reset();
  await f.handlers.retry();
  assert.equal(f.timers.size, 0);
  assert.deepEqual(f.calls, [['status', []], ['cachedLinks', []]]);
});

test('unknown state names cannot inherit labels from Object.prototype', async () => {
  const f = fixture({ reply: () => status('toString') });
  await f.controller.start();
  assert.equal(f.last.status, 'toString');
  assert.equal(f.last.showReset, true);
  f.controller.dispose();
});

function documentFixture() {
  const nodes = new Map();
  const document = {
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, { hidden: false, value: '', textContent: '', disabled: false, dataset: {}, attributes: {}, listeners: new Map(),
        setAttribute(name, value) { this.attributes[name] = value; },
        addEventListener(type, handler) { this.listeners.set(type, handler); },
        removeEventListener(type, handler) { if (this.listeners.get(type) === handler) this.listeners.delete(type); },
        set innerHTML(value) { throw new Error('Do not use HTML for untrusted text'); },
        replaceChildren(...items) { this.children = items; },
      });
      return nodes.get(id);
    },
    querySelectorAll: () => [...nodes.values()],
    createElement: tag => ({ tag, textContent: '', href: '', children: [], dataset: {}, append(...items) { this.children.push(...items); }, setAttribute(name, value) { this[name] = value; } }),
  };
  return { document, get: id => document.getElementById(id) };
}

test('DOM view renders untrusted content as text, preserves edited fields and disables busy controls', () => {
  const f = documentFixture();
  const view = createDOMView(f.document);
  view.prefill({ short: 'docs', long: 'https://example.com' });
  f.get('short').value = 'edited';
  view.render({ status: 'Connected', showSave: true, showLogin: false, showAuthKey: false, showLogout: true, showReset: true, busy: true,
    error: '<img src=x onerror=alert(1)>', identity: 'person@example.com', cachedLink: { short: '<foo>', long: 'https://example.com/<script>', owner: '<owner>' }, uiMessage: 'Native Tailscale required', uiPath: '/.detail/foo' });
  assert.equal(f.get('error').textContent, '<img src=x onerror=alert(1)>');
  assert.equal(f.get('error').hidden, false);
  assert.equal(f.get('save-form').hidden, false);
  assert.equal(f.get('short').value, 'edited');
  assert.equal(f.get('short').disabled, true);
  assert.equal(f.get('cached-short').textContent, '<foo>');
  assert.equal(f.get('cached-long').textContent, 'https://example.com/<script>');
  assert.equal(f.get('cached-owner').textContent, '<owner>');
});

test('DOM bindings read form values on submit, clear auth input, and remove listeners on disposal', async () => {
  const f = documentFixture();
  const view = createDOMView(f.document);
  const calls = [];
  const unbind = view.bind({ save: value => calls.push(['save', value]), authKey: value => { view.clearAuthKey(); calls.push(['authKey', value]); }, configure: value => calls.push(['configure', value]), login() {}, logout() {}, reset() {}, retry() {} });
  f.get('short').value = 'docs'; f.get('long').value = 'https://example.com';
  f.get('auth-key').value = 'transient-secret';
  let prevented = 0;
  const event = { preventDefault() { prevented++; } };
  await f.get('save-form').listeners.get('submit')(event);
  await f.get('auth-form').listeners.get('submit')(event);
  assert.deepEqual(calls, [['save', { short: 'docs', long: 'https://example.com' }], ['authKey', 'transient-secret']]);
  assert.equal(f.get('auth-key').value, '');
  assert.equal(prevented, 2);
  assert.equal(f.get('short').listeners.has('input'), false);
  unbind();
  assert.equal(f.get('save-form').listeners.size, 0);
  assert.equal(f.get('auth-form').listeners.size, 0);
});

test('reset clears an invalidated deferred resolve spinner before NeedsLogin', async () => {
  const wait = deferred();
  const states = ['Running', 'NeedsLogin', 'Running'];
  let resolves = 0;
  const f = fixture({ search: '?resolve=docs', reply: method => {
    if (method === 'status') return status(states.shift());
    if (method === 'resolve') return ++resolves === 1 ? wait.promise : { redirect: 'https://example.com/docs' };
    return { ok: true };
  } });
  const starting = f.controller.start();
  await tick();
  assert.equal(f.last.resolving, true);
  const resetting = f.handlers.reset();
  assert.equal(f.last.busy, true);
  wait.resolve({ pending: true });
  await Promise.all([starting, resetting]);
  assert.equal(f.last.state, 'NeedsLogin');
  assert.equal(f.last.resolving, false);
  assert.equal(f.last.connecting, false);
  assert.equal(f.last.busy, false);
  assert.equal(f.last.showAuthKey, true);
  const dom = documentFixture();
  createDOMView(dom.document).render(f.last);
  assert.equal(dom.get('status').textContent, 'Log in to Tailscale');
  assert.equal(dom.get('status').dataset.connecting, 'false');
  assert.equal(dom.get('main').attributes['aria-busy'], 'false');
  assert.equal(resolves, 1);
  await f.poll();
  assert.equal(resolves, 2);
  assert.equal(f.last.resolving, false);
  f.controller.dispose();
});

const link = (short, long = `https://example.com/${short}`, owner = 'person@example.com') => ({ short, long, owner });
const linksFixture = (links, extra = {}) => fixture({ ...extra, reply: (method, args) => {
  if (method === 'cachedLinks') return { fetchedAt: links.length || extra.fetchedAt ? Date.now() : 0, links };
  return extra.reply ? extra.reply(method, args) : status('Running');
} });

test('a connected popup lists every cached link sorted by name beside the save form', async () => {
  const f = linksFixture([link('zeta'), link('Alpha'), link('docs')]);
  await f.controller.start();
  assert.equal(f.last.showSave, true);
  assert.equal(f.last.showLinks, true);
  assert.deepEqual(f.last.linkRows.map(row => row.short), ['Alpha', 'docs', 'zeta']);
  assert.equal(f.last.linkRows[0].owner, 'person@example.com');
  assert.equal(f.last.linksNote, '');
  f.controller.dispose();
});

test('the link list is hidden for resolve, create, golink UI and error pages and before Running', async () => {
  for (const search of ['?resolve=foo', '?create=foo', '?error=timeout']) {
    const f = linksFixture([link('docs')], { search });
    await f.controller.start();
    assert.equal(f.last.showLinks, false, search);
    assert.equal(f.calls.some(([method]) => method === 'cachedLinks'), false, search);
    f.controller.dispose();
  }
  const f = linksFixture([link('docs')], { reply: method => method === 'status' ? status('NeedsLogin') : undefined });
  await f.controller.start();
  assert.equal(f.last.showLinks, false);
  assert.equal(f.calls.some(([method]) => method === 'cachedLinks'), false);
  f.controller.dispose();
});

test('filtering matches name, target and owner without case and sends no request', async () => {
  const f = linksFixture([link('docs', 'https://example.com/handbook', 'ann@example.com'), link('wiki', 'https://wiki.example.com', 'bob@example.com'), link('Handbook-2')]);
  await f.controller.start();
  const calls = f.calls.length;
  f.handlers.filter('HANDBOOK');
  assert.deepEqual(f.last.linkRows.map(row => row.short), ['docs', 'Handbook-2']);
  f.handlers.filter('bob@');
  assert.deepEqual(f.last.linkRows.map(row => row.short), ['wiki']);
  f.handlers.filter('nothing');
  assert.deepEqual(f.last.linkRows, []);
  assert.match(f.last.linksNote, /no links match/i);
  assert.equal(f.calls.length, calls);
  f.controller.dispose();
});

test('a cache with no links explains that none exist, and an unloaded cache says so', async () => {
  const empty = fixture({ reply: method => method === 'cachedLinks' ? { fetchedAt: 1, links: [] } : status('Running') });
  await empty.controller.start();
  assert.match(empty.last.linksNote, /no go links yet/i);
  empty.controller.dispose();
  const unloaded = fixture({ reply: method => method === 'cachedLinks' ? { fetchedAt: 0, links: [] } : status('Running') });
  await unloaded.controller.start();
  assert.match(unloaded.last.linksNote, /not loaded/i);
  assert.equal(unloaded.last.showSave, true);
  unloaded.controller.dispose();
});

test('a failed cache read reports it in the list but keeps the save form and polling', async () => {
  const f = fixture({ reply: method => {
    if (method === 'cachedLinks') throw Object.assign(new Error('worker gone'), { kind: 'timeout' });
    return status('Running');
  } });
  await f.controller.start();
  assert.match(f.last.linksNote, /could not load.*timed out/i);
  assert.equal(f.last.showSave, true);
  assert.equal(f.last.error, '');
  assert.equal(f.timers.size, 1);
  f.controller.dispose();
});

test('the list picks up a saved link', async () => {
  const links = [link('docs')];
  const f = fixture({ reply: (method, args) => {
    if (method === 'cachedLinks') return { fetchedAt: links.length, links: [...links] };
    if (method === 'save') { links.push(link(args[0], args[1])); return { ok: true }; }
    return status('Running');
  } });
  await f.controller.start();
  assert.deepEqual(f.last.linkRows.map(row => row.short), ['docs']);
  await f.handlers.save({ short: 'new', long: 'https://example.org' });
  assert.deepEqual(f.last.linkRows.map(row => row.short), ['docs', 'new']);
  f.controller.dispose();
});

test('a list of 5000 links renders at most 200 rows and says how to see the rest', async () => {
  const f = linksFixture(Array.from({ length: 5000 }, (_, index) => link(`link-${String(index).padStart(4, '0')}`)));
  await f.controller.start();
  assert.equal(f.last.linkRows.length, 200);
  assert.equal(f.last.linkTotal, 5000);
  assert.equal(f.last.linkMatches, 5000);
  assert.match(f.last.linksNote, /200 of 5000.*filter/i);
  f.handlers.filter('link-4999');
  assert.deepEqual(f.last.linkRows.map(row => row.short), ['link-4999']);
  assert.equal(f.last.linksNote, '');
  f.controller.dispose();
});

test('DOM view renders links as text with a go URL and leaves the filter box alone', () => {
  const f = documentFixture();
  const view = createDOMView(f.document);
  f.get('links-filter').value = 'ty';
  view.render({ showLinks: true, linkRows: [link('<b>x/y</b>', 'https://example.com/<script>', '<owner>')], linkTotal: 1, linkMatches: 1, linksNote: '' });
  assert.equal(f.get('links-panel').hidden, false);
  assert.equal(f.get('links-filter').value, 'ty');
  const [item] = f.get('links-list').children;
  const [anchor, target, owner] = item.children;
  assert.equal(anchor.textContent, '<b>x/y</b>');
  assert.equal(anchor.href, 'http://go/%3Cb%3Ex%2Fy%3C%2Fb%3E');
  assert.equal(target.textContent, 'https://example.com/<script>');
  assert.equal(owner.textContent, '<owner>');
});

test('DOM view binds the filter box to the filter handler', () => {
  const f = documentFixture();
  const view = createDOMView(f.document);
  const seen = [];
  const unbind = view.bind({ filter: value => seen.push(value), login() {}, logout() {}, reset() {}, retry() {} });
  f.get('links-filter').value = 'doc';
  f.get('links-filter').listeners.get('input')();
  assert.deepEqual(seen, ['doc']);
  unbind();
  assert.equal(f.get('links-filter').listeners.size, 0);
});

test('DOM view keeps the rendered rows when the same list is rendered again', () => {
  const f = documentFixture();
  const view = createDOMView(f.document);
  const model = { showLinks: true, linkRows: [link('docs')], linkTotal: 1, linkMatches: 1, linksNote: '' };
  view.render(model);
  const rows = f.get('links-list').children;
  view.render({ ...model });
  assert.equal(f.get('links-list').children, rows);
  view.render({ ...model, linkRows: [link('docs')] });
  assert.notEqual(f.get('links-list').children, rows);
});
