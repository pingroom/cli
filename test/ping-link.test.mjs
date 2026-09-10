import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { pingWebUrl } from '../lib/ping-link.js';

const id = '019e79be-3acd-73b6-b440-8ab0a7bffed8';
const expected = `https://pingroom.io/app/notifications/${id}`;

test('web links accept both agent and webhook receipts', () => {
  assert.equal(pingWebUrl({ id }, 'https://api.pingroom.io'), expected);
  assert.equal(pingWebUrl({ notification_id: id }, 'https://api.pingroom.io/webhooks/room/secret'), expected);
});

test('custom servers and lookalike origins never link into the hosted web app', () => {
  for (const api of ['http://api.pingroom.io', 'https://api.pingroom.io:444', 'https://api.pingroom.io.evil.test', 'https://custom.example.com', 'http://127.0.0.1:8000', 'invalid']) {
    assert.equal(pingWebUrl({ id }, api), null);
  }
});

test('missing or malformed IDs leave the original success output available', () => {
  for (const response of [null, {}, { id: 42 }, { id: '' }, { id: '../room/secret' }, { id: `${id}\nmalicious` }, { id: `\x1b]8;;https://evil.test\x07${id}` }, { id: { value: id } }]) {
    assert.equal(pingWebUrl(response, 'https://api.pingroom.io'), null);
  }
});

test('ping prints a web link after acceptance and preserves JSON and error output', () => {
  const moduleUrl = new URL('../lib/commands/ping.js', import.meta.url).href;
  const cases = [
    { receipt: { id }, args: {}, status: 201, output: `ping sent ✅\nView on web: ${expected}\n` },
    { receipt: { notification_id: id }, args: { webhook: 'https://api.pingroom.io/webhooks/room/secret' }, status: 200, output: `ping sent ✅\nView on web: ${expected}\n` },
    { receipt: { id }, args: { json: true }, status: 201, output: `${JSON.stringify({ id })}\n` },
    { receipt: { success: true }, args: {}, status: 200, output: 'ping sent ✅\n' },
    { receipt: { id, message: 'Denied' }, args: {}, status: 403, output: '', exit: 1 },
  ];
  for (const c of cases) {
    const script = `
      import { ping } from ${JSON.stringify(moduleUrl)};
      globalThis.fetch = async () => new Response(${JSON.stringify(JSON.stringify(c.receipt))}, { status: ${c.status} });
      await ping(${JSON.stringify({ message: 'hello', token: 'test', room: 'room', api: 'https://api.pingroom.io', ...c.args })});
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: { PATH: process.env.PATH } });
    assert.equal(result.status, c.exit ?? 0, result.stderr);
    assert.equal(result.stdout, c.output);
  }
});
