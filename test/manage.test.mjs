import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLI, baseEnv, run, runAsync, startServer, questionServer } from './helpers.mjs';
import { COMMAND_HELP_SECTIONS, HELP_SHARED_COMMAND } from '../lib/help.js';
import {
  MANAGE_FLAGS, parseActionsArgs, parseApprovalArgs, parseAttachmentArgs, parseMetricArgs, parseRoomsArgs, parseWebhooksArgs,
} from '../lib/parser.js';
import { CliExit } from '../lib/util.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Management nouns: rooms / webhooks / actions / approval / attachment.

test('management commands appear in the top-level help', () => {
  const { status, stdout } = run(['--help']);
  assert.equal(status, 0);
  for (const noun of ['rooms', 'webhooks', 'actions', 'approval', 'attachment', 'metric']) {
    assert.match(stdout, new RegExp(`^  ${noun}`, 'm'));
  }
});

test('each management noun prints its own help', () => {
  for (const [noun, marker] of [
    ['rooms', /rooms create -n <name>/],
    ['webhooks', /Prints the secret trigger URL once/],
    ['actions', /actions set <1-16>/],
    ['approval', /exit 0 approve · 4 deny/],
    ['attachment', /attachment get <id>/],
    ['metric', /metric set <room> <key> <value>/],
  ]) {
    const { status, stdout } = run([noun, '--help']);
    assert.equal(status, 0, `${noun} --help exits 0`);
    assert.match(stdout, marker, `${noun} help names its verbs`);
  }
});

test('rooms icons prints the catalog grouped by category', async () => {
  const { server, baseUrl, received } = await questionServer({
    'GET /api/agent/room-icons': () => ({
      status: 200,
      body: {
        version: 4,
        base_url: 'https://api.example/assets/room-icons/v3',
        categories: [
          { id: 'work', label: 'Work', icons: ['briefcase', 'terminal'] },
          { id: 'home', label: 'Home', icons: ['door'] },
        ],
        icons: {},
      },
    }),
  });
  try {
    const { status, stdout } = await runAsync([
      'rooms', 'icons', '--token', 'tok', '--api', baseUrl,
    ]);
    assert.equal(status, 0);
    assert.match(stdout, /Work: briefcase terminal/);
    assert.match(stdout, /Home: door/);
    assert.equal(received[0].auth, 'Bearer tok');
  } finally {
    server.close();
  }
});

test('rooms create without an icon points at the catalog command', () => {
  const { status, stderr } = run(['rooms', 'create', '-n', 'Deploys', '--token', 'x'.repeat(40)]);
  assert.equal(status, 2);
  assert.match(stderr, /pingroom rooms icons/);
});

test('management nouns fail as usage errors without a sub-command or token', () => {
  // Unknown sub-command → usage, before any credential is consulted.
  const bad = run(['rooms', 'destroy']);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /usage: pingroom rooms <list\|get\|create\|join\|icons>/);

  // Known sub-command with no credential → the shared agent-token usage error.
  const noToken = run(['rooms', 'list']);
  assert.equal(noToken.status, 2);
  assert.match(noToken.stderr, /an agent token is required/);

  // Room-scoped nouns also demand --room.
  const noRoom = run(['webhooks', 'list', '--token', 'x'.repeat(40)]);
  assert.equal(noRoom.status, 2);
  assert.match(noRoom.stderr, /--room is required/);
});

// --- management output reads the server's actual response shape -------------
//
// The agent REST routes answer with the record FLAT (WebhookController::store
// returns `[...$webhook->toArray(), 'webhook_url' => …]`, RoomMemberController
// returns the room itself). Reading a nested `json.webhook` / `json.room` that
// the server never sends printed a bare "created" and swallowed the trigger
// URL — the one credential `webhooks create` exists to hand over.

