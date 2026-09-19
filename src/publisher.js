// Publishes buffered receptions to MQTT (over WebSocket/TLS) in the
// meshcoretomqtt-compatible format CoreScope's ingestor consumes, on the
// client topics meshcore/client/{PUBLIC_KEY}/packets (receptions),
// meshcore/client/{PUBLIC_KEY}/rf (RF environment samples) and
// meshcore/client/{PUBLIC_KEY}/regions (region-discovery answers).
import mqtt from 'mqtt';

// KEEPALIVE is set EXPLICITLY rather than inherited. mqtt.js defaults to 60 s and arms
// its keepalive manager only inside _onConnect, and only when one does not already exist
// (client.js:1101) — it never re-arms an existing manager. So a manager that survives a
// connection carries its counter into the next one and can report a bogus
// 'Keepalive timeout' on a perfectly healthy link. Stating the value here means the log
// can quote it, which is what turns that error from a red herring into evidence.
export const KEEPALIVE_SECS = 60;

// Every Publisher gets a monotonic id. A single module-level status handler in app.js
// receives events from EVERY instance ever created, so without an id a stale client's
// failures are indistinguishable from the live one's — and they overwrote the broker
// state. Field symptom: ~18 'Keepalive timeout' errors against a single successful
// connect, which is arithmetically impossible for one client (each timeout needs its own
// CONNACK-armed manager, and _cleanUp destroys the manager), yet nothing in the log could
// attribute them.
let seq = 0;

export class Publisher {
  // opts: { url, username, password, clientId } — EMQX WSS endpoint + per-client creds.
  constructor(opts) { this.opts = opts; this.client = null; this._onStatus = null; this.id = ++seq; }

  // onStatus(cb): cb(state, arg, id) is called on connection lifecycle changes, where
  // state is 'connect' | 'reconnect' | 'offline' | 'close' | 'error' (arg = the CONNACK
  // packet for 'connect', an Error for 'error') and id identifies THIS publisher.
  // Drives the Home upload indicator, the debug log, and a drain kick on reconnect.
  onStatus(cb) { this._onStatus = cb; }

  _emit(ev, arg) { if (this._onStatus) this._onStatus(ev, arg, this.id); }

  // connectOptions is the mqtt.js option set, split out so it can be asserted without
  // opening a socket.
  //
  // timerVariant 'native' is load-bearing. mqtt.js defaults to 'auto', which in a browser
  // runs the keepalive interval through worker-timers: the page hands
  // performance.timeOrigin + performance.now() to a Worker, which compares it against its
  // own clock (worker-timers-worker set-timer.js). That Worker is created lazily, on the
  // first connect, so it takes its time origin from the wall clock at that moment — while
  // the page's performance.now() does NOT advance while an Android device sleeps. A
  // session left open for seven hours therefore handed the Worker a "now" hours in the
  // past, every keepalive tick was already overdue, the Worker fired three back to back
  // and mqtt.js raised 'Keepalive timeout' in the same second as the CONNACK. Every
  // reconnect re-armed the manager against the same skew, and the Worker is a module
  // singleton, so neither reconnecting nor building a fresh Publisher could clear it —
  // only reloading the page did, which is exactly what the field report says.
  //
  // A native interval is measured in one clock domain and cannot drift that way.
  // Background throttling of a native timer costs at most one keepalive timeout, and the
  // ordinary reconnect recovers from that.
  static connectOptions(opts) {
    return {
      username: opts.username,
      password: opts.password,
      clientId: opts.clientId, // = companion pubkey; EMQX ACL can bind topics to ${clientid}
      reconnectPeriod: 4000,
      keepalive: KEEPALIVE_SECS,
      clean: true,
      timerVariant: 'native',
    };
  }

  connect() {
    this.client = mqtt.connect(this.opts.url, Publisher.connectOptions(this.opts));
    // 'connect' carries the CONNACK packet through, so the log can record its return
    // code instead of leaving an auth or takeover refusal indistinguishable from a
    // network failure.
    for (const ev of ['connect', 'reconnect', 'offline', 'close']) {
      this.client.on(ev, (packet) => this._emit(ev, packet));
    }
    // PERSISTENT error listener. mqtt.js is an EventEmitter: an 'error' with no listener
    // throws and can wedge the auto-reconnect loop — which left the client permanently
    // disconnected (every reception stuck pending) after one transient drop. Always
    // listen and surface the reason instead.
    this.client.on('error', (e) => this._emit('error', e));
    // Resolve/reject the INITIAL connect only. Listeners are removed once settled so the
    // persistent 'error' handler above is the sole long-lived one afterwards.
    return new Promise((resolve, reject) => {
      const onConn = () => { cleanup(); resolve(); };
      const onErr = (e) => { cleanup(); reject(e); };
      const cleanup = () => { this.client.removeListener('connect', onConn); this.client.removeListener('error', onErr); };
      this.client.on('connect', onConn);
      this.client.on('error', onErr);
    });
  }

