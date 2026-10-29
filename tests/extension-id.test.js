import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const { extensionID } = createRequire(import.meta.url)('../scripts/extension-id.cjs');
const fixture = name => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8').trim();

test('extension ID is derived from the manifest key', () => {
  assert.equal(extensionID(fixture('test-public-key.b64')), fixture('test-extension-id.txt'));
});

test('extension ID uses only the letters a to p and has 32 characters', () => {
  assert.match(extensionID(fixture('test-public-key.b64')), /^[a-p]{32}$/);
});

test('extension ID rejects a key that is not base64 DER', () => {
  assert.throws(() => extensionID('not a key'), /public key/);
});

test('the manifest declares a key so every install has the same ID', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../ext/manifest.json', import.meta.url), 'utf8'));
  assert.ok(manifest.key, 'ext/manifest.json needs a key');
  assert.match(extensionID(manifest.key), /^[a-p]{32}$/);
});
