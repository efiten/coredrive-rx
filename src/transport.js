// BLE transport behind an interface so a future iOS Capacitor build only swaps
// this class (a CapacitorBleTransport with the same connect()/onFrame API).
// WebBluetoothTransport works on Android Chrome (Web Bluetooth).

// MeshCore companion uses the Nordic UART Service (NUS).
const NUS_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const NUS_WRITE = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'; // app → firmware (commands)
const NUS_NOTIFY = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; // firmware → app (frames)  [verify in spike]

export class WebBluetoothTransport {
  constructor() {
    this.device = null;
    this.writeChar = null;
    this._onFrame = null;
  }

  // onFrame(cb): cb receives a DataView per incoming frame.
  onFrame(cb) { this._onFrame = cb; }

  async connect() {
    if (!navigator.bluetooth) throw new Error('Web Bluetooth not available (use Android Chrome)');
    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [NUS_SERVICE] }],
      optionalServices: [NUS_SERVICE],
    });
    const server = await this.device.gatt.connect();
    const service = await server.getPrimaryService(NUS_SERVICE);
    this.writeChar = await service.getCharacteristic(NUS_WRITE);
    const notifyChar = await service.getCharacteristic(NUS_NOTIFY);
    await notifyChar.startNotifications();
    notifyChar.addEventListener('characteristicvaluechanged', (e) => {
      if (this._onFrame) this._onFrame(e.target.value); // DataView, one full frame
    });
    return true;
  }

  async send(bytes) {
    if (!this.writeChar) throw new Error('not connected');
    await this.writeChar.writeValue(bytes); // companion expects whole frame in one write
  }

  isConnected() { return !!(this.device && this.device.gatt && this.device.gatt.connected); }

  async disconnect() {
    try { if (this.device && this.device.gatt.connected) this.device.gatt.disconnect(); } catch (e) {}
  }
}
