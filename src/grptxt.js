// Group-channel crypto for the uplink ping: just enough to recognise our own channel
// message when a repeater re-broadcasts it, and to name it by the same packet hash
// CoreScope stores. Layouts verified against meshcore-firmware:
//
//   channel key   SHA-256("#name")[0..16] for a hashtag channel (CoreScope
//                 cmd/ingestor/main.go derives it the same way)
//   channel hash  SHA-256(key)[0]           (helpers/BaseChatMesh.cpp:908)
//   GRP_TXT       [channel hash 1][MAC 2][ciphertext]   (Mesh.cpp:540-557)
//   MAC           HMAC-SHA256 over the ciphertext, keyed with the 32-byte secret
//                 (key + 16 zero bytes), first 2 bytes   (Utils.cpp:127-145)
//   ciphertext    AES-128-ECB, zero-padded to the block  (Utils.cpp encrypt)
//   plaintext     timestamp u32 LE, flags 1, "<node name>: <text>", NUL padding
//                 (helpers/BaseChatMesh.cpp:487-506)
//   packet hash   SHA-256(payload_type byte + payload)[0..8]; route, transport codes
//                 and path are not hashed, so every re-broadcast hashes the same
//                 (Packet.cpp:41-50; CoreScope ComputeContentHash matches it)
//
// The browser's WebCrypto has no AES-ECB, so that one step uses @noble/ciphers.
import { ecb } from '@noble/ciphers/aes.js';

const PAYLOAD_TYPE_GRP_TXT = 5;
const MAC_SIZE = 2;

async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

function hex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// channelKey derives the 16-byte key of a hashtag channel. The name is used exactly
// as given, '#' included, as MeshCore apps and CoreScope do.
export async function channelKey(name) {
  return (await sha256(new TextEncoder().encode(name))).slice(0, 16);
}

export async function channelHash(key) {
  return (await sha256(key))[0];
}

// packetHash is the 16-hex-character id CoreScope files a transmission under.
export async function packetHash(payloadType, payload) {
  const buf = new Uint8Array(1 + payload.length);
  buf[0] = payloadType;
  buf.set(payload, 1);
  return hex((await sha256(buf)).slice(0, 8));
}

// decryptGroupText opens one GRP_TXT payload with `key`. Returns
// { timestamp, text } or null when the channel hash or MAC does not match, which is
// the normal outcome for every other channel's traffic.
export async function decryptGroupText(payload, key, hashByte) {
  if (!payload || payload.length < 1 + MAC_SIZE + 16 || payload[0] !== hashByte) return null;
  const mac = payload.slice(1, 1 + MAC_SIZE);
  const ct = payload.slice(1 + MAC_SIZE);
  if (ct.length % 16 !== 0) return null;
  const secret = new Uint8Array(32);
  secret.set(key);
  const hk = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', hk, ct));
  if (sig[0] !== mac[0] || sig[1] !== mac[1]) return null;
  const plain = ecb(key, { disablePadding: true }).decrypt(ct);
  if (plain.length < 5) return null;
  const ts = plain[0] | (plain[1] << 8) | (plain[2] << 16) | (plain[3] << 24);
  let end = plain.length;
  while (end > 5 && plain[end - 1] === 0) end--;
  const text = new TextDecoder().decode(plain.slice(5, end));
  return { timestamp: ts >>> 0, text };
}

export { PAYLOAD_TYPE_GRP_TXT };
