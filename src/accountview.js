// accountview.js — pure transform: account state (src/account.js) into what the
// Settings "CoreScope account" card shows. No DOM; src/app.js renderAccount writes it.
//
// Visible when the feature is on, OR when the connected companion is being held: a
// failed discovery keeps the last known hold flag, and a queue held with no visible
// reason would read exactly like an uplink that is broken.

const shortKey = (pk) => pk.slice(0, 12) + '…';

// accountView({ enabled, loggedIn, displayName, companions, connectedPubkey, link,
//               holding, pending })
//   companions       [{ pubkey, name }] — the linked cache
//   connectedPubkey  the companion connected now, '' when none
//   link             { pubkey, name, status, reason } — account.linkState
//   holding          drain is held for the connected companion
//   pending          queue depth, for "N waiting"
// → { visible, mode: 'in'|'out', who, rows: [{ label, short, connected }], linkText,
//     showRetry, holdText }
export function accountView({ enabled, loggedIn, displayName, companions, connectedPubkey, link, holding, pending }) {
  const pk = String(connectedPubkey || '').toLowerCase();
  const rows = loggedIn
    ? (companions || []).map((c) => {
      const connected = !!pk && c.pubkey === pk;
      return { label: (connected ? '● ' : '') + (c.name || shortKey(c.pubkey)), short: c.pubkey.slice(0, 8), connected };
    })
    : [];

  // A link state is shown only for the companion connected NOW.
  const current = !!pk && link && link.pubkey === pk ? link : null;
  const name = current ? (current.name || shortKey(current.pubkey)) : '';
  let linkText = '';
  let showRetry = false;
  if (loggedIn && current) {
    if (current.status === 'linked') linkText = '✓ ' + name + ' linked' + (current.reason ? ' — ' + current.reason : '');
    else if (current.status === 'working') linkText = 'Linking ' + name + '…';
    else if (current.status === 'waiting') linkText = 'Linking ' + name + '… (waiting for the network)';
    else if (current.status === 'unsupported') linkText = "This companion's firmware cannot sign; update it to link.";
    else if (current.status === 'failed') { linkText = 'Linking failed: ' + current.reason; showRetry = true; }
  }

  let holdText = '';
  if (holding) {
    const n = Number(pending) || 0;
    if (!loggedIn) holdText = 'Log in to contribute your data – ' + n + ' waiting';
    else if (current && (current.status === 'failed' || current.status === 'unsupported')) holdText = 'Not linked – ' + n + ' waiting';
    else {
      holdText = 'Linking ' + (name || 'this companion') + '… – ' + n + ' waiting';
      linkText = '';
    }
  }

  return {
    visible: !!(enabled || holding),
    mode: loggedIn ? 'in' : 'out',
    who: loggedIn ? 'Logged in as ' + (displayName || '(no display name)') : '',
    rows,
    linkText,
    showRetry,
    holdText,
  };
}
