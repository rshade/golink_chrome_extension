const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const vm = require('node:vm');
globalThis.crypto ??= require('node:crypto').webcrypto;
// Go's runtime is a classic script, including in this repo's ESM package.
vm.runInThisContext(fs.readFileSync(path.resolve('ext/wasm_exec.js'), 'utf8'), {filename: 'wasm_exec.js'});
const go = new Go();
const timer = setTimeout(() => { console.error('WASM API startup timed out'); process.exit(1); }, 10000);
(async () => {
  const {instance} = await WebAssembly.instantiate(fs.readFileSync('ext/main.wasm'), go.importObject);
  go.run(instance).catch(err => { console.error(err); process.exit(1); });
  while (!globalThis.golinkExt) await new Promise(resolve => setTimeout(resolve, 10));
  for (const method of ['start', 'login', 'logout', 'status', 'resolve', 'save', 'links']) {
    assert.equal(typeof golinkExt[method], 'function', method);
  }
  // No start call: this smoke check must not create a node or contact a tailnet.
  for (const [method, args] of [['login', []], ['logout', []], ['status', []], ['resolve', ['demo']], ['save', ['demo', 'https://example.com', false]], ['links', []]]) {
    const promise = golinkExt[method](...args);
    assert.ok(promise instanceof Promise, `${method} returns a Promise`);
    await assert.rejects(promise, /node is not started/);
  }
  clearTimeout(timer);
  process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
