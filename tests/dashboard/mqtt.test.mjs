import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_TOPIC, isBrokerUrl, resolveConnection } from '../../dashboard/mqtt.js';

const CFG = { url: 'wss://cfg.example:8884/mqtt', username: 'dashboard', password: 'x', topic: 'felinos/#' };

test('browser-saved connection wins over config.js', () => {
  const r = resolveConnection({ url: ' wss://saved.example:8884/mqtt ', username: ' me ', password: 'p', topic: '' }, CFG);
  assert.deepEqual(r, { url: 'wss://saved.example:8884/mqtt', username: 'me', password: 'p', topic: DEFAULT_TOPIC, source: 'browser' });
});

test('config.js is used when nothing is saved (or saved URL is empty)', () => {
  assert.equal(resolveConnection(null, CFG).source, 'config');
  assert.equal(resolveConnection({ url: '  ' }, CFG).url, CFG.url);
});

test('no settings at all → source none (hosted page before setup)', () => {
  const r = resolveConnection(null, { url: '' });
  assert.equal(r.source, 'none');
  assert.equal(r.url, '');
  assert.equal(r.topic, DEFAULT_TOPIC);
});

test('isBrokerUrl accepts only ws(s) URLs', () => {
  assert.ok(isBrokerUrl('wss://felinos-telemetry-f2ce0e95.a02.usw2.aws.hivemq.cloud:8884/mqtt'));
  assert.ok(isBrokerUrl('ws://localhost:8000/mqtt'));
  assert.ok(!isBrokerUrl('felinos-telemetry.hivemq.cloud'));
  assert.ok(!isBrokerUrl('https://example.com'));
  assert.ok(!isBrokerUrl(''));
});
