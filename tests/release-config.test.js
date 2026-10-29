import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => JSON.parse(fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));
const config = read('release-please-config.json');
const versions = read('.release-please-manifest.json');
const manifest = read('ext/manifest.json');

test('release-please versions the extension manifest through the simple type', () => {
  const root = config.packages['.'];
  assert.equal(root['release-type'], 'simple');
  assert.equal(root['bump-minor-pre-major'], true);
  assert.equal(root['initial-version'], '0.1.0');
  assert.deepEqual(root['extra-files'], [{ type: 'json', path: 'ext/manifest.json', jsonpath: '$.version' }]);
});

test('the last released version is never ahead of the manifest version', () => {
  const parts = version => version.split('.').map(Number);
  const [released, current] = [parts(versions['.']), parts(manifest.version)];
  const ahead = released.some((n, i) => released.slice(0, i).every((m, j) => m === current[j]) && n > current[i]);
  assert.equal(ahead, false);
});

test('tags carry no component prefix, matching the update XML codebase URL', () => {
  assert.equal(config.packages['.']['include-component-in-tag'], false);
});
