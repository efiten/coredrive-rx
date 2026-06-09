// Publishes buffered receptions to MQTT (over WebSocket/TLS) in the
// meshcoretomqtt-compatible format CoreScope's ingestor consumes, on the
// client topic meshcore/client/{PUBLIC_KEY}/packets.
import mqtt from 'mqtt';

export class Publisher {
  // opts: { url, username, password } — EMQX WSS endpoint + per-client creds.
  constructor(opts) { this.opts = opts; this.client = null; }

  connect() {
    this.client = mqtt.connect(this.opts.url, {
      username: this.opts.username,
      password: this.opts.password,
      clientId: this.opts.clientId, // = companion pubkey; EMQX ACL can bind topics to ${clientid}
      reconnectPeriod: 4000,
      clean: true,
    });
    return new Promise((resolve, reject) => {
      this.client.once('connect', resolve);
      this.client.once('error', reject);
    });
  }

  connected() { return !!(this.client && this.client.connected); }

  end() { try { if (this.client) this.client.end(true); } catch (e) {} this.client = null; }

  // buildPayload assembles one reception in the ingestor's expected shape.
  static buildPayload(rxPubkey, rec) {
    return {
      origin_id: rxPubkey,
      timestamp: rec.rx_at,
      type: 'PACKET',
      direction: 'rx',
      raw: rec.raw,
      SNR: rec.snr,
      RSSI: rec.rssi,
      gps: { lat: rec.lat, lon: rec.lon, acc_m: rec.acc_m },
    };
  }

  // publish sends one reception; resolves on broker ack (QoS1).
  publish(rxPubkey, rec) {
    const topic = 'meshcore/client/' + rxPubkey + '/packets';
    const payload = JSON.stringify(Publisher.buildPayload(rxPubkey, rec));
    return new Promise((resolve, reject) => {
      this.client.publish(topic, payload, { qos: 1 }, (err) => (err ? reject(err) : resolve()));
    });
  }
}
