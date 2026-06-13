// Unit tests for the runtime config loader's pure validation/normalization.
// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert';
import { normalizeConfig } from '../src/config.js';

test('normalizeConfig requires mqttUrl', () => {
  assert.throws(() => normalizeConfig({ mqttUsername: 'x' }), /mqttUrl/);
});

test('normalizeConfig trims fields and defaults resolveUrl to empty', () => {
  const c = normalizeConfig({ mqttUrl: '  wss://b:8084/ws  ', mqttUsername: ' u ' });
  assert.strictEqual(c.mqttUrl, 'wss://b:8084/ws');
  assert.strictEqual(c.mqttUsername, 'u');
  assert.strictEqual(c.resolveUrl, '');
});

test('normalizeConfig keeps resolveUrl when provided', () => {
  const c = normalizeConfig({ mqttUrl: 'wss://b/ws', resolveUrl: 'https://x/api/nodes/resolve' });
  assert.strictEqual(c.resolveUrl, 'https://x/api/nodes/resolve');
});

test('normalizeConfig rejects a non-object', () => {
  assert.throws(() => normalizeConfig(null), /JSON object/);
});

test('normalizeConfig does not trim mqttPassword', () => {
  const c = normalizeConfig({ mqttUrl: 'wss://b/ws', mqttPassword: '  s3cr3t  ' });
  assert.strictEqual(c.mqttPassword, '  s3cr3t  ');
});

test('normalizeConfig defaults mqttPassword to empty string when absent', () => {
  const c = normalizeConfig({ mqttUrl: 'wss://b/ws' });
  assert.strictEqual(c.mqttPassword, '');
});
