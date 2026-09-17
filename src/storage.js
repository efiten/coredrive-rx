// One place that knows what this build's storage is called. /beta is the same
// origin as production, so an unsuffixed IndexedDB would let a test build
// publish receptions the production app queued, and either build could act on
// the other's contact-path restore record.
let ns = typeof __STORAGE_NS__ !== 'undefined' ? __STORAGE_NS__ : '';

export function storageNs() { return typeof ns === 'string' ? ns : ''; }

export function dbName(base) { return `${base}${storageNs()}`; }

export function prefKey(name) { return `coredrive${storageNs()}.${name}`; }

// The theme preference is deliberately NOT namespaced. index.html paints the
// theme before any module loads, from an inline script that Vite's define
// never reaches, so it can only read one fixed key. Sharing dark/light between
// the live app and the beta build on the same phone costs nothing; a flash of
// the wrong theme on every load does not.
export function themeKey() { return 'coredrive.theme'; }

// Test seam: the build constant is fixed at bundle time, so tests set it here.
export function __setNs(v) { ns = v; }
