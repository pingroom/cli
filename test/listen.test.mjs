import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { CLI, baseEnv, run, runAsync, startServer } from './helpers.mjs';

test('listen delivers every printed ping before a fatal 401 ends it', async () => {
  const batch = Array.from({ length: 100 }, (_, i) => ({ id: `n${i}`, message: 'x'.repeat(4096), room: { name: 'R' } }));
  let calls = 0;
  const { server, baseUrl } = await startServer((req, res) => {
    calls += 1;
    res.writeHead(calls === 1 ? 200 : 401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(calls === 1 ? { notifications: batch, cursor: 'n99' } : { message: 'Unauthenticated.' }));
  });
  try {
    // A consumer that does not read for the first 1.5 s: everything past the
    // pipe's own buffer has to wait in the child, which used to exit on the
    // 401 and drop it.
    const { status, stdout, stderr } = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [CLI, 'listen', '--json', '--from', 'n0', '--token', 'tok', '--api', baseUrl], {
        env: baseEnv(),
      });
      let out = '';
      let err = '';
      const kill = setTimeout(() => child.kill('SIGKILL'), 10_000);
      setTimeout(() => child.stdout.on('data', (c) => { out += c; }), 1500);
      child.stderr.on('data', (c) => { err += c; });
      child.on('error', reject);
      child.on('close', (code) => { clearTimeout(kill); resolve({ status: code, stdout: out, stderr: err }); });
      child.stdin.end();
    });
    assert.equal(status, 1);
    assert.match(stderr, /listen failed: Unauthenticated/);
    const lines = stdout.trimEnd().split('\n');
    assert.equal(lines.length, 100);
    assert.equal(JSON.parse(lines[99]).id, 'n99');
  } finally {
    server.close();
  }
});

test('listen establishes a cursor from "now", then prints what lands', async () => {
  const seen = [];
  const { server, baseUrl } = await startServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    seen.push(url.searchParams.get('after'));
    const body = url.searchParams.get('after')
      ? {
          notifications: [
            {
              id: 'n2',
              message: 'Build 512 is green',
              correlation_id: 'deploy-512',
              room: { code: 'AB12', name: 'Project X' },
            },
          ],
          cursor: 'n2',
        }
      // No `after` → the head id and no rows, so startup never replays history.
      : { notifications: [], cursor: 'n1' };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });

  try {
    const { status, stdout } = await runAsync(
      ['listen', '--once', '--token', 'tok', '--api', baseUrl],
      {},
      { timeoutMs: 8000 },
    );
    assert.equal(status, 0);
    assert.match(stdout, /\[Project X\] Build 512 is green/);
    assert.match(stdout, /corr=deploy-512/);
    // First call carries no cursor; the second is bounded by the head id.
    assert.equal(seen[0], null);
    assert.equal(seen[1], 'n1');
  } finally {
    server.close();
  }
});

test('listen --from skips the cursor handshake and honours --json', async () => {
  const seen = [];
  const { server, baseUrl } = await startServer((req, res) => {
    seen.push(new URL(req.url, 'http://x').searchParams.get('after'));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      notifications: [{ id: 'n9', message: 'hi', room: { code: 'AB12', name: 'R' } }],
      cursor: 'n9',
    }));
  });

  try {
    const { status, stdout } = await runAsync(
      ['listen', '--once', '--from', 'n5', '--json', '--token', 'tok', '--api', baseUrl],
      {},
      { timeoutMs: 8000 },
    );
    assert.equal(status, 0);
    assert.equal(seen.length, 1, 'an explicit --from needs no handshake request');
    assert.equal(seen[0], 'n5');
    assert.equal(JSON.parse(stdout.trim()).id, 'n9');
  } finally {
    server.close();
  }
});

test('listen refuses out-of-range holds locally, and needs a token', async () => {
  const over = await runAsync(['listen', '--timeout', '99', '--token', 't', '--api', 'https://api.pingroom.io']);
  assert.equal(over.status, 2);
  assert.match(over.stderr, /--timeout must be at most 30/);

  const noToken = await runAsync(['listen', '--api', 'https://api.pingroom.io']);
  assert.equal(noToken.status, 2);
  assert.match(noToken.stderr, /agent token is required/);
});