test('rooms join sends the protected-room password and preserves server failures', async () => {
  const { server, baseUrl, received } = await questionServer({
    'POST /api/agent/rooms/join': (body) => JSON.parse(body).password === 'room secret'
      ? { body: { invite_code: 'ab12cd', name: 'Deploys' } }
      : { status: 403, body: { code: 'password_required', message: 'Password required' } },
  });
  try {
    const base = ['rooms', 'join', 'ab12cd', '--token', 'test-token', '--api', baseUrl];
    const missing = await runAsync(base);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /Password required|password_required/);
    assert.deepEqual(JSON.parse(received[0].body), { invite_code: 'ab12cd' });

    const joined = await runAsync([...base, '--password', 'room secret']);
    assert.equal(joined.status, 0, joined.stderr);
    assert.match(joined.stdout, /joined Deploys/);
    assert.deepEqual(JSON.parse(received[1].body), { invite_code: 'ab12cd', password: 'room secret' });
    assert.doesNotMatch(joined.stdout + joined.stderr, /room secret/);
  } finally {
    server.close();
  }
});

test('rooms get and rooms join send the plain code, and a 404 says no room has it', async () => {
  const requests = [];
  const { server, baseUrl } = await startServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, body });
      if (req.method === 'GET' && req.url.endsWith('/NOPE00NOPE00')) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'Resource not found.' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ invite_code: 'J2YL5X5NDTUO', name: 'Deploys' }));
    });
  });
  try {
    const base = ['--token', 'x'.repeat(40), '--api', baseUrl];
    const got = await runAsync(['rooms', 'get', 'J2YL5X-5NDTUO', ...base]);
    assert.equal(got.status, 0, got.stderr);
    const joined = await runAsync(['rooms', 'join', 'J2YL5X 5NDTUO', ...base]);
    assert.equal(joined.status, 0, joined.stderr);
    const link = await runAsync(['rooms', 'join', 'https://pgr.link/j/J2YL5X-5NDTUO', ...base]);
    assert.equal(link.status, 0, link.stderr);
    assert.equal(requests[0].url, '/api/agent/rooms/J2YL5X5NDTUO');
    assert.deepEqual(requests.slice(1).map((r) => JSON.parse(r.body)), [
      { invite_code: 'J2YL5X5NDTUO' }, { invite_code: 'J2YL5X5NDTUO' },
    ]);

    const missing = await runAsync(['rooms', 'get', 'NOPE00-NOPE00', ...base]);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /No room has the code NOPE00NOPE00\./);
    assert.match(missing.stderr, /pingroom rooms list/);
  } finally {
    server.close();
  }
});

test('webhooks create prints the flat trigger url the server returns', async () => {
  const { server, baseUrl } = await startServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'wh-1',
        name: 'Deploy',
        enabled: true,
        webhook_url: `${baseUrl}/api/webhooks/ab12cd/s3cr3t`,
      }));
    });
  });
  try {
    const { status, stdout } = await runAsync([
      'webhooks', 'create', '--name', 'Deploy',
      '--room', 'ab12cd', '--token', 'x'.repeat(40), '--api', baseUrl,
    ]);
    assert.equal(status, 0);
    assert.match(stdout, /created wh-1/);
    assert.match(stdout, /\/api\/webhooks\/ab12cd\/s3cr3t/);
  } finally {
    server.close();
  }
});

test('rooms join prints the joined room name from the flat response', async () => {
  const { server, baseUrl } = await startServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'room-1', invite_code: 'ab12cd', name: 'Deploy Alerts' }));
    });
  });
  try {
    const { status, stdout } = await runAsync([
      'rooms', 'join', 'ab12cd', '--token', 'x'.repeat(40), '--api', baseUrl,
    ]);
    assert.equal(status, 0);
    assert.match(stdout, /joined Deploy Alerts/);
  } finally {
    server.close();
  }
});

// The ordinary rooms:write scope creates a MINIMAL private room — the server
// marks `description` prohibited there (AgentRoomScopeIsolationTest pins it as
// an administrative field) and answers 422. Fail with a usage error instead of
// posting a request that cannot succeed.
test('rooms create refuses --description on a private room', () => {
  const { status, stderr } = run([
    'rooms', 'create', '-n', 'Deploys', '--icon', 'bell', '--color', '#e33122',
    '--description', 'CI alerts', '--token', 'x'.repeat(40),
  ]);
  assert.equal(status, 2);
  assert.match(stderr, /--description is only accepted on a public room/);
});

