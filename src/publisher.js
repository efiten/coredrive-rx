// Publishes buffered receptions to MQTT (over WebSocket/TLS) in the
// meshcoretomqtt-compatible format CoreScope's ingestor consumes, on the
// client topic meshcore/client/{PUBLIC_KEY}/packets.
import mqtt from 'mqtt';

export class Publisher {
  // opts: { url, username, password } — EMQX WSS endpoint + per-client creds.
  constructor(opts) { this.opts = opts; this.client = null; this._onStatus = null; }

  // onStatus(cb): cb(state) is called on connection lifecycle changes, where state is
  // 'connect' | 'reconnect' | 'offline' | 'close'. Drives the Home upload indicator and
  // a drain kick on reconnect. A network handoff (cellular→WiFi) silently kills the
  // socket; a short keepalive makes MQTT.js notice and reconnect quickly.
  onStatus(cb) { this._onStatus = cb; }

  connect() {
    this.client = mqtt.connect(this.opts.url, {
      username: this.opts.username,
      password: this.opts.password,
      clientId: this.opts.clientId, // = companion pubkey; EMQX ACL can bind topics to ${clientid}
      reconnectPeriod: 4000,
      keepalive: 20, // detect a dead socket fast (default 60 s is too slow after a handoff)
      clean: true,
    });
    for (const ev of ['connect', 'reconnect', 'offline', 'close']) {
      this.client.on(ev, () => { if (this._onStatus) this._onStatus(ev); });
    }
    return new Promise((resolve, reject) => {
      this.client.once('connect', resolve);
      this.client.once('error', reject);
    });
  }

  connected() { return !!(this.client && this.client.connected); }

  end() { try { if (this.client) this.client.end(true); } catch (e) {} this.client = null; }

  // buildPayload assembles one reception in the ingestor's expected shape.
  // `name` is the companion's self-reported name (SELF_INFO) → sent as "origin"
  // so the server can label this observer even if it never advertised.
  static buildPayload(rxPubkey, rec, name) {
    return {
      origin_id: rxPubkey,
      origin: name || undefined,
      timestamp: rec.rx_at,
      type: 'PACKET',
      direction: 'rx',
      raw: rec.raw,
      SNR: rec.snr,
      RSSI: rec.rssi,
      gps: { lat: rec.lat, lon: rec.lon, acc_m: rec.acc_m },
    };
  }

  // publish sends one reception; resolves on broker ack (QoS1). A dead socket never
  // acks, so the callback would hang forever — the timeout rejects instead, the record
  // stays buffered, and the drain loop lives on to retry after reconnect.
  publish(rxPubkey, rec, name, timeoutMs = 8000) {
    const topic = 'meshcore/client/' + rxPubkey + '/packets';
    const payload = JSON.stringify(Publisher.buildPayload(rxPubkey, rec, name));
    const ack = new Promise((resolve, reject) => {
      this.client.publish(topic, payload, { qos: 1 }, (err) => (err ? reject(err) : resolve()));
    });
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('publish timeout')), timeoutMs));
    return Promise.race([ack, timeout]);
  }
}
