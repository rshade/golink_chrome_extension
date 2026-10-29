// Packs ext/ into a signed CRX3 and a plain zip, using only node:crypto and zlib.
//   node scripts/pack-crx.cjs --ext ext --key key.pem --version 0.2.0 --crx out.crx --zip out.zip
// The key is read from a file and never printed.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const {extensionID} = require('./extension-id.cjs');

const varint = n => {
  const out = [];
  while (n > 0x7f) { out.push((n % 128) | 0x80); n = Math.floor(n / 128); }
  out.push(n);
  return Buffer.from(out);
};
const field = (number, bytes) => Buffer.concat([varint(number * 8 + 2), varint(bytes.length), bytes]);
const uint32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };

function listFiles(root, dir = root) {
  return fs.readdirSync(dir, {withFileTypes: true}).flatMap(entry => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? listFiles(root, full) : [path.relative(root, full).split(path.sep).join('/')];
  });
}

// Fixed timestamps and sorted names keep the archive identical for identical input.
function buildZip(files) {
  const DOS_TIME = 0, DOS_DATE = (1 << 5) | 1;
  const locals = [], central = [];
  let offset = 0;
  for (const [name, data] of files) {
    const nameBytes = Buffer.from(name, 'utf8');
    const compressed = zlib.deflateRawSync(data, {level: 9});
    const crc = zlib.crc32(data);
    const local = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from([20, 0, 0x00, 0x08, 8, 0]),
      Buffer.from([DOS_TIME & 255, DOS_TIME >> 8, DOS_DATE & 255, DOS_DATE >> 8]),
      uint32(crc), uint32(compressed.length), uint32(data.length),
      Buffer.from([nameBytes.length & 255, nameBytes.length >> 8, 0, 0]), nameBytes, compressed,
    ]);
    central.push(Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x01, 0x02]), Buffer.from([20, 3, 20, 0, 0x00, 0x08, 8, 0]),
      Buffer.from([DOS_TIME & 255, DOS_TIME >> 8, DOS_DATE & 255, DOS_DATE >> 8]),
      uint32(crc), uint32(compressed.length), uint32(data.length),
      Buffer.from([nameBytes.length & 255, nameBytes.length >> 8, 0, 0, 0, 0, 0, 0, 0, 0]),
      uint32((0o100644 << 16) >>> 0), uint32(offset), nameBytes,
    ]));
    locals.push(local);
    offset += local.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0]),
    Buffer.from([files.length & 255, files.length >> 8, files.length & 255, files.length >> 8]),
    uint32(centralBytes.length), uint32(offset), Buffer.from([0, 0]),
  ]);
  return Buffer.concat([...locals, centralBytes, end]);
}

function packExtension({extDir, privateKeyPem, version}) {
  const manifest = JSON.parse(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8'));
  if (manifest.version !== version) {
    throw new Error(`manifest version ${manifest.version} is not the release version ${version}`);
  }
  if (!manifest.key) throw new Error('manifest has no key');
  const id = extensionID(manifest.key);
  const publicDER = Buffer.from(manifest.key, 'base64');

  let privateKey;
  try { privateKey = crypto.createPrivateKey(privateKeyPem); } catch { throw new Error('private key could not be read'); }
  const derivedDER = crypto.createPublicKey(privateKey).export({type: 'spki', format: 'der'});
  if (!derivedDER.equals(publicDER)) throw new Error('private key does not match the manifest key');

  const present = new Set(listFiles(extDir));
  for (const built of ['main.wasm', 'wasm_exec.js']) {
    if (!present.has(built)) throw new Error(`${built} is missing from ${extDir}; run ./build.sh first`);
  }
  const files = [...present].sort().map(name => [name, fs.readFileSync(path.join(extDir, name))]);
  const zip = buildZip(files);

  const signedHeaderData = field(1, crypto.createHash('sha256').update(publicDER).digest().subarray(0, 16));
  const signed = Buffer.concat([Buffer.from('CRX3 SignedData\0', 'latin1'), uint32(signedHeaderData.length), signedHeaderData, zip]);
  const signature = crypto.sign('sha256', signed, privateKey);
  const header = Buffer.concat([
    field(2, Buffer.concat([field(1, publicDER), field(2, signature)])),
    field(10000, signedHeaderData),
  ]);
  const crx = Buffer.concat([Buffer.from('Cr24', 'latin1'), uint32(3), uint32(header.length), header, zip]);
  return {crx, zip, id, files: files.map(([name]) => name)};
}

module.exports = {packExtension, buildZip};

if (require.main === module) {
  const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, i, all) =>
    value.startsWith('--') ? [...pairs, [value.slice(2), all[i + 1]]] : pairs, []));
  for (const name of ['ext', 'key', 'version', 'crx', 'zip']) {
    if (!args[name]) { console.error(`missing --${name}`); process.exit(2); }
  }
  try {
    const result = packExtension({extDir: args.ext, privateKeyPem: fs.readFileSync(args.key), version: args.version});
    fs.writeFileSync(args.crx, result.crx);
    fs.writeFileSync(args.zip, result.zip);
    console.log(result.id);
  } catch (error) {
    console.error(`pack-crx: ${error.message}`);
    process.exit(1);
  }
}
