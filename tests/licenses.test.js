import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = path.resolve(import.meta.dirname, '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'licenses-test-'));

function compiledModules() {
  const list = spawnSync('go', ['list', '-deps', '-f', '{{with .Module}}{{.Path}}{{end}}', './wasm'], {
    cwd: repo, encoding: 'utf8', env: { ...process.env, GOOS: 'js', GOARCH: 'wasm' },
  });
  assert.equal(list.status, 0, list.stderr);
  return [...new Set(list.stdout.split('\n').filter(Boolean))].filter(name => name !== 'golink-chrome-extension');
}

test('the generated notices keep the existing notice and name every compiled-in module', () => {
  const out = path.join(tmp(), 'NOTICES.md');
  const run = spawnSync('scripts/licenses.sh', [out], { cwd: repo, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const notices = fs.readFileSync(out, 'utf8');
  assert.ok(notices.startsWith(fs.readFileSync(path.join(repo, 'THIRD_PARTY_NOTICES.md'), 'utf8')));
  const modules = compiledModules();
  assert.ok(modules.includes('tailscale.com'), 'tailscale.com should be compiled in');
  for (const name of modules) assert.ok(notices.includes(`## ${name} `), `${name} is missing from the notices`);
});

test('each module section carries license text', () => {
  const out = path.join(tmp(), 'NOTICES.md');
  assert.equal(spawnSync('scripts/licenses.sh', [out], { cwd: repo }).status, 0);
  const sections = fs.readFileSync(out, 'utf8').split(/^## /m).slice(1).filter(s => /^[^\n]+ v/.test(s));
  assert.ok(sections.length >= 20);
  for (const section of sections) {
    assert.match(section, /(permission|redistribut|licen[sc]e)/i, section.split('\n')[0]);
  }
});

test('the script fails when a module has no license file', () => {
  const dir = tmp();
  const list = path.join(dir, 'modules.txt');
  fs.writeFileSync(list, `example.com/nolicense v1.0.0 ${dir}\n`);
  const run = spawnSync('scripts/licenses.sh', [path.join(dir, 'out.md')], {
    cwd: repo, encoding: 'utf8', env: { ...process.env, MODULE_LIST_FILE: list },
  });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /example\.com\/nolicense/);
});
