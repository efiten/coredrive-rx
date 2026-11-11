// The cumulative release-notes rule (AGENTS.md) was broken on nine tags in a row before
// anyone noticed, because it lived only in a human's memory. These tests cover the two
// ways an automated assembler can still get it wrong: ordering versions as strings, and
// publishing a tag that has no notes at all. Older releases are folded into <details> so
// the assets below the body stay within reach.
// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert';
import { compareTags, assembleBody, foldEntry } from '../scripts/release-notes.mjs';

const E = (tag, text) => ({ tag, text });

test('versions sort by number, so v1.10.0 is newer than v1.9.1', () => {
  const sorted = ['v1.9.1', 'v1.10.0', 'v1.2.0', 'v1.11.3'].sort(compareTags);
  assert.deepStrictEqual(sorted, ['v1.11.3', 'v1.10.0', 'v1.9.1', 'v1.2.0']);
});

test('a body carries the named release and every older one, newest first', () => {
  const body = assembleBody([E('v1.0.0', 'zero'), E('v1.2.0', 'two'), E('v1.1.0', 'one')], 'v1.2.0');
  assert.match(body, /^two/);
  assert.ok(body.indexOf('two') < body.indexOf('one'));
  assert.ok(body.indexOf('one') < body.indexOf('zero'));
});

test('a body never carries a release newer than the one being published', () => {
  const body = assembleBody([E('v1.0.0', 'zero'), E('v1.1.0', 'one'), E('v1.2.0', 'two')], 'v1.1.0');
  assert.ok(!body.includes('two'));
  assert.ok(body.includes('one') && body.includes('zero'));
});

test('the named release is in full, older ones are folded under Earlier releases', () => {
  const body = assembleBody([E('v1.0.0', 'zero'), E('v1.1.0', 'one')], 'v1.1.0');
  assert.match(body, /^one\n+---\n+## Earlier releases\n+<details>/);
  assert.ok(!body.slice(0, body.indexOf('---')).includes('<details>'));
});

test('a single release gets no Earlier releases section', () => {
  const body = assembleBody([E('v1.0.0', '# CoreDrive RX v1.0.0\n\nfirst')], 'v1.0.0');
  assert.strictEqual(body, '# CoreDrive RX v1.0.0\n\nfirst\n');
});

test('a folded release keeps its whole text, drops its heading and names itself in the summary', () => {
  const text = '# CoreDrive RX v1.2.0\n\nAdds `region` **asks** & <more>.\n\n## What\'s new\n\n- item';
  const out = foldEntry(E('v1.2.0', text));
  assert.match(out, /^<details>\n<summary><b>v1\.2\.0<\/b>: Adds region asks &amp; &lt;more&gt;\.<\/summary>\n\n/);
  assert.ok(out.includes("## What's new\n\n- item"));
  assert.ok(!out.includes('# CoreDrive RX v1.2.0'));
  assert.match(out, /\n\n<\/details>$/);
});

test('a folded summary keeps only the first sentence of a long paragraph', () => {
  const out = foldEntry(E('v1.13.0', '# CoreDrive RX v1.13.0\n\nOne ask per minute, one answer.\nThe cause was not v1.2 radio. Two defects were.'));
  assert.match(out, /<summary><b>v1\.13\.0<\/b>: One ask per minute, one answer\.<\/summary>/);
  assert.ok(out.includes('Two defects were.'));
});

test('a folded release without a summary line shows only its tag', () => {
  assert.match(foldEntry(E('v1.0.1', '# CoreDrive RX v1.0.1\n\n- fix')), /<summary><b>v1\.0\.1<\/b><\/summary>/);
});

test('a tag with no notes file is refused, which is what fails the release job', () => {
  assert.throws(() => assembleBody([E('v1.0.0', 'zero')], 'v1.1.0'), /v1\.1\.0/);
});
