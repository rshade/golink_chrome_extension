// Chrome derives an extension ID from its public key: the first 16 bytes of the
// SHA-256 of the DER-encoded key, written as hex with 0-9a-f mapped to a-p.
//   node scripts/extension-id.cjs ext/manifest.json
const crypto = require('node:crypto');
const fs = require('node:fs');

function extensionID(base64Key) {
  let der;
  try {
    der = Buffer.from(base64Key, 'base64');
    crypto.createPublicKey({key: der, format: 'der', type: 'spki'});
  } catch {
    throw new Error('manifest key is not a base64 DER public key');
  }
  const hex = crypto.createHash('sha256').update(der).digest('hex').slice(0, 32);
  return [...hex].map(digit => String.fromCharCode('a'.charCodeAt(0) + parseInt(digit, 16))).join('');
}

module.exports = {extensionID};

if (require.main === module) {
  const {key} = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  if (!key) { console.error('manifest has no key'); process.exit(1); }
  console.log(extensionID(key));
}