test('listen waits at least 1 s after a 429 that says Retry-After: 0', async () => {
  const at = [];
  const { server, baseUrl } = await startServer((req, res) => {
    at.push(Date.now());
    if (at.length === 1) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '0' });
      res.end(JSON.stringify({ message: 'Too Many Attempts.' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ notifications: [{ id: 'n2', message: 'hi', room: { name: 'R' } }], cursor: 'n2' }));
  });
  try {
    const { status, stdout } = await runAsync(
      ['listen', '--once', '--from', 'n1', '--token', 'tok', '--api', baseUrl],
      {},
      { timeoutMs: 8000 },
    );
    assert.equal(status, 0);
    assert.match(stdout, /\[R\] hi/);
    assert.equal(at.length, 2);
    assert.ok(at[1] - at[0] >= 950, `retried after ${at[1] - at[0]} ms`);
  } finally {
    server.close();
  }
});

// CL-03: no endpoint behind listen/list/watch/cancel takes a room, so --room
// used to be accepted and ignored (`listen --room OPS` streamed every room).
test('listen, list, watch and cancel refuse --room with the reason instead of ignoring it', () => {
  const cases = [
    [['listen', '--room', 'OPS123', '--once'], /--room is not supported here: listen hears every room this connection covers/],
    [['list', '--room', 'OPS123'], /--room is not supported here: list shows this agent's questions across all rooms/],
    [['watch', '--room', 'OPS123', 'q_1'], /--room is not supported here: a question id already names its question/],
    [['await', '--room', 'OPS123', 'q_1'], /--room is not supported here: a question id already names its question/],
    [['cancel', '--room', 'OPS123', 'q_1'], /--room is not supported here: a question id already names its question/],
  ];
  for (const [argv, expected] of cases) {
    // Port 9 is blocked by fetch: if the flag were accepted the command would
    // fail with a network error (exit 1), not a usage error.
    const { status, stderr } = run([...argv, '--token', 'tok', '--api', 'http://127.0.0.1:9']);
    assert.equal(status, 2, `${argv.join(' ')}: ${stderr}`);
    assert.match(stderr, expected);
  }
});

test('listen, list, watch and cancel reject the ask-only flags they used to swallow', () => {
  for (const argv of [
    ['listen', '--prompt', 'x'], ['listen', '--wait'], ['list', '--option', 'a:b'], ['watch', 'q_1', '--scope', 'room'],
    ['cancel', 'q_1', '--ttl', '5'], ['list', '--limit', '5'],
  ]) {
    const { status, stderr } = run([...argv, '--token', 'tok', '--api', 'http://127.0.0.1:9']);
    assert.equal(status, 2, argv.join(' '));
    assert.match(stderr, /Unknown option: --(prompt|wait|option|scope|ttl|limit)/);
  }
});

test('listen takes no positional argument, so "listen OPS123" is not read as a room', () => {
  const { status, stderr } = run(['listen', 'OPS123', '--token', 'tok', '--api', 'http://127.0.0.1:9']);
  assert.equal(status, 2);
  assert.match(stderr, /listen takes no arguments/);
});

test('the flags listen, list, watch and cancel do read still parse', async () => {
  const { server, baseUrl } = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ notifications: [], cursor: 'n1', questions: [], state: 'cancelled' }));
  });
  try {
    for (const argv of [
      ['listen', '--once', '--json', '--timeout', '0', '--limit', '5', '--from', 'n0'],
      ['list', '--state', 'all', '--json'],
      ['cancel', 'q_1', '--json'],
    ]) {
      const { status, stderr } = await runAsync([...argv, '--token', 'tok', '--api', baseUrl], {}, { timeoutMs: 8000 });
      assert.equal(status, 0, `${argv.join(' ')}: ${stderr}`);
    }
  } finally {
    server.close();
  }
});