test('rooms create sends the public-room location trio together or not at all', async () => {
  const { server, baseUrl, received } = await questionServer({
    'POST /api/agent/rooms/public': () => ({ body: { id: 'room-1', invite_code: 'ab12cd', name: 'Meetup' } }),
  });
  try {
    const { status, stderr } = await runAsync([
      'rooms', 'create', '-n', 'Meetup', '--icon', 'globe', '--color', '#0391fe', '--public', '--handle', 'meetup',
      '--location', '25.2048,55.2708', '--location-name', 'Dubai Mall', '--token', 'test-token', '--api', baseUrl,
    ]);
    assert.equal(status, 0, stderr);
    assert.deepEqual(JSON.parse(received[0].body), {
      name: 'Meetup', icon: 'globe', color: '#0391fe', handle: 'meetup',
      location_name: 'Dubai Mall', location_latitude: 25.2048, location_longitude: 55.2708,
    });
  } finally {
    server.close();
  }
  const partial = run(['rooms', 'create', '-n', 'Meetup', '--icon', 'globe', '--color', '#0391fe', '--public', '--handle', 'meetup',
    '--location', '25.2,55.3', '--token', 'x'.repeat(40)]);
  assert.equal(partial.status, 2);
  assert.match(partial.stderr, /--location <lat,lng> and --location-name <text> must be given together/);
  const privateRoom = run(['rooms', 'create', '-n', 'Deploys', '--icon', 'bell', '--color', '#e33122',
    '--location', '25.2,55.3', '--location-name', 'Dubai', '--token', 'x'.repeat(40)]);
  assert.equal(privateRoom.status, 2);
  assert.match(privateRoom.stderr, /only accepted on a public room/);
});

// --- server and member text cannot drive the terminal ------------------------

test('list commands strip terminal controls from room, webhook, action and handoff text', async () => {
  const evil = '\x1b]0;pwned\x07Ops\x1b[2J';
  const { server, baseUrl } = await questionServer({
    'GET /api/agent/rooms': () => ({ status: 200, body: { rooms: [{ invite_code: 'AB12\x1b[1m', name: evil, is_public: true }] } }),
    'GET /api/agent/room-icons': () => ({ status: 200, body: { categories: [{ label: evil, icons: ['bell\x1b[31m', 'globe'] }] } }),
    'POST /api/agent/rooms/join': () => ({ status: 200, body: { name: evil } }),
    'GET /api/agent/rooms/ab12cd/webhooks': () => ({ status: 200, body: { webhooks: [{ id: 'w1\x1b[2K', name: evil }] } }),
    'POST /api/agent/rooms/ab12cd/webhooks': () => ({ status: 201, body: { id: 'w2', webhook_url: 'https://api.example/w/\x1b[8msecret' } }),
    'GET /api/agent/rooms/ab12cd/actions': () => ({ status: 200, body: { actions: [{ action_number: 1, icon: '🚀\x1b[5m', label: evil, input_type: 'file\x07' }] } }),
    'GET /api/agent/handoffs': () => ({ status: 200, body: { handoffs: [{ id: 'h1', kind: 'question', state: 'answered\x1b[0m', prompt: evil, answer: { value: 'yes\x9b2J' } }] } }),
    'GET /api/agent/rooms/ab12cd/live/deploy-1': () => ({ status: 200, body: { state: 'running\x1b[2J' } }),
  });
  try {
    const common = ['--token', 'tok', '--api', baseUrl];
    for (const argv of [
      ['rooms', 'list'], ['rooms', 'icons'], ['rooms', 'join', 'ab12cd'],
      ['webhooks', 'list', '--room', 'ab12cd'], ['webhooks', 'create', '--room', 'ab12cd', '--name', 'CI'],
      ['actions', 'list', '--room', 'ab12cd'], ['handoffs', '--state', 'all'],
      ['live', 'get', '-c', 'deploy-1', '--room', 'ab12cd'],
    ]) {
      const { status, stdout, stderr } = await runAsync([...argv, ...common]);
      assert.equal(status, 0, `${argv.join(' ')}: ${stderr}`);
      // eslint-disable-next-line no-control-regex
      assert.doesNotMatch(stdout, /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/, `${argv.join(' ')} printed a control character`);
    }
    // --json is the raw response, unchanged.
    const raw = await runAsync(['rooms', 'list', '--json', ...common]);
    assert.equal(JSON.parse(raw.stdout).rooms[0].name, evil);
  } finally {
    server.close();
  }
});

