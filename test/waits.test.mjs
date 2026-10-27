import test from 'node:test';
import assert from 'node:assert/strict';
import { runAsync, startServer, questionServer } from './helpers.mjs';

test('decision polling survives a rate limit and a temporary server failure', async () => {
  const { pollDecision } = await import('../lib/http.js');
  let attempts = 0;
  const { server, baseUrl } = await questionServer({
    'GET /decision': () => {
      attempts += 1;
      return attempts < 3
        ? { status: attempts === 1 ? 429 : 503, body: { message: 'Try again' } }
        : { status: 200, body: { state: 'answered' } };
    },
  });
  try {
    const result = await pollDecision(`${baseUrl}/decision`, 'tok');
    assert.equal(result.json.state, 'answered');
    assert.equal(attempts, 3);
  } finally { server.close(); }
});

test('decision polling reports a non-JSON answer instead of retrying it forever', async () => {
  let polls = 0;
  const { server, baseUrl } = await startServer((req, res) => {
    polls += 1;
    res.writeHead(403, { 'Content-Type': 'text/html' });
    res.end('<html><body>Access denied</body></html>');
  });
  try {
    const { status, stderr } = await runAsync(['watch', '--token', 'tok', '--api', baseUrl, 'q_1'], {}, { timeoutMs: 10_000 });
    assert.notEqual(status, 0);
    assert.match(stderr, /untrusted JSON response \(HTTP 403\)/);
    assert.equal(polls, 1);
  } finally { server.close(); }
});

// --- blocking waits are bounded when PingRoom is down ------------------------

test('watch rides out a 503 and then reports the answer', async () => {
  let waits = 0;
  const { server, baseUrl } = await questionServer({
    'GET /api/agent/questions/q_flaky/wait': () => {
      waits += 1;
      return waits === 1
        ? { status: 503, body: { message: 'Service Unavailable' } }
        : { status: 200, body: { id: 'q_flaky', state: 'answered', answer: { value: 'ship' } } };
    },
  });
  try {
    const { status, stdout, stderr, timedOut } = await runAsync(['watch', '--token', 'tok', '--api', baseUrl, 'q_flaky'], {}, { timeoutMs: 10_000 });
    assert.equal(timedOut, false);
    assert.equal(status, 0, stderr);
    assert.equal(stdout.trim(), 'ship');
    assert.equal(waits, 2);
    assert.doesNotMatch(stderr, /unavailable/, 'one blip is not worth a warning');
  } finally {
    server.close();
  }
});

test('a persistent 503 ends approval --wait at the expiry plus grace, and says why', async () => {
  const { EXPIRY_GRACE_MS } = await import('../lib/question-wait.js');
  let waits = 0;
  const { server, baseUrl } = await questionServer({
    // Created with an expiry whose grace runs out 5 s from now.
    'POST /api/agent/rooms/ab12cd/questions': () => ({ status: 201, body: {
      id: 'q_down', state: 'pending', expires_at: new Date(Date.now() - EXPIRY_GRACE_MS + 5000).toISOString(),
    } }),
    'GET /api/agent/questions/q_down/wait': () => { waits += 1; return { status: 503, body: { message: 'Down' } }; },
  });
  try {
    const started = Date.now();
    const { status, stdout, stderr, timedOut } = await runAsync(
      ['approval', '--token', 'tok', '--room', 'ab12cd', '--api', baseUrl, '--wait', '-p', 'Ship?'],
      {},
      { timeoutMs: 15_000 },
    );
    const elapsed = Date.now() - started;
    assert.equal(timedOut, false, 'it used to retry until the CI job timed out');
    assert.equal(status, 1);
    assert.equal(stdout, '');
    // One warning once the failures add up, then the reason it stopped.
    assert.equal(stderr.match(/retrying until/g)?.length, 1, stderr);
    assert.match(stderr, /PingRoom unavailable since \S+ \(HTTP 503\); stopped waiting for question q_down/);
    assert.ok(elapsed >= 4500 && elapsed < 9000, `gave up after ${elapsed} ms`);
    assert.ok(waits >= 3 && waits <= 5, `${waits} wait requests`);
  } finally {
    server.close();
  }
});

