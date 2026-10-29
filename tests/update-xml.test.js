import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { updateXML } = createRequire(import.meta.url)('../scripts/update-xml.cjs');
const id = 'abcdefghijklmnopabcdefghijklmnop';
const codebase = 'https://github.com/rshade/golink_chrome_extension/releases/download/v1.2.3/golink-ext-1.2.3.crx';

test('update XML is a gupdate document naming the app, CRX URL, and version', () => {
  const xml = updateXML({ id, version: '1.2.3', codebase });
  assert.match(xml, /^<\?xml version='1\.0' encoding='UTF-8'\?>/);
  assert.match(xml, /<gupdate xmlns='http:\/\/www\.google\.com\/update2\/response' protocol='2\.0'>/);
  assert.match(xml, new RegExp(`<app appid='${id}'>`));
  assert.ok(xml.includes(`<updatecheck codebase='${codebase}' version='1.2.3' />`), xml);
  assert.ok(xml.endsWith('</gupdate>\n'));
});

test('update XML escapes characters that are special in XML attributes', () => {
  const xml = updateXML({ id, version: '1.2.3', codebase: 'https://example.com/a.crx?x=1&y=2' });
  assert.ok(xml.includes("codebase='https://example.com/a.crx?x=1&amp;y=2'"), xml);
});

test('update XML rejects a download URL that is not HTTPS', () => {
  assert.throws(() => updateXML({ id, version: '1.2.3', codebase: 'http://example.com/a.crx' }), /https/i);
});

test('update XML rejects an extension ID that Chrome would not accept', () => {
  for (const bad of ['', 'ABCDEFGHIJKLMNOPABCDEFGHIJKLMNOP', 'abc', `${id}a`, 'qbcdefghijklmnopabcdefghijklmnop']) {
    assert.throws(() => updateXML({ id: bad, version: '1.2.3', codebase }), /extension ID/);
  }
});

test('update XML rejects a version that is not valid in a Chrome manifest', () => {
  for (const bad of ['', '1.2.3-rc.1', 'v1.2.3', '1.2.3.4.5', '1..2', '01.2.3']) {
    assert.throws(() => updateXML({ id, version: bad, codebase }), /version/);
  }
});
