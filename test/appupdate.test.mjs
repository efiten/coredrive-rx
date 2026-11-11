// The Android app says when a newer version exists: Google Play decides for a Play
// install, the deployment's version.json for any other install.
// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert';
import { cmpVersion, updateNotice, parseVersionJson, PLAY_UPDATE_AVAILABLE } from '../src/appupdate.js';

test('versions compare per number, not as text', () => {
  assert.ok(cmpVersion('1.25.0', '1.24.5') > 0);
  assert.ok(cmpVersion('1.10.0', '1.9.9') > 0);
  assert.equal(cmpVersion('1.25.0', '1.25.0'), 0);
  assert.ok(cmpVersion('1.24.5', '1.25.0') < 0);
  assert.equal(cmpVersion('dev', '1.25.0'), 0);
  assert.equal(cmpVersion(null, '1.25.0'), 0);
});

test('a Play install follows Play, also when Play has nothing yet', () => {
  assert.equal(updateNotice({ appVersion: '1.25.0', play: { updateAvailability: PLAY_UPDATE_AVAILABLE }, deployVersion: null }).kind, 'play');
  // the deployment is newer, but Play has not rolled it out to this user: no notice
  assert.equal(updateNotice({ appVersion: '1.25.0', play: { updateAvailability: 1 }, deployVersion: '1.26.0' }), null);
});

test('any other install compares with the deployment', () => {
  const n = updateNotice({ appVersion: '1.25.0', play: null, deployVersion: '1.26.0' });
  assert.equal(n.kind, 'info');
  assert.match(n.text, /1\.26\.0 is out, you have 1\.25\.0/);
  assert.equal(updateNotice({ appVersion: '1.25.0', play: null, deployVersion: '1.25.0' }), null);
  assert.equal(updateNotice({ appVersion: '1.25.0', play: null, deployVersion: '1.24.5' }), null); // older deployment
  assert.equal(updateNotice({ appVersion: '1.25.0', play: null, deployVersion: null }), null);
});

test('version.json is read strictly', () => {
  assert.equal(parseVersionJson('{"version":"1.25.0"}'), '1.25.0');
  assert.equal(parseVersionJson('{"version":"dev"}'), null);
  assert.equal(parseVersionJson('<html>404</html>'), null);
});
