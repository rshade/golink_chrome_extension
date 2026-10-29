// Writes the update manifest Chrome polls for a self-hosted extension.
//   node scripts/update-xml.cjs --manifest ext/manifest.json --codebase https://.../x.crx --out update.xml
const fs = require('node:fs');
const {extensionID} = require('./extension-id.cjs');

const escapeAttribute = value => value.replace(/&/g, '&amp;').replace(/'/g, '&apos;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const isChromeVersion = version => /^(0|[1-9]\d{0,4})(\.(0|[1-9]\d{0,4})){0,3}$/.test(version) && version.split('.').every(part => Number(part) <= 65535);

function updateXML({id, version, codebase}) {
  if (!/^[a-p]{32}$/.test(id)) throw new Error('extension ID must be 32 characters from a to p');
  if (!isChromeVersion(version)) throw new Error(`version ${JSON.stringify(version)} is not one to four integers separated by dots`);
  if (!/^https:\/\//.test(codebase)) throw new Error('codebase must be an https URL');
  return `<?xml version='1.0' encoding='UTF-8'?>
<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>
  <app appid='${id}'>
    <updatecheck codebase='${escapeAttribute(codebase)}' version='${version}' />
  </app>
</gupdate>
`;
}

module.exports = {updateXML};

if (require.main === module) {
  const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, i, all) =>
    value.startsWith('--') ? [...pairs, [value.slice(2), all[i + 1]]] : pairs, []));
  for (const name of ['manifest', 'codebase', 'out']) {
    if (!args[name]) { console.error(`missing --${name}`); process.exit(2); }
  }
  try {
    const manifest = JSON.parse(fs.readFileSync(args.manifest, 'utf8'));
    fs.writeFileSync(args.out, updateXML({id: extensionID(manifest.key), version: manifest.version, codebase: args.codebase}));
  } catch (error) {
    console.error(`update-xml: ${error.message}`);
    process.exit(1);
  }
}