const PTY_SKIP = process.platform === 'win32' ? 'POSIX terminals are unavailable on Windows'
  : (() => {
    const probe = spawnSync('python3', ['-c', 'import pty'], { timeout: 5000 });
    return probe.error || probe.status !== 0 ? 'Python 3 with stdlib pty is unavailable' : false;
  })();

/** Run the CLI with stdout on a pseudo-terminal; returns the exit code, stderr and terminal output. */
function runWithTtyStdout(args, env = {}) {
  const script = `
import json, os, pty, select, subprocess, sys
master, slave = pty.openpty()
p = subprocess.Popen(sys.argv[1:], stdin=subprocess.DEVNULL, stdout=slave, stderr=subprocess.PIPE)
os.close(slave)
out = b''
while True:
    r, _, _ = select.select([master], [], [], 0.2)
    if r:
        try:
            chunk = os.read(master, 65536)
        except OSError:
            break
        if not chunk:
            break
        out += chunk
    elif p.poll() is not None:
        break
err = p.stderr.read()
print(json.dumps({"code": p.wait(), "stderr": err.decode(), "tty": out.decode("latin-1")}))
`;
  return new Promise((resolve, reject) => {
    const child = spawn('python3', ['-c', script, process.execPath, CLI, ...args], { env: { ...baseEnv(), ...env } });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.on('error', reject);
    child.on('close', () => resolve(JSON.parse(out)));
  });
}

test('attachment get refuses to dump bytes into a terminal unless --out - asks for it', { skip: PTY_SKIP }, async () => {
  let downloads = 0;
  const { server, baseUrl } = await startServer((req, res) => {
    downloads += 1;
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.end('PK\x03\x04payload');
  });
  try {
    const refused = await runWithTtyStdout(['attachment', 'get', 'att-1', '--token', 'tok', '--api', baseUrl]);
    assert.equal(refused.code, 2, refused.stderr);
    assert.match(refused.stderr, /refusing to write attachment bytes to a terminal; use --out <path>, or --out -/);
    assert.equal(refused.tty, '');
    assert.equal(downloads, 0, 'refused before the download');

    const forced = await runWithTtyStdout(['attachment', 'get', 'att-1', '--out', '-', '--token', 'tok', '--api', baseUrl]);
    assert.equal(forced.code, 0, forced.stderr);
    assert.match(forced.tty, /payload/);
  } finally {
    server.close();
  }
});

test('attachment get still streams bytes into a pipe, and --out - means stdout', async () => {
  const { server, baseUrl } = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.end('binary-bytes');
  });
  try {
    for (const extra of [[], ['--out', '-']]) {
      const { status, stdout } = await runAsync(['attachment', 'get', 'att-1', ...extra, '--token', 'tok', '--api', baseUrl]);
      assert.equal(status, 0);
      assert.equal(stdout, 'binary-bytes');
    }
  } finally {
    server.close();
  }
});

// CL-02: `Number('two')` is NaN, which JSON.stringify writes as null, so these
// used to unbind a webhook's quick action and exit 0.
test('webhooks refuse a non-numeric --action, --cooldown or --enabled before sending anything', async () => {
  const { server, baseUrl, received } = await questionServer({
    'POST /api/agent/rooms/ab12cd/webhooks': () => ({ status: 201, body: { id: 'wh-1' } }),
    'PUT /api/agent/rooms/ab12cd/webhooks/wh-1': () => ({ status: 200, body: { id: 'wh-1' } }),
  });
  try {
    const base = ['--room', 'ab12cd', '--token', 'tok', '--api', baseUrl];
    for (const [flags, expected] of [
      [['--action', 'two'], /--action must be an integer 1–16/],
      [['--action', '2a'], /--action must be an integer 1–16/],
      [['--action', '#2'], /--action must be an integer 1–16/],
      [['--action', '0'], /--action must be an integer 1–16/],
      [['--action', '17'], /--action must be an integer 1–16/],
      [['--cooldown', 'soon'], /--cooldown must be a number/],
      [['--cooldown', '61'], /--cooldown must be at most 60/],
      [['--cooldown', '1.5'], /--cooldown must be an integer/],
      [['--enabled', 'maybe'], /--enabled must be true or false/],
      [['--enabled', ''], /--enabled must be true or false/],
    ]) {
      for (const verb of [['update', 'wh-1'], ['create', '--name', 'Deploy']]) {
        const { status, stderr } = await runAsync(['webhooks', ...verb, ...flags, ...base]);
        assert.equal(status, 2, `${verb[0]} ${flags.join(' ')}: ${stderr}`);
        assert.match(stderr, expected);
      }
    }
    assert.equal(received.length, 0, 'nothing reached the API');
  } finally {
    server.close();
  }
});

