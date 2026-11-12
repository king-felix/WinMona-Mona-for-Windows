import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeClient, parseSseFrame, startOwnedRuntime } from '../../tools/spike/runtime/client.mjs';

test('parseSseFrame reads event, id, and JSON data', () => {
  const frame = parseSseFrame('id: 42\nevent: turn.completed\ndata: {"seq":42,"turn_id":"turn_1"}');
  assert.equal(frame.id, '42');
  assert.equal(frame.event, 'turn.completed');
  assert.deepEqual(frame.data, { seq: 42, turn_id: 'turn_1' });
});

test('parseSseFrame joins multi-line data and ignores comments', () => {
  const frame = parseSseFrame(': keepalive\nevent: item.delta\ndata: {"delta":"par",\ndata: "n":1}');
  assert.equal(frame.event, 'item.delta');
  assert.deepEqual(frame.data, { delta: 'par', n: 1 });
});

test('parseSseFrame tolerates malformed payloads without throwing', () => {
  const frame = parseSseFrame('event: unknown\ndata: not-json');
  assert.equal(frame.event, 'unknown');
  assert.deepEqual(frame.data, { raw: 'not-json' });
});

test('parseSseFrame returns null for an empty frame', () => {
  assert.equal(parseSseFrame(''), null);
  assert.equal(parseSseFrame(': comment only'), null);
});

test('RuntimeClient refuses a non-loopback base URL', () => {
  assert.throws(() => new RuntimeClient({ baseUrl: 'http://10.0.0.5:7878', token: 'abcdefgh' }), /non-loopback/);
  assert.throws(() => new RuntimeClient({ baseUrl: 'https://127.0.0.1:7878', token: 'abcdefgh' }), /non-loopback/);
});

test('RuntimeClient requires a real bearer token', () => {
  assert.throws(() => new RuntimeClient({ baseUrl: 'http://127.0.0.1:7878', token: '' }), /bearer token/);
  assert.throws(() => new RuntimeClient({ baseUrl: 'http://127.0.0.1:7878', token: 'short' }), /bearer token/);
});

test('startOwnedRuntime refuses an invalid port before spawning', async () => {
  await assert.rejects(
    startOwnedRuntime({ executable: 'codewhale', workspace: '.', port: 80, token: 'abcdefgh' }),
    /invalid port/,
  );
});

test('startOwnedRuntime keeps the token out of argv', async () => {
  // A failing spawn is fine: this only inspects the attempted arguments.
  const calls = [];
  const spawnImpl = (executable, args) => {
    calls.push({ executable, args });
    throw new Error('stop-after-capture');
  };
  await assert.rejects(
    startOwnedRuntime({ executable: 'codewhale', workspace: '.', port: 7900, token: 'super-secret-token', spawnImpl }),
  );
  assert.equal(calls.length, 1);
  assert.ok(!calls[0].args.join(' ').includes('super-secret-token'));
  assert.ok(calls[0].args.includes('--http'));
});
