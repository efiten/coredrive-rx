import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createMsgWait, noteChannelPacket, onMessageWaiting, clearCount, MATCH_WINDOW_MS, SEEN_TTL_MS,
} from '../src/msgwait.js';

test('a message-waiting push with nothing on the ping channel is a real message', () => {
  const s = createMsgWait();
  assert.equal(onMessageWaiting(s, 1000), 'message');
  assert.equal(s.count, 1);
});

test('another client\'s ping swallows the push that follows it', () => {
  const s = createMsgWait();
  noteChannelPacket(s, { hash: 'aa', own: false, now: 1000 });
  assert.equal(onMessageWaiting(s, 1010), 'ping-channel');
  assert.equal(s.count, 0);
});

test('only the first copy of a ping expects a push (firmware wasSeen dedup)', () => {
  const s = createMsgWait();
  noteChannelPacket(s, { hash: 'aa', own: false, now: 1000 });
  noteChannelPacket(s, { hash: 'aa', own: false, now: 1200 }); // re-broadcast by a second repeater
  assert.equal(onMessageWaiting(s, 1210), 'ping-channel');
  assert.equal(onMessageWaiting(s, 1300), 'message');
  assert.equal(s.count, 1);
});

test('echoes of our own ping expect no push (sendFlood marks it seen)', () => {
  const s = createMsgWait();
  noteChannelPacket(s, { hash: 'bb', own: true, now: 1000 });
  assert.equal(onMessageWaiting(s, 1010), 'message');
});

test('an expectation older than the match window no longer swallows a push', () => {
  const s = createMsgWait();
  noteChannelPacket(s, { hash: 'aa', own: false, now: 1000 });
  assert.equal(onMessageWaiting(s, 1000 + MATCH_WINDOW_MS + 1), 'message');
});

test('two different pings swallow two pushes', () => {
  const s = createMsgWait();
  noteChannelPacket(s, { hash: 'aa', own: false, now: 1000 });
  noteChannelPacket(s, { hash: 'cc', own: false, now: 1005 });
  assert.equal(onMessageWaiting(s, 1010), 'ping-channel');
  assert.equal(onMessageWaiting(s, 1011), 'ping-channel');
  assert.equal(onMessageWaiting(s, 1012), 'message');
});

test('a hash is forgotten after the seen TTL and counts as new again', () => {
  const s = createMsgWait();
  noteChannelPacket(s, { hash: 'aa', own: false, now: 1000 });
  onMessageWaiting(s, 1010);
  noteChannelPacket(s, { hash: 'aa', own: false, now: 1000 + SEEN_TTL_MS + 1 });
  assert.equal(onMessageWaiting(s, 1000 + SEEN_TTL_MS + 5), 'ping-channel');
});

test('clearCount resets the visible count only', () => {
  const s = createMsgWait();
  onMessageWaiting(s, 1000);
  onMessageWaiting(s, 1001);
  noteChannelPacket(s, { hash: 'aa', own: false, now: 1002 });
  clearCount(s);
  assert.equal(s.count, 0);
  assert.equal(onMessageWaiting(s, 1003), 'ping-channel');
});