test('webhooks send valid --action and --cooldown as numbers', async () => {
  const { server, baseUrl, received } = await questionServer({
    'PUT /api/agent/rooms/ab12cd/webhooks/wh-1': () => ({ status: 200, body: { id: 'wh-1' } }),
  });
  try {
    const { status, stderr } = await runAsync([
      'webhooks', 'update', 'wh-1', '--action', '16', '--cooldown', '0',
      '--room', 'ab12cd', '--token', 'tok', '--api', baseUrl,
    ]);
    assert.equal(status, 0, stderr);
    assert.deepEqual(JSON.parse(received[0].body), { action_number: 16, cooldown_seconds: 0 });
  } finally {
    server.close();
  }
});

// CL-07: only the exact string "false" disabled a webhook; "False", "0" and "no"
// sent enabled: true and exited 0.
test('webhooks --enabled reads true/false, 1/0 and yes/no in any case', async () => {
  const { server, baseUrl, received } = await questionServer({
    'PUT /api/agent/rooms/ab12cd/webhooks/wh-1': () => ({ status: 200, body: { id: 'wh-1' } }),
  });
  try {
    const cases = [
      ['false', false], ['False', false], ['FALSE', false], ['0', false], ['no', false], ['NO', false],
      ['true', true], ['True', true], ['1', true], ['yes', true], ['Yes', true],
    ];
    for (const [value, enabled] of cases) {
      const { status, stderr } = await runAsync([
        'webhooks', 'update', 'wh-1', '--enabled', value,
        '--room', 'ab12cd', '--token', 'tok', '--api', baseUrl,
      ]);
      assert.equal(status, 0, `--enabled ${value}: ${stderr}`);
      assert.deepEqual(JSON.parse(received.at(-1).body), { enabled }, `--enabled ${value}`);
    }
  } finally {
    server.close();
  }
});

// --- a create that answers without what it exists to hand over -----------------

test('rooms create and webhooks create fail on a 2xx that lacks the id or the trigger URL', async () => {
  const bodies = { room: {}, webhook: {} };
  const { server, baseUrl } = await questionServer({
    'POST /api/agent/rooms': () => ({ status: 201, body: bodies.room }),
    'POST /api/agent/rooms/ab12cd/webhooks': () => ({ status: 201, body: bodies.webhook }),
  });
  try {
    const room = ['rooms', 'create', '-n', 'Deploys', '--icon', 'bell', '--color', '#e33122', '--token', 'tok', '--api', baseUrl];
    const webhook = ['webhooks', 'create', '--room', 'ab12cd', '--name', 'CI', '--token', 'tok', '--api', baseUrl];

    const noRoomId = await runAsync(room);
    assert.equal(noRoomId.status, 1);
    assert.equal(noRoomId.stdout, '');
    assert.match(noRoomId.stderr, /rooms create returned no id/);

    bodies.room = { id: 'room-1', invite_code: 'ab12cd', name: 'Deploys' };
    const created = await runAsync(room);
    assert.equal(created.status, 0, created.stderr);
    assert.equal(created.stdout, 'created ab12cd Deploys\n');

    const noWebhookId = await runAsync(webhook);
    assert.equal(noWebhookId.status, 1);
    assert.equal(noWebhookId.stdout, '');
    assert.match(noWebhookId.stderr, /webhooks create returned no id/);

    // The one command that must print the secret URL cannot exit 0 without it.
    bodies.webhook = { id: 'wh-1', name: 'CI', enabled: true };
    const noUrl = await runAsync(webhook);
    assert.equal(noUrl.status, 1);
    assert.equal(noUrl.stdout, '');
    assert.match(noUrl.stderr, /webhooks create returned no trigger URL; webhook wh-1 may exist/);

    bodies.webhook = { id: 'wh-1', webhook_url: 'https://api.example/api/webhooks/ab12cd/s3cr3t' };
    const ok = await runAsync(webhook);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ok.stdout, 'created wh-1\nhttps://api.example/api/webhooks/ab12cd/s3cr3t\n');
  } finally {
    server.close();
  }
});

