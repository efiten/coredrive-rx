// Contact-path override for region discovery (ANON_REQ_TYPE_REGIONS).
//
// The companion picks flood vs. direct routing itself — sendAnonReq
// (src/helpers/BaseChatMesh.cpp:619) floods only when the target contact's
// out_path_len === OUT_PATH_UNKNOWN (0xFF, src/helpers/ContactInfo.h:6) and
// otherwise sends DIRECT over whatever path is stored (which may be a stale
// multi-hop path learned from earlier flooded traffic, not the zero-hop link the
// node-discover sweep just confirmed). Repeaters answer a regions request only
// over a direct route from that CURRENT zero-hop neighbour (examples/
// simple_repeater/MyMesh.cpp requires packet->isRouteDirect()) and drop anything
// else with no error. Region-discovery targets are, by construction, nodes we
// have just heard zero-hop — so any out_path_len other than 0 (0xFF or a stale
// real path) is wrong for this one ask: force it to zero-hop first, then restore
// the original afterwards.
//
// Frame layout: writeContactRespFrame / updateContactFromFrame
// (examples/companion_radio/MyMesh.cpp:166, 189) use the identical field order,
// so a CMD_GET_CONTACT_BY_KEY reply can be echoed back as a CMD_ADD_UPDATE_CONTACT
// command by rewriting byte 0 (and, for the override, byte 35).
import { bytesToHex, hexToBytes } from './meshpacket.js';
import { prefKey } from './storage.js';

export const CMD_GET_CONTACT_BY_KEY = 30; // examples/companion_radio/MyMesh.cpp:35
export const CMD_ADD_UPDATE_CONTACT = 9;  // examples/companion_radio/MyMesh.cpp:14
export const RESP_CODE_OK = 0;            // examples/companion_radio/MyMesh.cpp:71 — CMD_ADD_UPDATE_CONTACT's success reply
export const RESP_CODE_ERR = 1;           // examples/companion_radio/MyMesh.cpp:72
export const RESP_CODE_CONTACT = 3;       // examples/companion_radio/MyMesh.cpp:74 — CMD_GET_CONTACT_BY_KEY's success reply
export const ERR_CODE_NOT_FOUND = 2;      // examples/companion_radio/MyMesh.cpp:131

// Contact frame (writeContactRespFrame / updateContactFromFrame, MyMesh.cpp:166-212):
// code(1) pub_key(32) type(1) flags(1) out_path_len(1) out_path(64, MAX_PATH_SIZE —
// src/MeshCore.h:22) name(32) last_advert_timestamp(4) gps_lat(4) gps_lon(4) lastmod(4)
// = 148 bytes.
const OUT_PATH_LEN_OFFSET = 35;
export const CONTACT_FRAME_LEN = 148;

export function buildGetContactByKey(pubkeyHex) {
  const pk = pubkeyHex.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(pk)) {
    throw new TypeError(`buildGetContactByKey: pubkeyHex must be exactly 64 hex characters, got: ${pubkeyHex}`);
  }
  const out = new Uint8Array(1 + 32);
  out[0] = CMD_GET_CONTACT_BY_KEY;
  out.set(hexToBytes(pk), 1);
  return out;
}

// parseContactReply reads a CMD_GET_CONTACT_BY_KEY reply. Returns:
//  - { found: true, outPathLen, raw } for RESP_CODE_CONTACT — raw is the full
//    148-byte frame, kept verbatim so it can be echoed back byte-for-byte later.
//  - { found: false } for an ERR_CODE_NOT_FOUND error (not a contact — no dance).
//  - null for anything else: wrong code, an unexpected error code, or a frame too
//    short to be the one it claims to be — rejected outright, never half-parsed.
export function parseContactReply(bytes) {
  if (!bytes || bytes.length < 1) return null;
  if (bytes[0] === RESP_CODE_ERR) {
    return bytes.length >= 2 && bytes[1] === ERR_CODE_NOT_FOUND ? { found: false } : null;
  }
  if (bytes[0] === RESP_CODE_CONTACT && bytes.length >= CONTACT_FRAME_LEN) {
    return { found: true, outPathLen: bytes[OUT_PATH_LEN_OFFSET], raw: bytes.slice(0, CONTACT_FRAME_LEN) };
  }
  return null;
}

// needsPathOverride: true only for a contact we found whose stored routing would
// not send this ask over the zero-hop link we just confirmed (see module comment).
export function needsPathOverride(contact) {
  return !!(contact && contact.found && contact.outPathLen !== 0);
}

// buildOverrideFrame turns a parsed contact's raw reply into a CMD_ADD_UPDATE_CONTACT
// command that forces out_path_len to 0 (zero-hop direct). Every other byte —
// including last_mod — is echoed verbatim: updateContactFromFrame falls back to the
// current time when last_mod is absent, so dropping it would silently rewrite the
// contact's modification time.
export function buildOverrideFrame(raw) {
  const out = Uint8Array.from(raw);
  out[0] = CMD_ADD_UPDATE_CONTACT;
  out[OUT_PATH_LEN_OFFSET] = 0;
  return out;
}

// buildRestoreFrame turns the ORIGINAL raw reply (never the override) into a
// CMD_ADD_UPDATE_CONTACT command that puts the contact back exactly as it was.
export function buildRestoreFrame(raw) {
  const out = Uint8Array.from(raw);
  out[0] = CMD_ADD_UPDATE_CONTACT;
  return out;
}

// --- Crash-safety persistence (localStorage) ---
// If the app dies or the BLE link drops between the override write and the restore
// write, the contact is left zero-hop. encodePendingRestore/decodePendingRestore
// (de)serialize the record app.js persists before every override write and clears
// after every successful restore: the ORIGINAL (unmodified) 148-byte contact frame,
// which companion it belongs to (self pubkey), and which contact it targets — keyed
// so app.js can refuse to replay it against a different companion on connect.
export const RESTORE_STORAGE_KEY = prefKey('contactPathRestore');

export function encodePendingRestore(selfPubkeyHex, targetPubkeyHex, raw) {
  return JSON.stringify({
    self: selfPubkeyHex.trim().toLowerCase(),
    target: targetPubkeyHex.trim().toLowerCase(),
    raw: bytesToHex(raw),
  });
}

// decodePendingRestore returns { self, target, raw } or null for anything that
// isn't a well-formed record — malformed JSON, missing fields, or a raw frame that
// isn't exactly CONTACT_FRAME_LEN bytes once decoded.
export function decodePendingRestore(json) {
  let rec;
  try { rec = JSON.parse(json); } catch (e) { return null; }
  if (!rec || typeof rec.self !== 'string' || typeof rec.target !== 'string' || typeof rec.raw !== 'string') return null;
  const raw = hexToBytes(rec.raw);
  if (raw.length !== CONTACT_FRAME_LEN) return null;
  return { self: rec.self.toLowerCase(), target: rec.target.toLowerCase(), raw };
}
