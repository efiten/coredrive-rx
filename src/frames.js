// Companion BLE frame parsing. Each TX-characteristic notification carries one
// complete frame (firmware SerialBLEInterface sends setValue+notify per frame,
// MAX_FRAME_SIZE=176; no length prefix / no reassembly needed).

export const PUSH_CODE_LOG_RX_DATA = 0x88; // [0x88][snr×4 int8][rssi int8][raw packet...]

function int8(b) { return b < 128 ? b : b - 256; }

// parseFrame takes a DataView (one notification) and returns a typed object.
// For 0x88 (our coverage source): { code, snr, rssi, raw: Uint8Array }.
// Other frame codes return { code, data } for the caller to handle/ignore.
export function parseFrame(dv) {
  if (!dv || dv.byteLength < 1) return null;
  const bytes = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
  const code = bytes[0];
  if (code === PUSH_CODE_LOG_RX_DATA) {
    if (bytes.length < 3) return null;
    return {
      code,
      snr: int8(bytes[1]) / 4.0,
      rssi: int8(bytes[2]),
      raw: bytes.slice(3),
    };
  }
  return { code, data: bytes.slice(1) };
}