// --- a sub-command takes only the flags it reads --------------------------------

const TOKEN = 'x'.repeat(40);

test('a management sub-command refuses a flag it never reads, instead of dropping it with exit 0', () => {
  const room = ['--room', 'ab12cd'];
  for (const [argv, expected] of [
    // `--password` protects nothing on create; only `rooms join` sends it.
    [['rooms', 'create', '-n', 'Deploys', '--icon', 'bell', '--color', '#e33122', '--password', 'pw'], /--password is only supported by rooms join/],
    [['rooms', 'list', '--name', 'x'], /--name is only supported by rooms create/],
    [['rooms', 'get', 'ab12cd', '--public'], /--public is only supported by rooms create/],
    [['rooms', 'join', 'ab12cd', '--handle', 'h'], /--handle is only supported by rooms create/],
    [['rooms', 'list', '--cooldown', '5'], /Unknown option: --cooldown/],
    [['rooms', 'list', ...room], /--room is not supported here: a room is named by its invite code/],
    [['webhooks', 'list', ...room, '--name', 'x'], /--name is only supported by webhooks create or webhooks update/],
    [['webhooks', 'delete', 'wh-1', ...room, '--cooldown', '5'], /--cooldown is only supported by webhooks create or webhooks update/],
    [['webhooks', 'create', ...room, '--name', 'x', '--label', 'y'], /Unknown option: --label/],
    [['webhooks', 'create', ...room, '--name', 'x', '--wait'], /Unknown option: --wait/],
    [['actions', 'list', ...room, '--sound', 'ting'], /--sound is only supported by actions set/],
    [['actions', 'set', '1', ...room, '--label', 'a', '--icon', 'b', '--urgent'], /--urgent is only supported by actions trigger/],
    [['actions', 'set', '1', ...room, '--label', 'a', '--icon', 'b', '--idempotency-key', 'k'], /--idempotency-key is only supported by actions trigger/],
    [['actions', 'trigger', '1', ...room, '--label', 'x'], /--label is only supported by actions set/],
    [['actions', 'trigger', '1', ...room, '--sound', 'ting'], /--sound is only supported by actions set/],
    [['actions', 'set-all', ...room, '--set', '{}', '--require-ack'], /--require-ack is only supported by actions set or actions trigger/],
    [['actions', 'layout', ...room, '--page-order', '1', '--set', '{}'], /--set is only supported by actions set-all/],
    [['actions', 'list', ...room, '--name', 'x'], /Unknown option: --name/],
    [['approval', '-p', 'Ship?', ...room, '--name', 'x'], /Unknown option: --name/],
    [['approval', '-p', 'Ship?', ...room, '--url', 'https://example.com'], /Unknown option: --url/],
    [['attachment', 'get', 'att-1', ...room], /--room is not supported here: an attachment id already names its attachment/],
    [['attachment', 'delete', 'att-1', '--out', 'x'], /--out is only supported by attachment get/],
    [['attachment', 'get', 'att-1', '--password', 'x'], /Unknown option: --password/],
  ]) {
    const { status, stderr } = run([...argv, '--token', TOKEN]);
    assert.equal(status, 2, `${argv.join(' ')}: ${stderr}`);
    assert.match(stderr, expected);
  }
});

