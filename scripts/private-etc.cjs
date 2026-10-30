const fs = require('node:fs');

function isPrivateEtcOpt(mountinfo) {
  let fstype;
  for (const line of mountinfo.split('\n')) {
    const [head, tail] = line.split(' - ');
    if (tail !== undefined && head.split(' ')[4] === '/etc/opt') fstype = tail.split(' ')[0];
  }
  return fstype === 'tmpfs';
}

function assertPrivateEtcOpt() {
  if (!isPrivateEtcOpt(fs.readFileSync('/proc/self/mountinfo', 'utf8'))) {
    throw new Error('installed mode writes a browser policy file; run it through scripts/check-release.sh, which gives it a private /etc/opt');
  }
}

module.exports = {isPrivateEtcOpt, assertPrivateEtcOpt};
