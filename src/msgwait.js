// "A message is waiting on the companion": which PUSH_CODE_MSG_WAITING (0x83) pushes
// are worth telling the user about. The push is one byte with no type or sender, so
// the uplink-ping channel's traffic cannot be told apart by looking at the push.
// It can be told apart by what came just before it. Firmware facts this relies on
// (meshcore-firmware):
//
//   - every received packet is logged as 0x88 BEFORE it is processed
//     (Dispatcher.cpp:199), so the 0x88 of a channel message precedes its 0x83
//   - a GRP_TXT is decrypted and queued only the first time its hash is seen
//     (Mesh.cpp:233 wasSeen/markSeen), so re-broadcasts give no further 0x83
//   - our own flood is marked seen when sent (Mesh.cpp:651), so echoes of our
//     own ping give no 0x83 at all
//   - every queued channel message sends one 0x83 (companion_radio/MyMesh.cpp:570-575)
//
// So each FIRST copy of someone else's ping-channel message expects exactly one 0x83,
// and that push is swallowed. Nothing here fetches messages: CMD_SYNC_NEXT_MESSAGE
// would take them out of the companion's queue and the MeshCore app would never see
// them. No DOM, no crypto: app.js decrypts and passes the result in.

// The 0x83 is written in the same firmware call as the 0x88 before it, so a match
// arrives within milliseconds. The window only has to cover BLE and JS scheduling,
// and kept short so a missed expectation cannot swallow a real message for long.
export const MATCH_WINDOW_MS = 2000;
// How long a hash is remembered as seen. Re-broadcasts of one flood arrive within
// seconds; this only has to outlast them.
export const SEEN_TTL_MS = 10 * 60000;

export function createMsgWait() {
  return { seen: new Map(), expect: [], count: 0 };
}

// noteChannelPacket records one ping-channel GRP_TXT from the RX log.
export function noteChannelPacket(s, { hash, own, now }) {
  for (const [h, at] of s.seen) if (now - at > SEEN_TTL_MS) s.seen.delete(h);
  if (s.seen.has(hash)) return;
  s.seen.set(hash, now);
  if (!own) s.expect.push(now);
}

// onMessageWaiting classifies one 0x83: 'ping-channel' when it belongs to a
// ping-channel message noted just before it, 'message' otherwise (counted).
export function onMessageWaiting(s, now) {
  while (s.expect.length && now - s.expect[0] > MATCH_WINDOW_MS) s.expect.shift();
  if (s.expect.length) { s.expect.shift(); return 'ping-channel'; }
  s.count += 1;
  return 'message';
}

export function clearCount(s) {
  s.count = 0;
}
