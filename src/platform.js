// Picks the Bluetooth transport and GPS for where the app runs: the browser (Web
// Bluetooth, navigator.geolocation) or the native Capacitor app (plugins). The rest
// of the app does not know which one it got.
import { Capacitor, CapacitorHttp, registerPlugin } from '@capacitor/core';
import { BleClient } from '@capacitor-community/bluetooth-le';
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

export function createGps() {
  return isNativeApp() ? new NativeGps(registerPlugin('BackgroundGeolocation')) : new Gps();
}
