import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = path.resolve(import.meta.dirname, '..');

function packFixture() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-test-'));
  const ext = path.join(dir, 'ext');
  fs.mkdirSync(ext);
  fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify({
    manifest_version: 3, name: 'Fixture', version: '2.4.6',
    key: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  }));
  fs.writeFileSync(path.join(ext, 'main.wasm'), Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]));
  fs.writeFileSync(path.join(ext, 'wasm_exec.js'), '// runtime\n');
  const keyFile = path.join(dir, 'key.pem');
  fs.writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const out = path.join(dir, 'out');
  const run = spawnSync('scripts/package-release.sh', [], {
    cwd: repo, encoding: 'utf8',
    env: { ...process.env, EXT_DIR: ext, OUT_DIR: out, RELEASE_KEY_FILE: keyFile },
  });
  return { run, out, keyFile };
}

test('a release directory holds the CRX, update XML, zip, notices, and checksums', () => {
  const { run, out } = packFixture();
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(fs.readdirSync(out).sort(),
    ['SHA256SUMS', 'THIRD_PARTY_NOTICES.md', 'golink-ext-2.4.6.crx', 'golink-ext-2.4.6.zip', 'update.xml']);
});

test('SHA256SUMS lists every other asset and each digest is correct', () => {
  const { out } = packFixture();
  const lines = fs.readFileSync(path.join(out, 'SHA256SUMS'), 'utf8').trim().split('\n');
  const listed = lines.map(line => line.split(/\s+/)[1].replace(/^\*/, ''));
  assert.deepEqual(listed.sort(), fs.readdirSync(out).filter(name => name !== 'SHA256SUMS').sort());
  for (const line of lines) {
    const [digest, rawName] = line.split(/\s+/);
    const name = rawName.replace(/^\*/, '');
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(out, name))).digest('hex'), digest, name);
  }
});

test('update.xml points at the release tag download of the CRX with the packed version', () => {
  const { out } = packFixture();
  const xml = fs.readFileSync(path.join(out, 'update.xml'), 'utf8');
  assert.ok(xml.includes("codebase='https://github.com/rshade/golink_chrome_extension/releases/download/v2.4.6/golink-ext-2.4.6.crx'"), xml);
  assert.ok(xml.includes("version='2.4.6'"), xml);
});

test('nothing in the output or the script log contains the private key', () => {
  const { run, out, keyFile } = packFixture();
  const pem = fs.readFileSync(keyFile, 'utf8');
  const body = pem.split('\n').filter(line => line && !line.startsWith('-----')).join('');
  assert.ok(!run.stdout.includes(body) && !run.stderr.includes(body));
  for (const name of fs.readdirSync(out)) {
    assert.ok(!fs.readFileSync(path.join(out, name)).includes(Buffer.from(body)), name);
  }
});

test('the shipped notices include the license of every compiled-in module', () => {
  const { out } = packFixture();
  const notices = fs.readFileSync(path.join(out, 'THIRD_PARTY_NOTICES.md'), 'utf8');
  assert.ok(notices.includes('## tailscale.com '), 'tailscale.com license missing from the release notices');
});
