// Cold-start gate: shown until the first GPS fix arrives or it is dismissed,
// covering the two things capture needs — the companion radio and a
// position. Ported from core-hunter's app/src/splash.js (splashState,
// splashRows, dismissBanner unchanged in their logic); this app tracks no
// LoRa spreading factor, so the Bluetooth row carries only the companion
// name, and there is no "your own local captures" fallback to point to since
// nothing is captured at all before a companion is connected.
export function splashState({ hasFix, connected, bleError, gpsError, dismissed }) {
  if (hasFix || dismissed) return 'hidden';
  if (bleError) return 'ble-error';
  if (!connected) return 'intro';
  if (gpsError) return 'gps-error';
  return 'waiting-gps';
}

// The two status rows the panel renders per state. Rows are a fixed height in
// CSS, so nothing here may change a row's shape: the panel hangs from its top
// and must not jump when a spinner appears.
export function splashRows(s, { name } = {}) {
  const bluetoothOn = { key: 'Bluetooth', dot: 'on', text: name || 'Connected' };
  if (s === 'waiting-gps') return [bluetoothOn, { key: 'GPS', spin: true, text: 'Waiting for a fix…' }];
  if (s === 'gps-error') return [bluetoothOn, { key: 'GPS', dot: 'err', text: 'No fix' }];
  if (s === 'ble-error') {
    return [
      { key: 'Bluetooth', dot: 'err', text: 'Not connected' },
      { key: 'GPS', dot: 'off', text: 'No fix yet' },
    ];
  }
  return [
    { key: 'Bluetooth', dot: 'off', text: 'No companion' },
    { key: 'GPS', dot: 'off', text: 'No fix yet' },
  ];
}

// The banner for whoever dismissed the gate before the first fix: hasFix
// shows nowhere else, so without this someone drives around while nothing is
// captured.
export function dismissBanner({ connected } = {}) {
  return connected
    ? 'No GPS fix yet. Nothing is logged without a position.'
    : 'No companion connected. Nothing is captured until you connect.';
}

// User-facing product name.
export const APP_NAME = 'CoreDrive RX';

// Fallback lines for the two retryable states.
export const SPLASH_ERRORS = {
  'gps-error': 'Could not get your location. Make sure location access is allowed for this site, then retry.',
  'ble-error': 'Could not connect. Retry to try again.',
};

// renderSplashRows is the gate's one DOM writer. Built with createElement,
// never innerHTML — the text is app copy, but this keeps the same rule every
// other src/ui renderer follows.
export function renderSplashRows(el, rows) {
  el.replaceChildren(...rows.map((r) => {
    const row = document.createElement('div');
    row.className = 'splash-srow';
    const key = document.createElement('span');
    key.className = 'splash-skey';
    key.textContent = r.key;
    row.appendChild(key);
    if (r.spin) {
      const sp = document.createElement('span');
      sp.className = 'splash-spin';
      row.appendChild(sp);
    } else {
      const dot = document.createElement('span');
      dot.className = 'splash-dot' + (r.dot === 'on' ? ' on' : r.dot === 'err' ? ' err' : '');
      row.appendChild(dot);
    }
    const tx = document.createElement('span');
    tx.className = 'splash-stext' + (r.dot === 'on' ? '' : ' muted');
    tx.textContent = r.text;
    row.appendChild(tx);
    return row;
  }));
}