test('flags a sub-command does read are not refused', () => {
  // Each reaches the credential check ("an agent token is required"), which runs
  // after parsing, so a parse refusal would show as a different message.
  const room = ['--room', 'ab12cd'];
  for (const argv of [
    ['rooms', 'create', '-n', 'Deploys', '--icon', 'bell', '--color', '#e33122'],
    ['rooms', 'create', '-n', 'Meetup', '--icon', 'globe', '--color', '#0391fe', '--public', '--handle', 'meetup', '--description', 'd', '--location', '1,2', '--location-name', 'Mall'],
    ['rooms', 'join', 'ab12cd', '--password', 'pw'],
    ['webhooks', 'create', ...room, '-n', 'CI', '-t', 'T', '-m', 'M', '--icon', 'bell', '--color', '#e33122', '--sound', 'ting', '-a', '2', '--cooldown', '5', '--enabled', 'true'],
    ['webhooks', 'update', 'wh-1', ...room, '--enabled', 'false'],
    ['actions', 'set', '1', ...room, '--label', 'a', '--icon', 'b', '--sound', 'ting', '--require-ack', '--input-type', 'link'],
    ['actions', 'set-all', ...room, '--set', '{}', '--set', '{}', '--actions', '[]'],
    ['actions', 'trigger', '1', ...room, '--require-ack', '--urgent', '--ack-mode', 'all', '--idempotency-key', 'k', '--url', 'https://example.com', '--location', '1,2', '--location-label', 'a', '--location-address', 'b', '--attach', 'f.pdf', '--quick-action-id', 'x'],
    ['actions', 'layout', ...room, '--page-order', '1,3'],
    ['approval', '-p', 'Ship?', '-c', 'ctx', '--ttl', '60', '--idempotency-key', 'k', '--wait', '--timeout', '5', ...room],
    ['attachment', 'get', 'att-1', '--out', 'x'],
  ]) {
    const { status, stderr } = run([...argv, '--api', 'https://api.example', '--json']);
    assert.match(stderr, /an agent token is required/, `${argv.join(' ')}: ${stderr}`);
    assert.equal(status, 2);
  }
});

test('--help works on a sub-command whatever flags ride along', () => {
  const { status, stdout } = run(['rooms', 'create', '--password', 'pw', '--help']);
  assert.equal(status, 0);
  assert.match(stdout, /rooms create -n <name>/);
});

// ---------------------------------------------------------------------------
// The flags the README and --help show for these commands still parse.

const MANAGE_NOUNS = {
  rooms: parseRoomsArgs,
  webhooks: parseWebhooksArgs,
  actions: parseActionsArgs,
  approval: parseApprovalArgs,
  attachment: parseAttachmentArgs,
  metric: parseMetricArgs,
};

/** Run a parser the way main() does, keeping fail()'s stderr and exit code out of the runner. */
function parseOutcome(parser, argv) {
  const exitCode = process.exitCode;
  const write = process.stderr.write;
  let stderr = '';
  process.stderr.write = (chunk) => { stderr += chunk; return true; };
  try {
    parser(argv);
    return '';
  } catch (error) {
    if (!(error instanceof CliExit)) throw error;
    return stderr.trim();
  } finally {
    process.stderr.write = write;
    process.exitCode = exitCode;
  }
}

/** Shell words of one command line: quotes group, `#` after a space starts a comment. */
function shellWords(line) {
  const words = [];
  let word = null;
  let quote = null;
  for (const char of line) {
    if (quote) {
      if (char === quote) quote = null;
      else word += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      word ??= '';
    } else if (/\s/.test(char)) {
      if (word !== null) words.push(word);
      word = null;
    } else if (char === '#' && word === null) {
      break;
    } else {
      word = (word ?? '') + char;
    }
  }
  if (word !== null) words.push(word);
  return words;
}

test('every management command the README shows parses for its command', () => {
  const readme = readFileSync(join(__dirname, '..', 'README.md'), 'utf8');
  const fences = [...readme.matchAll(/^```[a-z]*\n([\s\S]*?)^```/gm)].map((match) => match[1]);
  let checked = 0;
  for (const block of fences) {
    for (const line of block.replace(/\\\n\s*/g, ' ').split('\n')) {
      const found = /\bpingroom (rooms|webhooks|actions|approval|attachment|metric)\b(.*)$/.exec(line);
      if (!found) continue;
      const [, noun, rest] = found;
      const argv = shellWords(rest);
      checked += 1;
      assert.equal(parseOutcome(MANAGE_NOUNS[noun], argv), '', `README: pingroom ${noun} ${rest.trim()}`);
    }
  }
  assert.ok(checked >= 20, `only ${checked} README commands were checked`);
});

