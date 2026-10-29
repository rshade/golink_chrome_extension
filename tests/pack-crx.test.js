import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { packExtension } = require('../scripts/pack-crx.cjs');
const { extensionID } = require('../scripts/extension-id.cjs');

function fixtureExtension({ version = '1.2.3', declareKey = true } = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const der = publicKey.export({ type: 'spki', format: 'der' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crx-test-'));
  const manifest = { manifest_version: 3, name: 'Fixture', version, ...(declareKey && { key: der.toString('base64') }) };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, 'main.wasm'), Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]));
  fs.writeFileSync(path.join(dir, 'wasm_exec.js'), '// runtime\n');
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'sub', 'page.html'), '<p>hi</p>');
  return { dir, der, privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}

function readFields(buf) {
  const fields = [];
  let i = 0;
  const varint = () => { let n = 0, shift = 0; for (;;) { const b = buf[i++]; n += (b & 0x7f) * 2 ** shift; if (!(b & 0x80)) return n; shift += 7; } };
  while (i < buf.length) {
    const tag = varint();
    assert.equal(tag & 7, 2, 'only length-delimited fields are expected');
    const len = varint();
    fields.push({ field: tag >> 3, bytes: buf.subarray(i, i + len) });
    i += len;
  }
  return fields;
}

function parseCrx(crx) {
  assert.equal(crx.subarray(0, 4).toString('latin1'), 'Cr24');
  const version = crx.readUInt32LE(4);
  const headerSize = crx.readUInt32LE(8);
  const header = crx.subarray(12, 12 + headerSize);
  const archive = crx.subarray(12 + headerSize);
  const fields = readFields(header);
  const proof = readFields(fields.find(f => f.field === 2).bytes);
  return {
    version, archive,
    publicKey: proof.find(f => f.field === 1).bytes,
    signature: proof.find(f => f.field === 2).bytes,
    signedHeaderData: fields.find(f => f.field === 10000).bytes,
  };
}

function zipEntries(zip) {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    const method = zip.readUInt16LE(p + 10);
    const size = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28), extraLen = zip.readUInt16LE(p + 30), commentLen = zip.readUInt16LE(p + 32);
    const offset = zip.readUInt32LE(p + 42);
    const name = zip.subarray(p + 46, p + 46 + nameLen).toString();
    const dataStart = offset + 30 + zip.readUInt16LE(offset + 26) + zip.readUInt16LE(offset + 28);
    const raw = zip.subarray(dataStart, dataStart + size);
    entries.set(name, method === 8 ? zlib.inflateRawSync(raw) : raw);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

test('CRX3 header declares version 3 and the extension ID of the key', () => {
  const { dir, der, privateKeyPem } = fixtureExtension();
  const { crx } = packExtension({ extDir: dir, privateKeyPem, version: '1.2.3' });
  const parsed = parseCrx(crx);
  assert.equal(parsed.version, 3);
  assert.deepEqual(parsed.publicKey, der);
  const crxID = readFields(parsed.signedHeaderData).find(f => f.field === 1).bytes;
  assert.equal(crxID.length, 16);
  assert.deepEqual(crxID, crypto.createHash('sha256').update(der).digest().subarray(0, 16));
});

test('CRX3 signature verifies over the signed data and the archive', () => {
  const { dir, der, privateKeyPem } = fixtureExtension();
  const { crx } = packExtension({ extDir: dir, privateKeyPem, version: '1.2.3' });
  const parsed = parseCrx(crx);
  const length = Buffer.alloc(4);
  length.writeUInt32LE(parsed.signedHeaderData.length);
  const signed = Buffer.concat([Buffer.from('CRX3 SignedData\0', 'latin1'), length, parsed.signedHeaderData, parsed.archive]);
  const ok = crypto.verify('sha256', signed, crypto.createPublicKey({ key: der, format: 'der', type: 'spki' }), parsed.signature);
  assert.ok(ok, 'signature does not verify');
});

test('the archive holds every extension file and a manifest at the release version', () => {
  const { dir, privateKeyPem } = fixtureExtension();
  const { zip, crx } = packExtension({ extDir: dir, privateKeyPem, version: '1.2.3' });
  assert.deepEqual(parseCrx(crx).archive, zip);
  const entries = zipEntries(zip);
  assert.deepEqual([...entries.keys()].sort(), ['main.wasm', 'manifest.json', 'sub/page.html', 'wasm_exec.js']);
  assert.equal(JSON.parse(entries.get('manifest.json')).version, '1.2.3');
  assert.deepEqual(entries.get('main.wasm'), fs.readFileSync(path.join(dir, 'main.wasm')));
});

test('the returned ID matches the one derived from the manifest key', () => {
  const { dir, der, privateKeyPem } = fixtureExtension();
  assert.equal(packExtension({ extDir: dir, privateKeyPem, version: '1.2.3' }).id, extensionID(der.toString('base64')));
});

test('packing refuses a manifest version that is not the release version', () => {
  const { dir, privateKeyPem } = fixtureExtension({ version: '1.2.3' });
  assert.throws(() => packExtension({ extDir: dir, privateKeyPem, version: '1.2.4' }), /version/);
});

test('packing refuses a private key that does not match the manifest key', () => {
  const { dir } = fixtureExtension();
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  assert.throws(() => packExtension({ extDir: dir, privateKeyPem: other, version: '1.2.3' }), /does not match/);
});

test('packing refuses a manifest with no key', () => {
  const { dir, privateKeyPem } = fixtureExtension({ declareKey: false });
  assert.throws(() => packExtension({ extDir: dir, privateKeyPem, version: '1.2.3' }), /key/);
});

test('errors never contain the private key', () => {
  const { dir } = fixtureExtension();
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  try { packExtension({ extDir: dir, privateKeyPem: other, version: '1.2.3' }); assert.fail('expected an error'); }
  catch (error) { assert.ok(!error.message.includes('PRIVATE KEY'), error.message); }
});

test('packing refuses an extension directory that was not built', () => {
  for (const missing of ['main.wasm', 'wasm_exec.js']) {
    const { dir, privateKeyPem } = fixtureExtension();
    fs.rmSync(path.join(dir, missing));
    assert.throws(() => packExtension({ extDir: dir, privateKeyPem, version: '1.2.3' }), new RegExp(`${missing.replace('.', '\\.')}.*build`));
  }
});
