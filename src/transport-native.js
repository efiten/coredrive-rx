// BLE transport for the native (Capacitor) app. The Android WebView has no Web
// Bluetooth, so this goes through @capacitor-community/bluetooth-le instead, with
// the same API as WebBluetoothTransport (src/transport.js): connect, onFrame,
// offFrame, onStatus, send, connected, isConnected, disconnect. The plugin
// requests a 512-byte MTU on connect (android Device.kt REQUEST_MTU), so a whole
// companion frame fits one write, as with Web Bluetooth.
//
// The plugin object is injected (src/platform.js passes BleClient) so this file
// has no plugin import and is testable in Node.
import { NUS_SERVICE, NUS_WRITE, NUS_NOTIFY } from './transport.js';

export class CapacitorBleTransport {
  constructor(ble, opts = {}) {
    this.ble = ble;
    this.deviceId = null;
    this._up = false;
    this._listeners = [];
    this._onStatus = null;
    this._intentional = false;
    this._writeChain = Promise.resolve();
    this._firstDelayMs = opts.firstDelayMs ?? 1500;
  }

  onFrame(cb) { this._listeners.push(cb); }
  offFrame(cb) { this._listeners = this._listeners.filter((f) => f !== cb); }
  onStatus(cb) { this._onStatus = cb; }
  _status(s) { if (this._onStatus) this._onStatus(s); }

  async connect() {
    this._intentional = false;
    // neverForLocation: the scan is only used to pick the companion, not to place
    // the phone. The position comes from GPS (src/gps-native.js).
    await this.ble.initialize({ androidNeverForLocation: true });
    if (!(await this.ble.isEnabled())) await this.ble.requestEnable();
    const device = await this.ble.requestDevice({ services: [NUS_SERVICE] });
    this.deviceId = device.deviceId;
    await this._setup();
    return true;
  }

  async _setup() {
    await this.ble.connect(this.deviceId, () => this._onDisconnected());
    await this.ble.startNotifications(this.deviceId, NUS_SERVICE, NUS_NOTIFY, (dv) => {
      this._listeners.forEach((cb) => cb(dv));
    });
    this._up = true;
  }

  async _onDisconnected() {
    this._up = false;
    if (this._intentional) return;
    this._status('reconnecting');
    let delay = this._firstDelayMs;
    while (!this._intentional && !this._up) {
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

  // One write at a time, for the same reason as WebBluetoothTransport.send: callers
  // fire independently and a second GATT write in flight fails.
  async send(bytes) {
    if (!this._up) throw new Error('not connected');
    const mine = this._writeChain.then(() => {
      if (!this._up) throw new Error('not connected');
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      return this.ble.write(this.deviceId, NUS_SERVICE, NUS_WRITE, dv);
    });
    this._writeChain = mine.catch(() => {});
    return mine;
  }

  connected() { return this._up; }
  isConnected() { return this._up; }

  async disconnect() {
    this._intentional = true;
    this._up = false;
    try { if (this.deviceId) await this.ble.disconnect(this.deviceId); } catch (e) {}
  }
}
