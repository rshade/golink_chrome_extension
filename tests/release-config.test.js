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
  assert.deepEqual(root['extra-files'], [{ type: 'json', path: 'ext/manifest.json', jsonpath: '$.version' }]);
});

test('the release-please version matches the manifest version', () => {
  assert.equal(versions['.'], manifest.version);
});

test('tags carry no component prefix, matching the update XML codebase URL', () => {
  assert.equal(config.packages['.']['include-component-in-tag'], false);
});
