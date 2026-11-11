// What a hidden page may still record, and what it tells the user afterwards.
//
// A browser slows or freezes a hidden page, and GPS updates stop with it, while Web
// Bluetooth can still hand over packets. Without a guard those packets are stamped with
// the last position from before the page went to the background, which can be far
// behind the real one: wrong data in CoreScope. So a hidden page only uses a fix that
// is still fresh. A visible page is never limited: GPS runs while it is on screen. The
// Android app keeps its page visible with the screen off, so this rarely applies there.

export const FIX_STALE_MS = 30000;
export const BG_NOTICE_MIN_MS = 60000; // a short glance at another app is not worth a note

// usableFix returns the fix when it may stamp a reception now, else null. A fix without
// a receive time (`at`) is taken as fresh.
export function usableFix(fix, now, hidden) {
  if (!fix) return null;
  if (!hidden || fix.at == null || now - fix.at <= FIX_STALE_MS) return fix;
  return null;
}

// A background spell: from the page going hidden until it is visible again, with how
// many receptions were saved and how many were skipped for want of a fresh fix.
export function startSpell(now) { return { since: now, saved: 0, skipped: 0 }; }

// endSpell returns the spell to report, or null when it was too short to matter.
export function endSpell(spell, now) {
  if (!spell || now - spell.since < BG_NOTICE_MIN_MS) return null;
  return { ms: now - spell.since, saved: spell.saved, skipped: spell.skipped };
}

function minutes(ms) {
  const m = Math.round(ms / 60000);
  return m < 1 ? 'under a minute' : m + ' min';
}

export function spellText(s) {
  const rx = (n) => n + (n === 1 ? ' reception' : ' receptions');
  let t = 'The app was in the background for ' + minutes(s.ms) + ': ' + rx(s.saved) + ' saved';
  if (s.skipped > 0) t += ', ' + rx(s.skipped) + ' not saved because the browser paused GPS';
  return t + '. Keep CoreDrive RX on screen while mapping. Tap to dismiss.';
}
