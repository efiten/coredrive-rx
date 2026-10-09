// The "CoreScope account" card's states, as pure text (src/accountview.js).
// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert';
import { accountView } from '../src/accountview.js';

const PK = 'ab'.repeat(32);
const OTHER = 'cd'.repeat(32);
const base = {
  enabled: true, loggedIn: true, displayName: 'Erwin',
  companions: [{ pubkey: PK, name: 'Car' }, { pubkey: OTHER, name: '' }],
  connectedPubkey: PK, link: { pubkey: PK, name: 'Car', status: 'idle', reason: '' },
  holding: false, pending: 0,
};

test('hidden while the feature is off and nothing is held', () => {
  assert.strictEqual(accountView({ ...base, enabled: false }).visible, false);
});

test('shown while held even if discovery failed — a held queue must never be unexplained', () => {
  const v = accountView({ ...base, enabled: false, loggedIn: false, holding: true, pending: 5 });
  assert.strictEqual(v.visible, true);
  assert.strictEqual(v.mode, 'out');
});

test('logged out shows the form and no list', () => {
  const v = accountView({ ...base, loggedIn: false });
  assert.strictEqual(v.mode, 'out');
  assert.strictEqual(v.who, '');
  assert.deepStrictEqual(v.rows, []);
});

test('logged in names the user and marks the connected companion with ●', () => {
  const v = accountView(base);
  assert.strictEqual(v.mode, 'in');
  assert.strictEqual(v.who, 'Logged in as Erwin');
  assert.deepStrictEqual(v.rows.map((r) => r.label), ['● Car', 'cdcdcdcdcdcd…']);
  assert.deepStrictEqual(v.rows.map((r) => r.connected), [true, false]);
});

test('each link state has its own line; only Failed offers Retry', () => {
  const line = (status, reason = '') => accountView({ ...base, link: { pubkey: PK, name: 'Car', status, reason } });
  assert.strictEqual(line('linked').linkText, '✓ Car linked');
  assert.strictEqual(line('working').linkText, 'Linking Car…');
  assert.strictEqual(line('waiting').linkText, 'Linking Car… (waiting for the network)');
  assert.strictEqual(line('unsupported').linkText, "This companion's firmware cannot sign; update it to link.");
  assert.strictEqual(line('failed', 'bad signature').linkText, 'Linking failed: bad signature');
  assert.strictEqual(line('failed', 'x').showRetry, true);
  for (const s of ['linked', 'working', 'waiting', 'unsupported', 'idle']) assert.strictEqual(line(s).showRetry, false, s);
});

test('no companion connected: the list only, no link line', () => {
  const v = accountView({ ...base, connectedPubkey: '' });
  assert.strictEqual(v.linkText, '');
  assert.ok(v.rows.every((r) => !r.connected));
});

test('a link state left over from another companion is not shown', () => {
  const v = accountView({ ...base, connectedPubkey: OTHER, link: { pubkey: PK, name: 'Car', status: 'failed', reason: 'x' } });
  assert.strictEqual(v.linkText, '');
  assert.strictEqual(v.showRetry, false);
});

test('held and logged out: "Log in to contribute your data – N waiting"', () => {
  const v = accountView({ ...base, loggedIn: false, holding: true, pending: 12 });
  assert.strictEqual(v.holdText, 'Log in to contribute your data – 12 waiting');
});

test('held while linking: "Linking <name>… – N waiting" replaces the plain link line', () => {
  const v = accountView({ ...base, holding: true, pending: 3, link: { pubkey: PK, name: 'Car', status: 'working', reason: '' } });
  assert.strictEqual(v.holdText, 'Linking Car… – 3 waiting');
  assert.strictEqual(v.linkText, '');
});

test('held after a definite failure keeps the reason and says the data waits', () => {
  const v = accountView({ ...base, holding: true, pending: 3, link: { pubkey: PK, name: 'Car', status: 'failed', reason: 'bad signature' } });
  assert.strictEqual(v.linkText, 'Linking failed: bad signature');
  assert.strictEqual(v.holdText, 'Not linked – 3 waiting');
});

test('not held: no hold line', () => {
  assert.strictEqual(accountView(base).holdText, '');
});
