// BLE transport behind an interface so a future iOS Capacitor build only swaps
// this class (a CapacitorBleTransport with the same connect()/onFrame API).
// WebBluetoothTransport works on Android Chrome (Web Bluetooth).

// MeshCore companion uses the Nordic UART Service (NUS).
const NUS_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const NUS_WRITE = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'; // app → firmware (commands)
const NUS_NOTIFY = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; // firmware → app (frames)

export class WebBluetoothTransport {
  constructor() {
    this.device = null;
    this.writeChar = null;
    this._listeners = [];
    this._onStatus = null;
    this._intentional = false; // true = user disconnected, don't auto-reconnect
    this._writeChain = Promise.resolve(); // serialises GATT writes, see send()
  }

  // onFrame(cb): register a listener; cb receives a DataView per incoming frame.
  onFrame(cb) { this._listeners.push(cb); }
  offFrame(cb) { this._listeners = this._listeners.filter((f) => f !== cb); }

  // onStatus(cb): cb('connected'|'reconnecting'|'lost') for UI feedback.
  onStatus(cb) { this._onStatus = cb; }
  _status(s) { if (this._onStatus) this._onStatus(s); }

  async connect() {
    if (!navigator.bluetooth) throw new Error('Web Bluetooth not available (use Android Chrome)');
    this._intentional = false;
    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [NUS_SERVICE] }],
      optionalServices: [NUS_SERVICE],
    });
    // Auto-reconnect when the link drops in the field (walking out of range, etc.).
    this.device.addEventListener('gattserverdisconnected', () => this._onDisconnected());
    await this._setup();
    return true;
  }

  // connected() reports whether the GATT link is actually up right now. Read from the
  // browser's own device object rather than mirrored into a flag of ours: this is
  // exactly the state that changes without us being told first, and a stale copy sends
  // writes into a dead characteristic.
  connected() {
    return !!(this.device && this.device.gatt && this.device.gatt.connected);
  }

  // _setup (re)establishes GATT, characteristics and notifications. Re-runnable
  // on reconnect (the characteristic objects are recreated each time).
  async _setup() {
    const server = await this.device.gatt.connect();
    const service = await server.getPrimaryService(NUS_SERVICE);
    this.writeChar = await service.getCharacteristic(NUS_WRITE);
    const notifyChar = await service.getCharacteristic(NUS_NOTIFY);
    await notifyChar.startNotifications();
    notifyChar.addEventListener('characteristicvaluechanged', (e) => {
      this._listeners.forEach((cb) => cb(e.target.value)); // DataView, one full frame
    });
  }

  async _onDisconnected() {
    if (this._intentional) return;
    this._status('reconnecting');
    // Exponential backoff, capped; keep retrying until reconnected or user stops.
    let delay = 1500;
    while (!this._intentional && this.device && !this.device.gatt.connected) {
      await new Promise((r) => setTimeout(r, delay));
      if (this._intentional) return;
      try {
        await this._setup();
        this._status('connected');
        return;
      } catch (e) {
        delay = Math.min(delay * 2, 30000);
        this._status('reconnecting');
      }
    }
  }

  // Web Bluetooth allows exactly ONE GATT operation in flight; a second write
  // started before the first settles rejects with "GATT operation already in
  // progress". Callers legitimately fire independently — region discovery rides
  // the discover clock and lands in the same tick as the discover sweep — so
  // serialise here rather than making every call site coordinate. Each caller
  // still sees its OWN write's outcome; the chain itself swallows so one
  // failure cannot poison every later send.
  async send(bytes) {
    if (!this.writeChar) throw new Error('not connected');
    const mine = this._writeChain.then(() => {
      if (!this.writeChar) throw new Error('not connected');
      return this.writeChar.writeValue(bytes); // companion expects whole frame in one write
    });
    this._writeChain = mine.catch(() => {});
    return mine;
  }

  isConnected() { return !!(this.device && this.device.gatt && this.device.gatt.connected); }

  async disconnect() {
    this._intentional = true;
    try { if (this.device && this.device.gatt.connected) this.device.gatt.disconnect(); } catch (e) {}
  }
}