// CL-04: the handshake gave up on a 503 or a dropped connection that the loop
// one request later rode out, and reported a network error as "HTTP error".
test('listen retries a 503 on its very first request instead of exiting 1', async () => {
  const requests = [];
  const { server, baseUrl } = await startServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    requests.push({ at: Date.now(), after: url.searchParams.get('after') });
    if (requests.length === 1) {
      res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '1' });
      res.end(JSON.stringify({ message: 'Service Unavailable' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(url.searchParams.get('after')
      ? { notifications: [{ id: 'n2', message: 'hello', room: { name: 'R' } }], cursor: 'n2' }
      : { notifications: [], cursor: 'n1' }));
  });
  try {
    const { status, stdout, stderr } = await runAsync(
      ['listen', '--once', '--token', 'tok', '--api', baseUrl], {}, { timeoutMs: 10_000 },
    );
    assert.equal(status, 0, stderr);
    assert.match(stdout, /\[R\] hello/);
    assert.deepEqual(requests.map((request) => request.after), [null, null, 'n1']);
    assert.ok(requests[1].at - requests[0].at >= 950, 'it backs off before retrying');
    assert.equal(stderr, '', 'one blip is not worth a warning');
  } finally {
    server.close();
  }
});

test('listen names the real cause when the network stays down, and keeps retrying', async () => {
  // A loopback port nothing listens on: every attempt is ECONNREFUSED.
  const { server, baseUrl } = await startServer((req, res) => res.end('{}'));
  server.close();
  const { status, stderr, timedOut } = await runAsync(
    ['listen', '--token', 'tok', '--api', baseUrl], {}, { timeoutMs: 6500 },
  );
  assert.equal(timedOut, true, 'a daemon does not give up on an outage');
  assert.equal(status, null);
  assert.match(stderr, /pingroom: listen: PingRoom unavailable \(ECONNREFUSED\); retrying/);
  assert.equal(stderr.match(/unavailable/g).length, 1, 'said once, not on every attempt');
  assert.doesNotMatch(stderr, /listen failed|HTTP error/);
});

// CL-05: `--timeout 0` is answered at once, so the loop re-asked at full speed
// until the route's 30/min throttle answered 429 for everyone on the account.
test('listen --timeout 0 paces its rounds instead of hot-looping the shared feed route', async () => {
  const at = [];
  const { server, baseUrl } = await startServer((req, res) => {
    at.push(Date.now());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ notifications: [], cursor: 'n1' }));
  });
  try {
    const { timedOut } = await runAsync(
      ['listen', '--from', 'n1', '--timeout', '0', '--token', 'tok', '--api', baseUrl], {}, { timeoutMs: 4600 },
    );
    assert.equal(timedOut, true);
    // Unpaced, this is thousands of requests; paced at 2 s it is three.
    assert.ok(at.length >= 2 && at.length <= 3, `${at.length} requests in 4.6 s`);
    // The server sees arrival times, which jitter around the CLI's own 2 s clock.
    assert.ok(at[1] - at[0] >= 1800, `second round came after ${at[1] - at[0]} ms`);
  } finally {
    server.close();
  }
});

test('listen does not pace a round that delivered pings', async () => {
  const at = [];
  const { server, baseUrl } = await startServer((req, res) => {
    at.push(Date.now());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(at.length < 3
      ? { notifications: [{ id: `n${at.length + 1}`, message: 'x', room: { name: 'R' } }], cursor: `n${at.length + 1}` }
      : { notifications: [], cursor: 'n3' }));
  });
  try {
    await runAsync(
      ['listen', '--from', 'n0', '--timeout', '0', '--token', 'tok', '--api', baseUrl], {}, { timeoutMs: 1500 },
    );
    assert.ok(at.length >= 3, `${at.length} requests: a batch with pings is followed up at once`);
    assert.ok(at[2] - at[0] < 1000);
  } finally {
    server.close();
  }
});
