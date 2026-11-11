import test from 'node:test';
import assert from 'node:assert/strict';
import { run, runAsync, startServer } from './helpers.mjs';
import { requireReplaceKey } from '../lib/util.js';
import { parseArgs } from '../lib/parser.js';

// Replacing a ping you sent: `ping --replace <id>` (agent token) and
// `ping --replace-key <key>` (agent token or incoming webhook). The rules mirror
// PingReplacement and PingReplacementService in laravel.

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

test('the replace flags are in the ping parser', () => {
  const args = parseArgs(['--replace', ID, '--replace-key', 'k']);
  assert.equal(args.replace, ID);
  assert.equal(args.replace_key, 'k');
  assert.ok(parseArgs.flags.has('--replace'));
  assert.ok(parseArgs.flags.has('--replace-key'));
  assert.equal(run(['ping', '-w', HOOK, '-m', 'hi', '--replace']).status, 2);
});

test('requireReplaceKey applies the server rule', () => {
  assert.equal(requireReplaceKey('build.41_prod:eu-1'), 'build.41_prod:eu-1');
  assert.equal(requireReplaceKey('x'.repeat(64)), 'x'.repeat(64));
});

test('exit 2: --replace-key that breaks the rule', () => {
  for (const key of ['', 'has space', 'café', 'a/b', 'x'.repeat(65)]) {
    const { status, stderr } = run(['ping', '-w', HOOK, '-m', 'hi', '--replace-key', key]);
    assert.equal(status, 2, JSON.stringify(key));
    assert.match(stderr, /--replace-key must be 1 to 64 characters/);
  }
});

test('ping --replace PUTs the new text to the ping and prints "ping replaced"', async () => {
  const { server, baseUrl, received } = await recordingServer({ id: ID, message: 'Build 41: green', edited_at: '2026-11-11T12:00:00.000000Z' });
  try {
    const { status, stdout, stderr } = await runAsync(['ping', ...TOKEN_ARGS, '--api', baseUrl, '-m', 'Build 41: green', '--replace', ID]);
    assert.equal(status, 0, stderr);
    assert.match(stdout, /ping replaced/);
    assert.equal(received.length, 1);
    assert.equal(received[0].method, 'PUT');
    assert.equal(received[0].path, `/api/agent/rooms/AB12/notifications/${ID}`);
    // Title and data were not given, so they are not sent: the server keeps them.
    assert.deepEqual(received[0].body, { message: 'Build 41: green' });
    assert.equal(received[0].headers.authorization, 'Bearer tok');
    assert.equal('idempotency-key' in received[0].headers, false);
  } finally {
    server.close();
  }
});

test('ping --replace sends --title and the data flags, and an empty --title clears the title', async () => {
  const { server, baseUrl, received } = await recordingServer();
  try {
    const base = ['ping', ...TOKEN_ARGS, '--api', baseUrl, '-m', 'm', '--replace', ID];
    const titled = await runAsync([...base, '-t', 'Deploy', '-d', '{"build":41}']);
    assert.equal(titled.status, 0, titled.stderr);
    const cleared = await runAsync([...base, '-t', '']);
    assert.equal(cleared.status, 0, cleared.stderr);
    const link = await runAsync([...base, '--url', 'https://ci.example.com/41', '--button-label', 'Open']);
    assert.equal(link.status, 0, link.stderr);

    assert.deepEqual(received[0].body, { message: 'm', title: 'Deploy', data: { build: 41 } });
    assert.deepEqual(received[1].body, { message: 'm', title: '' });
    assert.deepEqual(received[2].body, { message: 'm', data: { url: 'https://ci.example.com/41', button_label: 'Open' } });
  } finally {
    server.close();
  }
});

test('exit 2: --replace needs an agent token, not a webhook', () => {
  const viaWebhook = run(['ping', '-w', HOOK, '-m', 'hi', '--replace', ID]);
  assert.equal(viaWebhook.status, 2);
  assert.match(viaWebhook.stderr, /--replace requires an agent token/);

  const noTransport = run(['ping', '-m', 'hi', '--replace', ID]);
  assert.equal(noTransport.status, 2);
  assert.match(noTransport.stderr, /--replace requires an agent token/);

  const both = run(['ping', ...TOKEN_ARGS, '-w', HOOK, '-m', 'hi', '--replace', ID]);
  assert.equal(both.status, 2);
});

test('exit 2: --replace refuses everything a replacement cannot change', () => {
  const unsupported = [
    ['--action', '3'], ['--require-ack'], ['--ack-mode', 'all'], ['--ack-timeout', '120'], ['--urgent'],
    ['--attach', '/tmp/none.md'], ['--tag', 'x'], ['--item', 'milk'], ['--idempotency-key', 'k'],
  ];
  for (const flags of unsupported) {
    const { status, stderr } = run(['ping', ...TOKEN_ARGS, '-m', 'hi', '--replace', ID, ...flags]);
    assert.equal(status, 2, flags.join(' '));
    assert.match(stderr, new RegExp(`${flags[0]} cannot be used with --replace`));
  }
});

test('exit 2: --replace and --replace-key name two different things', () => {
  const { status, stderr } = run(['ping', ...TOKEN_ARGS, '-m', 'hi', '--replace', ID, '--replace-key', 'k']);
  assert.equal(status, 2);
  assert.match(stderr, /--replace and --replace-key cannot be combined/);
});

