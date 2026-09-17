// test/appdom.test.mjs
// app.js is the orchestrator: it wires state to the renderers in src/ui and
// builds no DOM of its own. A new file rather than a case appended to
// test/pipeline.test.mjs, so "no existing test file was edited" stays checkable
// with `git diff --stat origin/master -- test/` (controller ruling).
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

test('app.js builds no DOM itself: every element write goes through src/ui', () => {
  const src = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /\.innerHTML\s*=/, 'innerHTML belongs in src/ui/*');
  assert.doesNotMatch(src, /document\.createElement/, 'element building belongs in src/ui/*');
});
