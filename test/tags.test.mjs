import test from 'node:test';
import assert from 'node:assert/strict';
import { run, runAsync, startServer } from './helpers.mjs';
import { buildTags, normalizeTag } from '../lib/util.js';
import { PING_TAG_MAX_LENGTH, PING_TAGS_MAX } from '../lib/constants.js';
import { parseArgs, parseListenArgs, parseLiveArgs } from '../lib/parser.js';

// Ping tags: `ping --tag` and `live start --tag` label a ping, `listen --tag`
// hears only pings carrying one. The rule mirrors PingTagRules in laravel.

const HOOK = 'http://127.0.0.1:1/hook';
const TAG_32 = 'a'.repeat(PING_TAG_MAX_LENGTH);

/** A stub that records each request's path, query and JSON body, and answers 200. */
async function recordingServer(reply = { success: true }) {
  const received = [];
  const { server, baseUrl } = await startServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const [path, query = ''] = req.url.split('?');
      received.push({ path, query: new URLSearchParams(query), body: body ? JSON.parse(body) : null });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(reply));
    });
  });
  return { server, baseUrl, received };
}

test('the tag flags are in the parsers', () => {
  assert.deepEqual(parseArgs(['--tag', 'a', '--tag', 'b']).tag, ['a', 'b']);
  assert.deepEqual(parseLiveArgs(['start', '--tag', 'a', '--tag', 'b']).tag, ['a', 'b']);
  assert.ok(parseArgs.flags.has('--tag'));
  assert.ok(parseLiveArgs.flags.has('--tag'));
  assert.ok(parseListenArgs.flags.has('--tag'));
});

test('normalizeTag and buildTags apply the server rule', () => {
  assert.equal(normalizeTag('  Deploy '), 'deploy');
  assert.equal(normalizeTag(TAG_32), TAG_32);
  assert.deepEqual(buildTags({}), undefined);
  assert.deepEqual(buildTags({ tag: ['Deploy ', 'deploy', 'prod_1'] }), ['deploy', 'prod_1']);
  const ten = Array.from({ length: PING_TAGS_MAX }, (_, i) => `t${i}`);
  assert.equal(buildTags({ tag: [...ten, 'T0'] }).length, PING_TAGS_MAX);
});

test('exit 2: ping --tag that breaks the rule', () => {
  for (const tag of ['bad tag', 'a.b', 'café', '-lead', '_lead', `${TAG_32}a`, '', '   ']) {
    const { status, stderr } = run(['ping', '-w', HOOK, '-m', 'hi', '--tag', tag]);
    assert.equal(status, 2, JSON.stringify(tag));
    assert.match(stderr, /--tag must be 1 to 32 characters/);
  }
});

test('exit 2: more than 10 distinct --tag flags', () => {
  const flags = Array.from({ length: 11 }, (_, i) => ['--tag', `t${i}`]).flat();
  const { status, stderr } = run(['ping', '-w', HOOK, '-m', 'hi', ...flags]);
  assert.equal(status, 2);
  assert.match(stderr, /--tag may be given at most 10 times/);
});

test('exit 2: --tag needs a value', () => {
  const { status, stderr } = run(['ping', '-w', HOOK, '-m', 'hi', '--tag']);
  assert.equal(status, 2);
  assert.match(stderr, /option --tag needs a value/);
});

test('ping --tag sends the normalized tags in a webhook ping', async () => {
  const { server, baseUrl, received } = await recordingServer();
  try {
    const { status, stderr } = await runAsync(['ping', '-w', `${baseUrl}/hook`, '-m', 'hi', '--tag', 'Deploy', '--tag', ' deploy ', '--tag', 'prod']);
    assert.equal(status, 0, stderr);
    assert.deepEqual(received[0].body.tags, ['deploy', 'prod']);
  } finally {
    server.close();
  }
});

test('ping --tag sends the tags on the agent-token route', async () => {
  const { server, baseUrl, received } = await recordingServer({ id: 'n1' });
  try {
    const { status, stderr } = await runAsync(['ping', '--token', 'tok', '--room', 'AB12', '--api', baseUrl, '-m', 'hi', '--tag', 'on_call']);
    assert.equal(status, 0, stderr);
    assert.equal(received[0].path, '/api/agent/rooms/AB12/notifications');
    assert.deepEqual(received[0].body.tags, ['on_call']);
  } finally {
    server.close();
  }
});

