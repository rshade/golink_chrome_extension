import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { isPrivateEtcOpt } = createRequire(import.meta.url)('../scripts/private-etc.cjs');

const host = [
  '24 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw',
  '30 24 0:26 / /proc rw,nosuid shared:5 - proc proc rw',
].join('\n');

test('a host with no mount at /etc/opt is not private', () => {
  assert.equal(isPrivateEtcOpt(host), false);
});

test('a tmpfs mounted at /etc/opt is private', () => {
  assert.equal(isPrivateEtcOpt(`${host}\n91 24 0:55 / /etc/opt rw,relatime - tmpfs tmpfs rw`), true);
});

test('a bind mount of a disk at /etc/opt is not private', () => {
  assert.equal(isPrivateEtcOpt(`${host}\n91 24 8:1 /opt /etc/opt rw,relatime - ext4 /dev/sda1 rw`), false);
});

test('a tmpfs elsewhere does not count', () => {
  assert.equal(isPrivateEtcOpt(`${host}\n91 24 0:55 / /etc/optional rw - tmpfs tmpfs rw\n92 24 0:56 / /tmp rw - tmpfs tmpfs rw`), false);
});

test('the topmost mount at /etc/opt decides', () => {
  const stacked = `${host}\n91 24 0:55 / /etc/opt rw - tmpfs tmpfs rw\n92 24 8:1 /opt /etc/opt rw - ext4 /dev/sda1 rw`;
  assert.equal(isPrivateEtcOpt(stacked), false);
});
