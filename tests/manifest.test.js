import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const manifest = JSON.parse(fs.readFileSync(new URL('../ext/manifest.json', import.meta.url), 'utf8'));

test('update_url is the HTTPS update.xml of this repository\'s latest release', () => {
  assert.equal(manifest.update_url,
    'https://github.com/rshade/golink_chrome_extension/releases/latest/download/update.xml');
});

test('the manifest version is one Chrome accepts', () => {
  assert.match(manifest.version, /^(0|[1-9]\d{0,4})(\.(0|[1-9]\d{0,4})){0,3}$/);
});