test('a ping without --tag sends no tags key', async () => {
  const { server, baseUrl, received } = await recordingServer();
  try {
    const { status } = await runAsync(['ping', '-w', `${baseUrl}/hook`, '-m', 'hi']);
    assert.equal(status, 0);
    assert.equal('tags' in received[0].body, false);
  } finally {
    server.close();
  }
});

test('live start --tag labels the stream, on a webhook and on the agent route', async () => {
  const { server, baseUrl, received } = await recordingServer({ state: 'started' });
  try {
    const viaWebhook = await runAsync(['live', 'start', '-c', 'run-1', '-m', 'Building', '-w', `${baseUrl}/hook`, '--tag', 'Nightly', '--tag', 'ci']);
    assert.equal(viaWebhook.status, 0, viaWebhook.stderr);
    assert.deepEqual(received[0].body.tags, ['nightly', 'ci']);

    const viaToken = await runAsync(['live', 'start', '-c', 'run-2', '--token', 'tok', '--room', 'AB12', '--api', baseUrl, '--tag', 'ci']);
    assert.equal(viaToken.status, 0, viaToken.stderr);
    assert.equal(received[1].path, '/api/agent/rooms/AB12/live');
    assert.deepEqual(received[1].body.tags, ['ci']);
  } finally {
    server.close();
  }
});

test('exit 2: live refuses --tag after the stream exists, and a bad one at start', () => {
  for (const sub of ['update', 'end', 'get']) {
    const { status, stderr } = run(['live', sub, '-c', 'run-1', '--tag', 'x']);
    assert.equal(status, 2, sub);
    assert.match(stderr, /--tag is fixed at stream creation; pass it to "live start"/);
  }
  const claim = run(['live', 'claim', '-n', '0197c3a0-0000-7000-8000-000000000001', '--tag', 'x']);
  assert.equal(claim.status, 2);
  assert.match(claim.stderr, /--tag is not supported by live claim/);

  const bad = run(['live', 'start', '-c', 'run-1', '-w', HOOK, '--tag', 'bad tag']);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /--tag must be 1 to 32 characters/);
});

test('listen --tag filters the head read and every poll', async () => {
  const { server, baseUrl, received } = await recordingServer({
    notifications: [{ id: 'n2', message: 'Deploy shipped', tags: ['deploy'], room: { code: 'AB12', name: 'Ops' } }],
    cursor: 'n2',
  });
  try {
    const { status, stdout, stderr } = await runAsync(['listen', '--once', '--tag', 'Deploy', '--timeout', '0', '--token', 'tok', '--api', baseUrl]);
    assert.equal(status, 0, stderr);
    assert.match(stdout, /Deploy shipped/);
    assert.ok(received.length >= 2);
    for (const request of received) {
      assert.equal(request.path, '/api/agent/notifications/wait');
      assert.equal(request.query.get('tag'), 'deploy');
    }
  } finally {
    server.close();
  }
});

test('listen without --tag sends no tag', async () => {
  const { server, baseUrl, received } = await recordingServer({ notifications: [], cursor: 'n1' });
  try {
    const { status } = await runAsync(['listen', '--once', '--timeout', '0', '--token', 'tok', '--api', baseUrl]);
    assert.equal(status, 0);
    assert.ok(received.every((request) => !request.query.has('tag')));
  } finally {
    server.close();
  }
});

test('exit 2: listen filters by one tag, and refuses a bad one', () => {
  const two = run(['listen', '--tag', 'a', '--tag', 'b', '--token', 'tok']);
  assert.equal(two.status, 2);
  assert.match(two.stderr, /listen filters by one --tag/);

  const bad = run(['listen', '--tag', 'bad tag', '--token', 'tok']);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /--tag must be 1 to 32 characters/);
});

test('the help for ping, live and listen documents --tag', () => {
  for (const command of ['ping', 'live', 'listen']) {
    const { status, stdout } = run([command, '-h']);
    assert.equal(status, 0);
    assert.match(stdout, /--tag <tag>/, command);
  }
});
