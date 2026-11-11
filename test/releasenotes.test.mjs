// The release-notes rule (AGENTS.md) was broken on nine tags in a row before anyone
// noticed, because it lived only in a human's memory. These tests cover what the
// automated builder must still get right: refuse a tag without notes, and publish only
// that tag's own notes so the assets below the body stay within reach.
// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert';
import { assembleBody, RELEASES_URL } from '../scripts/release-notes.mjs';

const E = (tag, text) => ({ tag, text });

test('a body carries only the named release, never an older or newer one', () => {
  const body = assembleBody([E('v1.0.0', 'zero'), E('v1.1.0', 'one'), E('v1.2.0', 'two')], 'v1.1.0');
  assert.ok(body.startsWith('one\n'));
  assert.ok(!body.includes('zero') && !body.includes('two'));
});

test('a body ends with a link to the earlier releases', () => {
  const body = assembleBody([E('v1.0.0', '# CoreDrive RX v1.0.0\n\nfirst\n')], 'v1.0.0');
  assert.strictEqual(body, '# CoreDrive RX v1.0.0\n\nfirst\n\n---\n\nEarlier releases: ' + RELEASES_URL + '\n');
});

test('a tag with no notes file is refused, which is what fails the release job', () => {
  assert.throws(() => assembleBody([E('v1.0.0', 'zero')], 'v1.1.0'), /v1\.1\.0/);
});
