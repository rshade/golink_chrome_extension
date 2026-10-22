import test from 'node:test';
import assert from 'node:assert/strict';
import { inputPath, originalURLPath, capturedFragment, withFragment, suggestions, escapeXML, recordFatal } from '../ext/lib.js';

test('input preserves escaping and query', () => {
  assert.equal(inputPath(' foo/a%2Fb?x=1&x=2 '), 'foo/a%2Fb?x=1&x=2');
  assert.equal(originalURLPath('http://go/foo/a%2Fb?x=1&x=2'), 'foo/a%2Fb?x=1&x=2');
});

test('prefixes rank before substrings', () => {
  const links = [
    { short: 'mydocs', long: 'https://a', owner: 'a' },
    { short: 'Docs', long: 'https://b', owner: 'b' },
  ];
  assert.deepEqual(suggestions(links, 'doc', 1).map(s => s.content), ['Docs']);
});

test('suggestion markup is escaped', () => {
  assert.equal(escapeXML('<&>"'), '&lt;&amp;&gt;&quot;');
});

test('second fatal inside sixty seconds blocks retry', () => {
  assert.deepEqual(recordFatal([1000], 2000), { timestamps: [1000, 2000], blocked: true });
  assert.equal(recordFatal([1000], 62000).blocked, false);
});

for (const [input, expected] of [
  ['', ''],
  [' \t\n', ''],
  [' go/ ', ''],
  [' /foo+ ', 'foo+'],
  ['go/foo%252F', 'foo%252F'],
  ['foo?x=1&x=2', 'foo?x=1&x=2'],
  ['go/日本語/é', '日本語/é'],
  ['foo?x=%23', 'foo?x=%23'],
  ['go//foo', '/foo'],
  ['go/ foo ', ' foo'],
]) {
  test(`omnibox input ${JSON.stringify(input)} preserves its remainder`, () => {
    assert.equal(inputPath(input), expected);
  });
}

for (const [url, expected] of [
  ['http://go/', ''],
  ['http://go/foo+', 'foo+'],
  ['http://go/foo%252F', 'foo%252F'],
  ['http://go/foo?x=1&x=2', 'foo?x=1&x=2'],
  ['http://go/日本語/é', '日本語/é'],
  ['http://go/foo?x=%23', 'foo?x=%23'],
  ['http://go/foo/../bar?x=one+two&&flag&', 'foo/../bar?x=one+two&&flag&'],
]) {
  test(`captured URL ${JSON.stringify(url)} keeps its raw suffix`, () => {
    assert.equal(originalURLPath(url), expected);
  });
}

for (const url of [
  'https://example.com/',
  'https://go/foo',
  'http://go.example/foo',
  'http://go@evil.example/foo',
  'http://go:8080/foo',
  '/foo',
]) {
  test(`captured URL rejects ${JSON.stringify(url)}`, () => {
    assert.throws(() => originalURLPath(url), TypeError);
  });
}

for (const [url, path, fragment] of [
  ['http://go/wiki#setup', 'wiki', 'setup'],
  ['http://go/wiki?x=1#a#b', 'wiki?x=1', 'a#b'],
  ['http://go/wiki#', 'wiki', ''],
  ['http://go/wiki', 'wiki', null],
]) {
  test(`captured URL ${JSON.stringify(url)} separates its fragment`, () => {
    assert.equal(originalURLPath(url), path);
    assert.equal(capturedFragment(url), fragment);
  });
}

test('a destination keeps its own fragment and otherwise inherits the captured one', () => {
  assert.equal(withFragment('https://example.com/a', 'setup'), 'https://example.com/a#setup');
  assert.equal(withFragment('https://example.com/a#own', 'setup'), 'https://example.com/a#own');
  assert.equal(withFragment('https://example.com/a', null), 'https://example.com/a');
});

test('status.html is web accessible from any initiator so clicked go links reach it', async () => {
  const { readFile } = await import('node:fs/promises');
  const manifest = JSON.parse(await readFile(new URL('../ext/manifest.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.web_accessible_resources, [{ resources: ['status.html'], matches: ['<all_urls>'] }]);
});

test('suggestions sort each match group by case-insensitive name with stable case ties', () => {
  const links = ['zDOC', 'docz', 'aDOC', 'Docs', 'docs', 'DocA']
    .map(short => ({ short, long: 'https://example.com/', owner: 'owner' }));
  assert.deepEqual(suggestions(links, 'DOC', 10).map(s => s.content),
    ['DocA', 'Docs', 'docs', 'docz', 'aDOC', 'zDOC']);
  assert.deepEqual(links.map(link => link.short), ['zDOC', 'docz', 'aDOC', 'Docs', 'docs', 'DocA']);
});

test('suggestions return no matches and honor the default and explicit caps', () => {
  const links = ['g', 'f', 'e', 'd', 'c', 'b', 'a']
    .map(short => ({ short, long: 'https://example.com/', owner: 'owner' }));
  assert.deepEqual(suggestions(links, 'missing'), []);
  assert.deepEqual(suggestions(links, '').map(s => s.content), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(suggestions(links, '', 2).map(s => s.content), ['a', 'b']);
  assert.deepEqual(suggestions(links, '', 0), []);
});

test('suggestions escape every displayed field while keeping navigation content raw', () => {
  const [suggestion] = suggestions([{
    short: '<docs&"\'>',
    long: 'https://example.com/?a=1&b=<"\'>',
    owner: '<owner&"\'>',
  }], 'docs');
  assert.equal(suggestion.content, '<docs&"\'>');
  assert.equal(suggestion.description,
    '<match>&lt;docs&amp;&quot;&apos;&gt;</match> <url>https://example.com/?a=1&amp;b=&lt;&quot;&apos;&gt;</url> <dim>&lt;owner&amp;&quot;&apos;&gt;</dim>');
});

test('fatal window drops events at exactly sixty seconds without mutating history', () => {
  const history = [999, 1000, 1001];
  assert.deepEqual(recordFatal(history, 61000), { timestamps: [1001, 61000], blocked: true });
  assert.deepEqual(history, [999, 1000, 1001]);
  assert.deepEqual(recordFatal([1000], 61000), { timestamps: [61000], blocked: false });
  assert.deepEqual(recordFatal([], 1000), { timestamps: [1000], blocked: false });
});
