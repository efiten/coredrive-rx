// Share/export the debug log. A mobile PWA can't attach a file to a mailto: link,
// so the primary path is the Web Share API (opens the share sheet → Mail with a real
// .txt attachment). Falls back to a file download, then a truncated mailto: body.
//
// The capability probe is injected so the fallback selection is unit-testable without
// a DOM/navigator. pickShareMethod is pure; shareLog wires it to the real platform.

const MAILTO_BODY_MAX = 1800; // most clients/OS truncate long mailto bodies

// pickShareMethod chooses the export path from the available capabilities.
//   caps = { canShareFiles: bool, canDownload: bool }
// Returns 'share' | 'download' | 'mailto'.
export function pickShareMethod(caps) {
  if (caps.canShareFiles) return 'share';
  if (caps.canDownload) return 'download';
  return 'mailto';
}

// buildMailto returns a mailto: URL with a (truncated) log body — last-resort path.
export function buildMailto(text, subject = 'coredrive-rx debug log') {
  const body = text.length > MAILTO_BODY_MAX ? text.slice(0, MAILTO_BODY_MAX) + '\n…(truncated)' : text;
  return 'mailto:?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body);
}

// shareLog exports `text` using the best available method. Browser-only (touches
// navigator/document); the pure decision lives in pickShareMethod above.
export async function shareLog(text, filename = 'coredrive-rx-debug.txt') {
  const file = typeof File !== 'undefined' ? new File([text], filename, { type: 'text/plain' }) : null;
  const canShareFiles = !!(file && navigator.canShare && navigator.canShare({ files: [file] }));
  const caps = { canShareFiles, canDownload: typeof document !== 'undefined' };
  const method = pickShareMethod(caps);

  if (method === 'share') {
    await navigator.share({ files: [file], title: filename, text: 'coredrive-rx debug log' });
    return 'share';
  }
  if (method === 'download') {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return 'download';
  }
  location.href = buildMailto(text);
  return 'mailto';
}