  connected() { return !!(this.client && this.client.connected); }

  // reconnect forces a fresh connection attempt — used by "Push pending now" when the
  // client is disconnected, so the user isn't stuck with a dead link and a full queue.
  //
  // It declines (returns false) while a CONNECT is still unanswered. mqtt.js connect()
  // replaces this.stream without closing the old one (client.js:257), so each forced
  // attempt left the previous socket open. When such an orphan closed, its 'close' set
  // client.connected = false over a live session and armed a reconnect that orphaned
  // that one in turn. Field log 2026-09-19: five presses in four seconds during a slow
  // connect, then "connected" / "offline" / "connection closed" in the same second,
  // over and over. An attempt in flight is one with neither a session nor the
  // reconnect timer that mqtt.js arms once the socket has closed (client.js:873); it
  // ends by itself within connectTimeout.
  reconnect() {
    const c = this.client;
    if (!c || (!c.connected && !c.reconnectTimer)) return false;
    try { c.reconnect(); } catch (e) {}
    return true;
  }

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

  // buildRfPayload assembles one RF environment sample. Additive: a new type on
  // a new topic, so the /packets contract is unaffected.
  static buildRfPayload(rxPubkey, rec, name) {
    const p = {
      origin_id: rxPubkey,
      origin: name || undefined,
      timestamp: rec.at,
      type: 'RF_SAMPLE',
      gps: { lat: rec.lat, lon: rec.lon, acc_m: rec.acc_m },
      stationary: !!rec.stationary,
      uptime_secs: rec.uptime_secs,
      battery_mv: rec.battery_mv,
      queue_len: rec.queue_len,
      errors: rec.errors,
      noise_floor: rec.noise_floor,
      last_rssi: rec.last_rssi,
      last_snr: rec.last_snr,
      tx_air_secs: rec.tx_air_secs,
      rx_air_secs: rec.rx_air_secs,
      recv: rec.recv,
      sent: rec.sent,
      flood_rx: rec.flood_rx,
      direct_rx: rec.direct_rx,
      flood_tx: rec.flood_tx,
      direct_tx: rec.direct_tx,
    };
    if ('recv_errors' in rec) p.recv_errors = rec.recv_errors;
    return p;
  }

  // buildRegionsPayload assembles one region-discovery answer. Additive: a new type
  // on a new topic, so the /packets contract is unaffected. `target` is the repeater
  // that was asked; `regions` may legitimately be [] (declares nothing) and must not
  // be dropped or coerced. `truncated` is a hint the reply may have omitted names.
  static buildRegionsPayload(rxPubkey, rec, name) {
    return {
      origin_id: rxPubkey,
      origin: name || undefined,
      timestamp: rec.at,
      type: 'REGIONS',
      target: rec.target,
      regions: rec.regions,
      truncated: rec.truncated,
      repeater_clock: rec.repeater_clock,
      gps: { lat: rec.lat, lon: rec.lon, acc_m: rec.acc_m },
    };
  }

  // topicFor / payloadFor dispatch on rec.kind. A record with NO kind is a
  // reception queued before this feature existed — it must keep working.
  static topicFor(rxPubkey, rec) {
    const suffix = rec.kind === 'rf' ? '/rf' : rec.kind === 'regions' ? '/regions' : '/packets';
    return 'meshcore/client/' + rxPubkey + suffix;
  }

  static payloadFor(rxPubkey, rec, name) {
    if (rec.kind === 'rf') return Publisher.buildRfPayload(rxPubkey, rec, name);
    if (rec.kind === 'regions') return Publisher.buildRegionsPayload(rxPubkey, rec, name);
    return Publisher.buildPayload(rxPubkey, rec, name);
  }

  // publish sends one reception; resolves on broker ack (QoS1). A dead socket never
  // acks, so the callback would hang forever — the timeout rejects instead, the record
  // stays buffered, and the drain loop lives on to retry after reconnect.
  publish(rxPubkey, rec, name, timeoutMs = 8000) {
    const topic = Publisher.topicFor(rxPubkey, rec);
    const payload = JSON.stringify(Publisher.payloadFor(rxPubkey, rec, name));
    const ack = new Promise((resolve, reject) => {
      this.client.publish(topic, payload, { qos: 1 }, (err) => (err ? reject(err) : resolve()));
    });
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('publish timeout')), timeoutMs));
    return Promise.race([ack, timeout]);
  }
}
