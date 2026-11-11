// Picks the Bluetooth transport and GPS for where the app runs: the browser (Web
// Bluetooth, navigator.geolocation) or the native Capacitor app (plugins). The rest
// of the app does not know which one it got.
import { Capacitor, CapacitorHttp, registerPlugin } from '@capacitor/core';
import { BleClient } from '@capacitor-community/bluetooth-le';
import { BarcodeScanner } from '@capacitor-mlkit/barcode-scanning';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { LocalNotifications } from '@capacitor/local-notifications';
import { WebBluetoothTransport } from './transport.js';
import { CapacitorBleTransport } from './transport-native.js';
import { Gps } from './gps.js';
import { NativeGps } from './gps-native.js';

export function isNativeApp(cap = Capacitor) {
  return !!(cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform());
}

export function createTransport() {
  return isNativeApp() ? new CapacitorBleTransport(BleClient) : new WebBluetoothTransport();
}

// nativeHttpGet fetches outside the WebView, so a deployment's config.json needs no
// CORS header for the app. Resolves to { status, data }.
export function nativeHttpGet(url) {
  return CapacitorHttp.get({ url, responseType: 'text', headers: { 'Cache-Control': 'no-cache' }, connectTimeout: 10000, readTimeout: 10000 });
}

// nativeShareFile writes the text to the app cache and opens the Android share sheet
// with it as a file attachment (mail, chat, Drive). For src/sharelog.js.
export async function nativeShareFile(text, filename) {
  const { uri } = await Filesystem.writeFile({ path: filename, data: text, directory: Directory.Cache, encoding: Encoding.UTF8 });
  await Share.share({ title: filename, text: 'CoreDrive RX debug log', files: [uri] });
}

// The Google code scanner plugin, for src/qrscan.js.
export function qrScanner() { return BarcodeScanner; }

export function createGps() {
  return isNativeApp() ? new NativeGps(registerPlugin('BackgroundGeolocation'), LocalNotifications) : new Gps();
}
