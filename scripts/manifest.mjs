// The web app manifest, built rather than shipped as a static public/ file.
//
// A static manifest cannot follow the build: `start_url` and `scope` were both
// "/", so adding the /beta build to the home screen installed a shortcut that
// launched the PRODUCTION app — the one thing the beta slot exists to keep
// separate. Both now come from Vite's own `base`, so each build installs itself.
//
// Icon paths are relative on purpose: a manifest's URLs resolve against the
// manifest's own address, which is base + 'manifest.webmanifest', so "icon-192.png"
// lands in the right slot for either build without a second base substitution.

// themeColorFromHtml reads index.html's <meta name="theme-color">. The colour is
// a literal there (a meta tag cannot read a CSS variable) and index.html's own
// comment says it must equal --ch-bg in the dark theme. Taking it from that one
// literal is what keeps the manifest from drifting away from it: the browser
// paints the splash screen from the manifest and the address bar from the meta,
// and two different values are visible as a flash of the wrong colour on launch.
export function themeColorFromHtml(html) {
  const m = html.match(/<meta\s+name="theme-color"\s+content="([^"]+)"/);
  return m ? m[1] : null;
}

export function buildManifest(base, themeColor) {
  return {
    name: 'CoreDrive RX',
    short_name: 'CoreDrive RX',
    description: 'Mobile RF coverage capture for CoreScope (BLE companion → MQTT)',
    start_url: base,
    scope: base,
    display: 'standalone',
    orientation: 'portrait',
    background_color: themeColor,
    theme_color: themeColor,
    icons: [
      { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
    ],
  };
}
