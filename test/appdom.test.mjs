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

// app.js is never imported by a test (it calls els()/document at module scope,
// which needs a real DOM) — so its own state-management invariants can only be
// checked against its source, the same way the DOM-free check above does.
//
// functionBody isolates one top-level function's text: from its declaration to
// the next top-level function/async-function declaration (or EOF), which is
// enough to keep a match from spilling into a sibling function without needing
// a real parser.
function functionBody(src, name) {
  const start = src.indexOf(name);
  assert.notStrictEqual(start, -1, `${name} must exist in src/app.js`);
  const boundary = /\n(?:async )?function /g;
  boundary.lastIndex = start + name.length;
  const m = boundary.exec(src);
  return src.slice(start, m ? m.index : src.length);
}

// A stale state.gpsErrorKind is exactly the bug state.fwVer/state.batteryMv's
// own disconnectAll resets (and state.splashBleError's own connectAll reset)
// already exist to avoid: a disconnect must not leave the Heard status line
// and the splash gate reporting an error for a watch that no longer runs, and
// a fresh connect attempt must not let a stale 'denied' survive into a session
// whose new watchPosition has not reported anything yet.
test('disconnectAll and connectAll both clear a stale gpsErrorKind, like their sibling staleness resets', () => {
  const src = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  assert.match(functionBody(src, 'async function disconnectAll'), /state\.gpsErrorKind\s*=\s*null/);
  assert.match(functionBody(src, 'async function connectAll'), /state\.gpsErrorKind\s*=\s*null/);
});
