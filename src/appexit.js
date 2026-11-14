// Stop & close (Android app, Home). Back or Home leaves capture running in the
// background on purpose, so this is the one-tap way to end it: stop everything,
// then close the app. Receptions not yet uploaded stay in the queue (IndexedDB)
// and go out on the next connect.
//
// No DOM and no Capacitor here: the confirm, the disconnect and the exit are passed in.

export const STOP_CONFIRM_TEXT = 'Stop capturing and close CoreDrive RX? Receptions not uploaded yet are kept and go out the next time you connect.';

// stopAndClose asks first while connected (a tap by mistake mid-drive would end the
// capture), then disconnects and exits. A failing disconnect still closes the app:
// the user asked for it to be gone. Resolves to 'cancelled' or 'closed'.
export async function stopAndClose({ connected, confirm, disconnect, exitApp }) {
  if (connected && !confirm(STOP_CONFIRM_TEXT)) return 'cancelled';
  try { await disconnect(); } catch (e) { /* closing anyway */ }
  await exitApp();
  return 'closed';
}
