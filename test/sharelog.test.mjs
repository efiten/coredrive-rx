// Debug-log export: capability-based method selection + the mailto fallback.
// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert';
import { pickShareMethod, buildMailto } from '../src/sharelog.js';

test('prefers the Web Share API when files can be shared', () => {
  assert.strictEqual(pickShareMethod({ canShareFiles: true, canDownload: true }), 'share');
});

test('falls back to download when share is unavailable', () => {
  assert.strictEqual(pickShareMethod({ canShareFiles: false, canDownload: true }), 'download');
});

test('last resort is mailto when neither share nor download is possible', () => {
  assert.strictEqual(pickShareMethod({ canShareFiles: false, canDownload: false }), 'mailto');
});

test('mailto encodes subject + body and truncates a long log', () => {
  const url = buildMailto('hello world', 'subj');
  assert.match(url, /^mailto:\?subject=subj&body=hello%20world$/);
  const long = 'x'.repeat(5000);
  assert.ok(buildMailto(long).includes('truncated'));
  assert.ok(decodeURIComponent(buildMailto(long).split('&body=')[1]).length < long.length);
});
