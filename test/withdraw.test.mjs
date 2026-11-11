import test from 'node:test';
import assert from 'node:assert/strict';
import { run, runAsync, startServer } from './helpers.mjs';
import { parseArgs } from '../lib/parser.js';

// Taking back a ping you sent: `ping --withdraw <id>` (agent token only). The
// rules mirror PingWithdrawal and PingWithdrawalService in laravel.

const HOOK = 'http://127.0.0.1:1/hook';
const ID = '0197c3a0-0000-7000-8000-000000000001';
const TOKEN_ARGS = ['--token', 'tok', '--room', 'AB12'];

/** A stub that records method, path and JSON body of each request. */
async function recordingServer(reply = { id: ID }, status = 200) {
  const received = [];
  const { server, baseUrl } = await startServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ method: req.method, path: req.url, body: body ? JSON.parse(body) : null, headers: req.headers });
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(reply));
    });
  });
  return { server, baseUrl, received };
}

test('the withdraw flag is in the ping parser', () => {
  const args = parseArgs(['--withdraw', ID]);
  assert.equal(args.withdraw, ID);
  assert.ok(parseArgs.flags.has('--withdraw'));
  // A flag with no value is a usage error, not a send.
  assert.equal(run(['ping', ...TOKEN_ARGS, '--withdraw']).status, 2);
});

test('ping --withdraw POSTs to the ping\'s withdraw route and prints "ping withdrawn"', async () => {
  const { server, baseUrl, received } = await recordingServer({ id: ID, message: 'Deploy started', withdrawn_at: '2026-11-11T12:00:00.000000Z' });
  try {
    const { status, stdout, stderr } = await runAsync(['ping', ...TOKEN_ARGS, '--api', baseUrl, '--withdraw', ID]);
    assert.equal(status, 0, stderr);
    assert.match(stdout, /ping withdrawn/);
    assert.doesNotMatch(stdout, /ping sent|ping replaced/);
    assert.equal(received.length, 1);
    assert.equal(received[0].method, 'POST');
    assert.equal(received[0].path, `/api/agent/rooms/AB12/notifications/${ID}/withdraw`);
    assert.deepEqual(received[0].body, {});
    assert.equal(received[0].headers.authorization, 'Bearer tok');
    assert.equal('idempotency-key' in received[0].headers, false);
  } finally {
    server.close();
  }
});

test('ping --withdraw --json prints the API answer', async () => {
  const reply = { id: ID, withdrawn_at: '2026-11-11T12:00:00.000000Z' };
  const { server, baseUrl } = await recordingServer(reply);
  try {
    const { status, stdout, stderr } = await runAsync(['ping', ...TOKEN_ARGS, '--api', baseUrl, '--withdraw', ID, '--json']);
    assert.equal(status, 0, stderr);
    assert.deepEqual(JSON.parse(stdout), reply);
  } finally {
    server.close();
  }
});

test('exit 2: --withdraw needs an agent token, not a webhook', () => {
  const viaWebhook = run(['ping', '-w', HOOK, '--withdraw', ID]);
  assert.equal(viaWebhook.status, 2);
  assert.match(viaWebhook.stderr, /--withdraw requires an agent token/);

  const noTransport = run(['ping', '--withdraw', ID]);
  assert.equal(noTransport.status, 2);
  assert.match(noTransport.stderr, /--withdraw requires an agent token/);

  const both = run(['ping', ...TOKEN_ARGS, '-w', HOOK, '--withdraw', ID]);
  assert.equal(both.status, 2);
});

test('exit 2: --withdraw refuses every other ping option, so nothing is silently dropped', () => {
  const others = [
    ['--message', 'hi'], ['--title', 'Deploy'], ['--action', '3'], ['--data', '{"a":1}'], ['--url', 'https://example.com'],
    ['--location', '25.2,55.3'], ['--item', 'milk'], ['--urgent'], ['--require-ack'], ['--ack-mode', 'all'],
    ['--ack-timeout', '120'], ['--attach', '/tmp/none.md'], ['--tag', 'x'], ['--replace', ID],
    ['--replace-key', 'k'], ['--idempotency-key', 'k'],
  ];
  for (const flags of others) {
    const { status, stderr } = run(['ping', ...TOKEN_ARGS, '--withdraw', ID, ...flags]);
    assert.equal(status, 2, flags.join(' '));
    assert.match(stderr, new RegExp(`${flags[0]} cannot be used with --withdraw`));
  }
});

test('exit 2: --withdraw needs a room and a usable id', () => {
  const noRoom = run(['ping', '--token', 'tok', '--withdraw', ID]);
  assert.equal(noRoom.status, 2);
  assert.match(noRoom.stderr, /--room is required/);

  for (const id of ['', '.', '..']) {
    const { status, stderr } = run(['ping', ...TOKEN_ARGS, '--withdraw', id]);
    assert.equal(status, 2, JSON.stringify(id));
    assert.match(stderr, /ping id may not be empty/);
  }
});

test('ping --withdraw needs no --message', () => {
  const { status, stderr } = run(['ping', ...TOKEN_ARGS, '--api', 'http://127.0.0.1:1', '--withdraw', ID]);
  // It got as far as the network (a refused connection), never to a message check.
  assert.doesNotMatch(stderr, /a --message is required/);
  assert.notEqual(status, 2);
});

test('a refused withdraw names the API code and explains a missing ping', async () => {
  const missing = await recordingServer({ code: 'notification_not_found', message: 'No Ping with that id in this room.' }, 404);
  const switchedOff = await recordingServer({ message: 'Resource not found.' }, 404);
  const closed = await recordingServer({ code: 'withdraw_window_closed', message: 'A Ping can only be withdrawn within 24 hours of sending it.' }, 409);
  const notOwner = await recordingServer({ code: 'not_ping_owner', message: 'Only the agent that sent a Ping can withdraw it.' }, 403);
  try {
    const gone = await runAsync(['ping', ...TOKEN_ARGS, '--api', missing.baseUrl, '--withdraw', ID]);
    assert.notEqual(gone.status, 0);
    assert.match(gone.stderr, /withdraw failed/);
    assert.match(gone.stderr, /No ping with that id in room AB12/);

    const off = await runAsync(['ping', ...TOKEN_ARGS, '--api', switchedOff.baseUrl, '--withdraw', ID]);
    assert.notEqual(off.status, 0);
    assert.match(off.stderr, /withdrawing a ping switched on/);

    const old = await runAsync(['ping', ...TOKEN_ARGS, '--api', closed.baseUrl, '--withdraw', ID]);
    assert.notEqual(old.status, 0);
    assert.match(old.stderr, /withdraw_window_closed|24 hours/);

    const other = await runAsync(['ping', ...TOKEN_ARGS, '--api', notOwner.baseUrl, '--withdraw', ID]);
    assert.notEqual(other.status, 0);
    assert.match(other.stderr, /not_ping_owner|can withdraw it/);
  } finally {
    for (const s of [missing, switchedOff, closed, notOwner]) s.server.close();
  }
});

test('an ordinary send is untouched: no --withdraw key, "ping sent"', async () => {
  const { server, baseUrl, received } = await recordingServer({ success: true });
  try {
    const { status, stdout } = await runAsync(['ping', '-w', `${baseUrl}/hook`, '-m', 'hi']);
    assert.equal(status, 0);
    assert.match(stdout, /ping sent/);
    assert.equal(received[0].path, '/hook');
  } finally {
    server.close();
  }
});