test('every flag --help shows for a management command is one its parser accepts', () => {
  for (const [noun, parser] of Object.entries(MANAGE_NOUNS)) {
    const text = `${COMMAND_HELP_SECTIONS[noun]}\n${HELP_SHARED_COMMAND}`;
    const flags = [...text.matchAll(/(?<![\w-])(--[a-z][a-z0-9-]*|-[a-z])(?![\w-])/g)].map((match) => match[1]);
    assert.ok(flags.length > 0, noun);
    for (const flag of flags) {
      // `-a`-style entries are the short spellings; `-h` and `--help` are shared.
      assert.ok(parser.flags.has(flag), `pingroom ${noun} --help shows ${flag}, which its parser rejects`);
    }
  }
});

test('each noun\'s flag table and its per-sub-command lists describe the same flags', () => {
  for (const [noun, bySubcommand] of Object.entries(MANAGE_FLAGS)) {
    const owned = new Set(Object.values(bySubcommand).flat());
    const shared = new Set(['token', 'api', 'json', 'help', 'room', 'expected_room_sha256']);
    const accepted = new Set([...MANAGE_NOUNS[noun].keys].filter((key) => !shared.has(key)));
    assert.deepEqual([...accepted].sort(), [...owned].sort(), `${noun}: a flag its parser takes belongs to no sub-command, or the reverse`);
  }
});

// --- a dot-segment id cannot redirect the bearer to another route ---------------

test('a "." or ".." id is a usage error before any request is sent', async () => {
  const { server, baseUrl, received } = await questionServer({});
  try {
    const auth = ['--token', 'tok', '--api', baseUrl];
    for (const id of ['..', '.']) {
      for (const argv of [
        ['rooms', 'get', id],
        ['webhooks', 'list', '--room', id],
        ['webhooks', 'delete', id, '--room', 'ab12cd'],
        ['webhooks', 'update', id, '--room', 'ab12cd'],
        ['actions', 'list', '--room', id],
        ['approval', '-p', 'Ship?', '--room', id],
        ['attachment', 'get', id, '--out', '-'],
        ['attachment', 'delete', id],
        ['ask', '-p', 'Ship?', '--room', id],
        ['watch', id],
        ['cancel', id],
        ['ping', '-m', 'hi', '--room', id],
        ['live', 'get', '-c', id, '--room', 'ab12cd'],
        ['live', 'start', '-c', 'build', '--room', id],
      ]) {
        const { status, stderr } = await runAsync([...argv, ...auth], {}, { timeoutMs: 8000 });
        assert.equal(status, 2, `${argv.join(' ')}: ${stderr}`);
        assert.match(stderr, /may not be empty, "\." or "\.\."/, argv.join(' '));
      }
    }
    // `run` takes its own options before the `--` that starts the child command.
    const wrapped = await runAsync(['run', '--room', '..', ...auth, '--', 'true'], {}, { timeoutMs: 8000 });
    assert.equal(wrapped.status, 2, wrapped.stderr);
    assert.match(wrapped.stderr, /room may not be empty, "\." or "\.\."/);
    assert.equal(received.length, 0, 'the bearer went nowhere');
  } finally {
    server.close();
  }
});

// --- numeric flags read plain digits ------------------------------------------

test('webhooks --cooldown "" is a usage error, not a request that clears the cooldown', () => {
  for (const cooldown of ['', ' ', '0x10', 'NaN']) {
    const { status, stderr } = run(['webhooks', 'update', 'wh-1', '--cooldown', cooldown, '--room', 'ab12cd', '--token', TOKEN]);
    assert.equal(status, 2, JSON.stringify(cooldown));
    assert.match(stderr, /--cooldown must be a number/);
  }
  const negative = run(['webhooks', 'update', 'wh-1', '--cooldown', '-1', '--room', 'ab12cd', '--token', TOKEN]);
  assert.equal(negative.status, 2);
  assert.match(negative.stderr, /--cooldown must be at least 0/);
});