test('watch learns the expiry from its first read and stops when the API then stays down', async () => {
  const { EXPIRY_GRACE_MS } = await import('../lib/question-wait.js');
  let waits = 0;
  const expires = new Date(Date.now() - EXPIRY_GRACE_MS + 2500).toISOString();
  const { server, baseUrl } = await questionServer({
    'GET /api/agent/questions/q_late/wait': () => {
      waits += 1;
      return waits === 1
        ? { status: 200, body: { id: 'q_late', state: 'pending', expires_at: expires } }
        : { status: 502, body: { message: 'Bad Gateway' } };
    },
  });
  try {
    const { status, stderr, timedOut } = await runAsync(['watch', '--token', 'tok', '--api', baseUrl, 'q_late'], {}, { timeoutMs: 15_000 });
    assert.equal(timedOut, false);
    assert.equal(status, 1);
    assert.match(stderr, /PingRoom unavailable since \S+ \(HTTP 502\); stopped waiting for question q_late/);
  } finally {
    server.close();
  }
});

test('handoff --wait stops at the handoff expiry plus grace when the API stays down', async () => {
  const { EXPIRY_GRACE_MS } = await import('../lib/question-wait.js');
  const { server, baseUrl } = await questionServer({
    'POST /api/agent/handoffs': () => ({ status: 201, body: {
      id: 'h_down', kind: 'ack', state: 'open', delivery_state: 'enqueued',
      expires_at: new Date(Date.now() - EXPIRY_GRACE_MS + 1500).toISOString(),
    } }),
    'GET /api/agent/handoffs/h_down/wait': () => ({ status: 500, body: { message: 'Server Error' } }),
  });
  try {
    const { status, stderr, timedOut } = await runAsync(
      ['handoff', '--token', 'tok', '--api', baseUrl, '-m', 'Ack?', '--wait'],
      {},
      { timeoutMs: 15_000 },
    );
    assert.equal(timedOut, false);
    assert.equal(status, 1);
    assert.match(stderr, /PingRoom unavailable since \S+ \(HTTP 500\); stopped waiting for handoff h_down/);
  } finally {
    server.close();
  }
});

test('with no known expiry, an unbroken outage is bounded too', async () => {
  const { pollDecision } = await import('../lib/http.js');
  const { CliExit } = await import('../lib/util.js');
  let polls = 0;
  const { server, baseUrl } = await questionServer({
    'GET /decision': () => { polls += 1; return { status: 503, body: { message: 'Down' } }; },
  });
  const exitCode = process.exitCode;
  const write = process.stderr.write;
  let stderr = '';
  process.stderr.write = (chunk) => { stderr += chunk; return true; };
  try {
    await assert.rejects(
      pollDecision(`${baseUrl}/decision`, 'tok', { maxOutageMs: 1500, what: 'question q_1' }),
      (error) => error instanceof CliExit && error.code === 1,
    );
    assert.match(stderr, /PingRoom unavailable since \S+ \(HTTP 503\); stopped waiting for question q_1/);
    // t=0 and t=1 s back off; the third attempt lands on the 1.5 s bound.
    assert.equal(polls, 3);
  } finally {
    process.stderr.write = write;
    process.exitCode = exitCode;
    server.close();
  }
});

test('a network failure is named without the URL or the token', async () => {
  const { pollDecision } = await import('../lib/http.js');
  const exitCode = process.exitCode;
  const write = process.stderr.write;
  let stderr = '';
  process.stderr.write = (chunk) => { stderr += chunk; return true; };
  try {
    // Port 9 is on fetch's blocked list: every attempt fails at once.
    await assert.rejects(pollDecision('http://127.0.0.1:9/api/agent/questions/q_1/wait', 'TOKENSECRET', { maxOutageMs: 1200 }));
    assert.match(stderr, /PingRoom unavailable since \S+ \(bad port\)/);
    assert.doesNotMatch(stderr, /TOKENSECRET|127\.0\.0\.1/);
  } finally {
    process.stderr.write = write;
    process.exitCode = exitCode;
  }
});