test('exit 2: --replace needs a message and a usable id', () => {
  const noMessage = run(['ping', ...TOKEN_ARGS, '--replace', ID]);
  assert.equal(noMessage.status, 2);
  assert.match(noMessage.stderr, /a --message is required/);

  for (const id of ['', '.', '..']) {
    const { status, stderr } = run(['ping', ...TOKEN_ARGS, '-m', 'hi', '--replace', id]);
    assert.equal(status, 2, JSON.stringify(id));
    assert.match(stderr, /ping id may not be empty/);
  }
});

test('ping --replace-key sends replace_key on the agent-token route and on a webhook', async () => {
  const { server, baseUrl, received } = await recordingServer({ id: ID });
  try {
    const viaToken = await runAsync(['ping', ...TOKEN_ARGS, '--api', baseUrl, '-m', 'hi', '--replace-key', 'build:41']);
    assert.equal(viaToken.status, 0, viaToken.stderr);
    assert.match(viaToken.stdout, /ping sent/);
    assert.equal(received[0].method, 'POST');
    assert.equal(received[0].path, '/api/agent/rooms/AB12/notifications');
    assert.equal(received[0].body.replace_key, 'build:41');

    const viaWebhook = await runAsync(['ping', '-w', `${baseUrl}/hook`, '-m', 'hi', '--replace-key', 'build:41']);
    assert.equal(viaWebhook.status, 0, viaWebhook.stderr);
    assert.equal(received[1].path, '/hook');
    assert.equal(received[1].body.replace_key, 'build:41');
  } finally {
    server.close();
  }
});

test('a send that replaced the earlier ping prints "ping replaced", on both routes', async () => {
  const agent = await recordingServer({ id: ID, replaced: true });
  const hook = await recordingServer({ success: true, notification_id: ID, replaced: true });
  try {
    const viaToken = await runAsync(['ping', ...TOKEN_ARGS, '--api', agent.baseUrl, '-m', 'hi', '--replace-key', 'k']);
    assert.equal(viaToken.status, 0, viaToken.stderr);
    assert.match(viaToken.stdout, /ping replaced/);
    assert.doesNotMatch(viaToken.stdout, /ping sent/);

    const viaWebhook = await runAsync(['ping', '-w', `${hook.baseUrl}/hook`, '-m', 'hi', '--replace-key', 'k']);
    assert.equal(viaWebhook.status, 0, viaWebhook.stderr);
    assert.match(viaWebhook.stdout, /ping replaced/);
  } finally {
    agent.server.close();
    hook.server.close();
  }
});

test('a ping without a replace flag sends no replace_key and still says "ping sent"', async () => {
  const { server, baseUrl, received } = await recordingServer({ success: true });
  try {
    const { status, stdout } = await runAsync(['ping', '-w', `${baseUrl}/hook`, '-m', 'hi']);
    assert.equal(status, 0);
    assert.match(stdout, /ping sent/);
    assert.equal('replace_key' in received[0].body, false);
  } finally {
    server.close();
  }
});

test('--replace-key works with --idempotency-key, which a replacement itself cannot take', async () => {
  const { server, baseUrl, received } = await recordingServer({ success: true });
  try {
    const { status, stderr } = await runAsync(['ping', '-w', `${baseUrl}/hook`, '-m', 'hi', '--replace-key', 'k', '--idempotency-key', 'run-1']);
    assert.equal(status, 0, stderr);
    assert.equal(received[0].headers['idempotency-key'], 'run-1');
    assert.equal(received[0].body.replace_key, 'k');
  } finally {
    server.close();
  }
});

test('every replace refusal prints the API code and message, and exits 1', async () => {
  const refusals = [
    [403, 'not_ping_owner', /Only the agent credential that sent a ping can replace it/],
    [422, 'unsupported_ack', /cannot be replaced/],
    [409, 'replace_window_closed', /24 hours/],
    [409, 'replace_limit_reached', /at most 20 times/],
  ];
  for (const [status, code, pattern] of refusals) {
    const { server, baseUrl } = await recordingServer({ code, message: `A ping cannot be replaced (${code}).` }, status);
    try {
      const { status: exit, stderr } = await runAsync(['ping', ...TOKEN_ARGS, '--api', baseUrl, '-m', 'hi', '--replace', ID]);
      assert.equal(exit, 1, code);
      assert.match(stderr, /delivery failed/);
      assert.match(stderr, new RegExp(code));
      assert.match(stderr, pattern);
    } finally {
      server.close();
    }
  }
});

test('a replace 404 tells a missing ping from a route that did not match', async () => {
  const missing = await recordingServer({ code: 'notification_not_found', message: 'No Ping with that id in this room.' }, 404);
  const off = await recordingServer({ message: 'Resource not found.' }, 404);
  try {
    const gone = await runAsync(['ping', ...TOKEN_ARGS, '--api', missing.baseUrl, '-m', 'hi', '--replace', ID]);
    assert.equal(gone.status, 1);
    assert.match(gone.stderr, /No ping with that id in room AB12/);
    assert.doesNotMatch(gone.stderr, /No room has the code/);

    const unknown = await runAsync(['ping', ...TOKEN_ARGS, '--api', off.baseUrl, '-m', 'hi', '--replace', ID]);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /No room has the code AB12/);
    assert.match(unknown.stderr, /may not have replacing a ping switched on yet/);
  } finally {
    missing.server.close();
    off.server.close();
  }
});

test('the help for ping documents --replace and --replace-key', () => {
  const { status, stdout } = run(['ping', '-h']);
  assert.equal(status, 0);
  assert.match(stdout, /--replace <id>/);
  assert.match(stdout, /--replace-key <k>/);
});
