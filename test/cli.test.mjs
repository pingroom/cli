import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '..', 'bin', 'pingroom.js');

/**
 * Run the CLI as a real subprocess and capture its exit code + streams.
 * Pass `env` overrides for credential/endpoint config. PINGROOM_* env vars
 * are stripped by default so the host machine's config can't leak in.
 */
function run(args, env = {}) {
  const cleanEnv = { ...process.env };
  delete cleanEnv.PINGROOM_WEBHOOK_URL;
  delete cleanEnv.PINGROOM_TOKEN;
  delete cleanEnv.PINGROOM_API_URL;
  const r = spawnSync(process.execPath, [CLI, ...args], {
    env: { ...cleanEnv, ...env },
    encoding: 'utf8',
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/**
 * Async variant for tests that need an in-process stub server: spawnSync would
 * block the event loop and deadlock against a localhost server running in the
 * same process, so use async spawn and resolve on close.
 */
function runAsync(args, env = {}) {
  const cleanEnv = { ...process.env };
  delete cleanEnv.PINGROOM_WEBHOOK_URL;
  delete cleanEnv.PINGROOM_TOKEN;
  delete cleanEnv.PINGROOM_API_URL;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...cleanEnv, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

/** Start a one-shot localhost stub server. Resolves once it's listening. */
function startServer(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

// ---------------------------------------------------------------------------
// Exit 0 — help / no-command
// ---------------------------------------------------------------------------

test('exit 0: no command prints help', () => {
  const { status, stdout } = run([]);
  assert.equal(status, 0);
  assert.match(stdout, /pingroom — send a ping/);
});

test('exit 0: --help prints help', () => {
  const { status, stdout } = run(['--help']);
  assert.equal(status, 0);
  assert.match(stdout, /Exit codes: 0 on success/);
});

test('exit 0: -h prints help', () => {
  const { status } = run(['-h']);
  assert.equal(status, 0);
});

test('exit 0: "help" command prints help', () => {
  const { status, stdout } = run(['help']);
  assert.equal(status, 0);
  assert.match(stdout, /Usage:/);
});

test('exit 0: ping -h prints help via the ping path', () => {
  // `ping -h` routes through parseArgs -> args.help -> ping() returns 0.
  const { status, stdout } = run(['ping', '-h']);
  assert.equal(status, 0);
  assert.match(stdout, /pingroom — send a ping/);
});

// ---------------------------------------------------------------------------
// Exit 2 — bad usage
// ---------------------------------------------------------------------------

test('exit 2: unknown command', () => {
  const { status, stderr } = run(['frobnicate']);
  assert.equal(status, 2);
  assert.match(stderr, /unknown command: frobnicate/);
});

test('exit 2: unknown option', () => {
  const { status, stderr } = run(['ping', '--bogus', 'x']);
  assert.equal(status, 2);
  assert.match(stderr, /Unknown option: --bogus/);
});

test('exit 2: missing --message', () => {
  const { status, stderr } = run(['ping', '-w', 'http://127.0.0.1:1/hook']);
  assert.equal(status, 2);
  assert.match(stderr, /--message is required/);
});

test('exit 2: bad --action (out of range)', () => {
  const { status, stderr } = run(['ping', '-w', 'http://127.0.0.1:1/hook', '-m', 'hi', '-a', '7']);
  assert.equal(status, 2);
  assert.match(stderr, /--action must be an integer/);
});

test('exit 2: bad --action (non-numeric)', () => {
  const { status, stderr } = run(['ping', '-w', 'http://127.0.0.1:1/hook', '-m', 'hi', '-a', 'foo']);
  assert.equal(status, 2);
  assert.match(stderr, /--action must be an integer/);
});

test('exit 2: invalid --data JSON', () => {
  const { status, stderr } = run(['ping', '-w', 'http://127.0.0.1:1/hook', '-m', 'hi', '-d', '{not json}']);
  assert.equal(status, 2);
  assert.match(stderr, /--data must be valid JSON/);
});

test('exit 2: --data is valid JSON but not an object', () => {
  const { status, stderr } = run(['ping', '-w', 'http://127.0.0.1:1/hook', '-m', 'hi', '-d', '[1,2,3]']);
  assert.equal(status, 2);
  assert.match(stderr, /--data must be a JSON object/);
});

test('exit 2: --token without --room', () => {
  const { status, stderr } = run(['ping', '--token', 'tok_abc', '-m', 'hi']);
  assert.equal(status, 2);
  assert.match(stderr, /--room is required/);
});

test('exit 2: no credential (no webhook, no token)', () => {
  const { status, stderr } = run(['ping', '-m', 'hi']);
  assert.equal(status, 2);
  assert.match(stderr, /provide a webhook .* or an agent token/);
});

// ---------------------------------------------------------------------------
// Exit 0 — successful delivery (stubbed server)
// ---------------------------------------------------------------------------

test('exit 0: successful webhook delivery', async () => {
  const received = [];
  const { server, baseUrl } = await startServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    });
  });
  try {
    const { status, stdout } = await runAsync(['ping', '-w', `${baseUrl}/hook`, '-m', 'hello']);
    assert.equal(status, 0);
    assert.match(stdout, /ping sent/);
    assert.equal(received.length, 1);
    assert.equal(received[0].method, 'POST');
    assert.deepEqual(JSON.parse(received[0].body), { message: 'hello' });
  } finally {
    server.close();
  }
});

test('exit 0: successful agent-token delivery via --api override', async () => {
  const received = [];
  const { server, baseUrl } = await startServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ url: req.url, auth: req.headers['authorization'], body });
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'n1' }));
    });
  });
  try {
    const { status, stdout } = await runAsync([
      'ping', '--token', 'tok_abc', '--room', 'ab12cd', '--api', baseUrl,
      '-m', 'shipped', '-t', 'CI', '-a', '2', '-d', '{"version":"1.4.0"}',
    ]);
    assert.equal(status, 0);
    assert.match(stdout, /ping sent/);
    assert.equal(received[0].url, '/api/agent/rooms/ab12cd/notifications');
    assert.equal(received[0].auth, 'Bearer tok_abc');
    assert.deepEqual(JSON.parse(received[0].body), {
      message: 'shipped', title: 'CI', action_number: 2, data: { version: '1.4.0' },
    });
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------
// Exit 1 — delivery failure
// ---------------------------------------------------------------------------

test('exit 1: HTTP error response from server', async () => {
  const { server, baseUrl } = await startServer((req, res) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'boom' }));
  });
  try {
    const { status, stderr } = await runAsync(['ping', '-w', `${baseUrl}/hook`, '-m', 'hi']);
    assert.equal(status, 1);
    assert.match(stderr, /delivery failed: boom/);
  } finally {
    server.close();
  }
});

test('exit 1: 200 OK but success:false in body', async () => {
  const { server, baseUrl } = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'rejected' }));
  });
  try {
    const { status, stderr } = await runAsync(['ping', '-w', `${baseUrl}/hook`, '-m', 'hi']);
    assert.equal(status, 1);
    assert.match(stderr, /delivery failed: rejected/);
  } finally {
    server.close();
  }
});

test('exit 1: network error (connection refused)', () => {
  // Port 1 is privileged/unused -> fetch throws -> fail() defaults to code 1.
  const { status, stderr } = run(['ping', '-w', 'http://127.0.0.1:1/hook', '-m', 'hi']);
  assert.equal(status, 1);
  assert.match(stderr, /network error/);
});
