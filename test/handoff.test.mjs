import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { run, runAsync, questionServer, parseGitHubOutputFile } from './helpers.mjs';

test('handoff applies the same Idempotency-Key rule as ask and approval', () => {
  // A non-Latin-1 key used to reach fetch() and fail as a "network error"
  // (ByteString), so the advertised retry-with-the-same-key failed every time.
  for (const key of ['', '   ', 'line\nbreak', 'ключ', 'deploy-✅', 'x'.repeat(256)]) {
    const { status, stderr } = run(['handoff', '--token', 'tok', '-m', 'Ship?', '--idempotency-key', key]);
    assert.equal(status, 2, key);
    assert.match(stderr, /--idempotency-key must be 1–255 printable ASCII/);
    assert.doesNotMatch(stderr, /network error/);
  }
});

// ---------------------------------------------------------------------------
// handoff
// ---------------------------------------------------------------------------

test('github output protocol contains malicious multiline answers without output injection', async () => {
  const maliciousAnswer = 'ok\nstate=acked\r\nanswer=owned\npingroom_0123456789abcdef\nEOF_like';
  const { server, baseUrl } = await questionServer({
    'POST /api/agent/handoffs': () => ({
      status: 201,
      body: { id: 'h_malicious', kind: 'question', state: 'pending' },
    }),
    'GET /api/agent/handoffs/h_malicious/wait': () => ({
      status: 200,
      body: {
        id: 'h_malicious',
        kind: 'question',
        state: 'answered',
        answer: { value: maliciousAnswer, label: 'Untrusted' },
      },
    }),
  });
  const dir = mkdtempSync(join(tmpdir(), 'pingroom-cli-output-'));
  const outputPath = join(dir, 'github-output');
  try {
    const { status, stdout, stderr } = await runAsync([
      'handoff', '--token', 'tok', '--api', baseUrl, '--wait',
      '--github-output', outputPath, '-m', 'Ship?', '--question', '-o', 'ok:OK', '-o', 'hold:Hold',
    ]);
    assert.equal(status, 0, stderr);

    // Terminal output is one sanitized value per line; the GitHub file retains the exact answer.
    assert.match(stdout, /answer=ok state=acked answer=owned/);
    assert.equal(stdout.split('\n').filter((line) => line.startsWith('state=')).length, 1);

    const raw = readFileSync(outputPath, 'utf8');
    assert.match(raw, /^handoff-id<<pingroom_[0-9a-f]{48}$/m);
    const outputs = parseGitHubOutputFile(raw);
    assert.deepEqual(Object.keys(outputs).sort(), ['answer', 'handoff-id', 'state']);
    assert.equal(outputs['handoff-id'], 'h_malicious');
    assert.equal(outputs.state, 'answered');
    assert.equal(outputs.answer, maliciousAnswer);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('handoffs lists recent history with state=all without changing question list', async () => {
  const { server, baseUrl, received } = await questionServer({
    'GET /api/agent/handoffs': () => ({ status: 200, body: { handoffs: [
      { id: 'h_done', kind: 'question', state: 'answered', prompt: 'Ship?', answer: { value: 'hold' } },
      { id: 'h_open', kind: 'ack', state: 'open', prompt: 'Review this' },
    ] } }),
  });
  try {
    const { status, stdout } = await runAsync([
      'handoffs', '--token', 'tok', '--api', baseUrl, '--state', 'all',
    ]);
    assert.equal(status, 0);
    assert.match(stdout, /h_done\s+question\s+answered\s+Ship\? → hold/);
    assert.match(stdout, /h_open\s+ack\s+open\s+Review this/);
    assert.equal(received[0].path, '/api/agent/handoffs');
    assert.match(received[0].query, /(?:^|&)state=all(?:&|$)/);
  } finally {
    server.close();
  }
});

test('handoffs defaults to open and rejects question-only states', async () => {
  const { server, baseUrl, received } = await questionServer({
    'GET /api/agent/handoffs': () => ({ status: 200, body: { handoffs: [] } }),
  });
  try {
    const open = await runAsync(['handoffs', '--token', 'tok', '--api', baseUrl]);
    assert.equal(open.status, 0);
    assert.equal(open.stdout.trim(), 'no handoffs');
    assert.match(received[0].query, /(?:^|&)state=open(?:&|$)/);
  } finally {
    server.close();
  }

  const invalid = run(['handoffs', '--token', 'tok', '--state', 'answered']);
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /--state must be 'open' or 'all'/);
});

test('exit 2: handoff without --message', () => {
  const { status, stderr } = run(['handoff', '--token', 't']);
  assert.equal(status, 2);
  assert.match(stderr, /--message is required/);
});

test('exit 2: handoff without a token', () => {
  const { status, stderr } = run(['handoff', '-m', 'Ack?']);
  assert.equal(status, 2);
  assert.match(stderr, /agent token is required/);
});

test('exit 2: handoff --question needs at least 2 options', () => {
  const { status, stderr } = run(['handoff', '--token', 't', '-m', 'x', '--question', '-o', 'only:One']);
  assert.equal(status, 2);
  assert.match(stderr, /at least 2 --option/);
});

test('exit 2: handoff --option without --question is still a question (needs 2)', () => {
  // A single --option implies a question but falls short of the 2-option floor.
  const { status, stderr } = run(['handoff', '--token', 't', '-m', 'x', '-o', 'solo']);
  assert.equal(status, 2);
  assert.match(stderr, /at least 2 --option/);
});

test('exit 2: handoff rejects more than 4 options', () => {
  const { status, stderr } = run([
    'handoff', '--token', 't', '-m', 'x', '--question',
    '-o', 'one', '-o', 'two', '-o', 'three', '-o', 'four', '-o', 'five',
  ]);
  assert.equal(status, 2);
  assert.match(stderr, /at most 4 --option/);
});

test('exit 2: handoff bad --urgency', () => {
  const { status, stderr } = run(['handoff', '--token', 't', '-m', 'x', '--urgency', 'loud']);
  assert.equal(status, 2);
  assert.match(stderr, /--urgency must be/);
});

test('exit 2: handoff --expires-in out of range', () => {
  const { status, stderr } = run(['handoff', '--token', 't', '-m', 'x', '--expires-in', '5']);
  assert.equal(status, 2);
  assert.match(stderr, /between 120 and 86400/);
});

test('handoff ack (no --wait) posts kind=ack and prints machine-readable output', async () => {
  const { server, baseUrl, received } = await questionServer({
    'POST /api/agent/handoffs': () => ({ status: 201, body: { id: 'h_1', state: 'open', delivery_state: 'enqueued' } }),
  });
  try {
    const { status, stdout } = await runAsync([
      'handoff', '--token', 'tok', '--api', baseUrl, '-m', 'Ack to proceed',
    ]);
    assert.equal(status, 0);
    assert.match(stdout, /^id=h_1$/m);
    assert.match(stdout, /^state=open$/m);
    assert.match(stdout, /^delivery-state=enqueued$/m);
    assert.equal(received[0].method, 'POST');
    assert.equal(received[0].path, '/api/agent/handoffs');
    assert.equal(received[0].auth, 'Bearer tok');
    assert.deepEqual(JSON.parse(received[0].body), {
      kind: 'ack', prompt: 'Ack to proceed', audience: { type: 'direct', user_id: 'me' },
    });
  } finally {
    server.close();
  }
});

test('handoff sends the Idempotency-Key header and full question body', async () => {
  let idemHeader;
  const { server, baseUrl, received } = await questionServer({
    'POST /api/agent/handoffs': () => ({ status: 201, body: { id: 'h_2', state: 'pending', delivery_state: 'pending' } }),
  });
  // questionServer doesn't capture arbitrary headers, so wrap to grab it.
  server.removeAllListeners('request');
  server.on('request', (req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      idemHeader = req.headers['idempotency-key'];
      received.push({ method: req.method, path: req.url.split('?')[0], auth: req.headers['authorization'], body });
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'h_2', state: 'pending', delivery_state: 'pending' }));
    });
  });
  try {
    const { status } = await runAsync([
      'handoff', '--token', 'tok', '--api', baseUrl, '-m', 'Ship 1.4.0?',
      '--question', '-o', 'deploy:Deploy', '-o', 'hold:Hold',
      '--target', 'u-123', '--expires-in', '600', '--urgency', 'passive',
      '--idempotency-key', 'key-abc', '--correlation-id', 'corr-9', '--reply-to', 'r-1',
      '-d', '{"pr":42}',
    ]);
    assert.equal(status, 0);
    assert.equal(idemHeader, 'key-abc');
    assert.deepEqual(JSON.parse(received[0].body), {
      kind: 'question', prompt: 'Ship 1.4.0?',
      audience: { type: 'direct', user_id: 'u-123' },
      options: [{ value: 'deploy', label: 'Deploy' }, { value: 'hold', label: 'Hold' }],
      expires_in: 600, urgency: 'passive',
      correlation_id: 'corr-9', reply_to: 'r-1', data: { pr: 42 },
    });
  } finally {
    server.close();
  }
});

test('handoff --wait exits 0 on acked and prints acked-by', async () => {
  const { server, baseUrl } = await questionServer({
    'POST /api/agent/handoffs': () => ({ status: 201, body: { id: 'h_3', state: 'open', delivery_state: 'enqueued' } }),
    'GET /api/agent/handoffs/h_3/wait': () => ({ status: 200, body: { id: 'h_3', state: 'acked', delivery_state: null, acked_by: { id: 'u-7', display_name: 'Maya' }, acked_at: '2026-07-12T00:00:00Z' } }),
  });
  const dir = mkdtempSync(join(tmpdir(), 'pingroom-cli-delivery-state-'));
  const outputPath = join(dir, 'github-output');
  try {
    const { status, stdout } = await runAsync([
      'handoff', '--token', 'tok', '--api', baseUrl, '--wait',
      '--github-output', outputPath, '-m', 'Ack?',
    ]);
    assert.equal(status, 0);
    assert.match(stdout, /^state=acked$/m);
    assert.match(stdout, /^delivery-state=enqueued$/m);
    assert.match(stdout, /^acked-by=u-7$/m);
    const outputs = parseGitHubOutputFile(readFileSync(outputPath, 'utf8'));
    assert.equal(outputs['delivery-state'], 'enqueued');
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('handoff --wait --json preserves the raw terminal response', async () => {
  const terminal = { id: 'h_json', state: 'acked', delivery_state: null, acked_by: { id: 'u-8' } };
  const { server, baseUrl } = await questionServer({
    'POST /api/agent/handoffs': () => ({
      status: 201,
      body: { id: 'h_json', state: 'open', delivery_state: 'enqueued' },
    }),
    'GET /api/agent/handoffs/h_json/wait': () => ({ status: 200, body: terminal }),
  });
  try {
    const { status, stdout, stderr } = await runAsync([
      'handoff', '--token', 'tok', '--api', baseUrl, '--wait', '--json', '-m', 'Ack?',
    ]);
    assert.equal(status, 0, stderr);
    assert.deepEqual(JSON.parse(stdout), terminal);
  } finally {
    server.close();
  }
});

test('handoff prints an empty acked-by when the server redacts the actor id', async () => {
  const { server, baseUrl } = await questionServer({
    'POST /api/agent/handoffs': () => ({ status: 201, body: { id: 'h_redacted', state: 'open' } }),
    'GET /api/agent/handoffs/h_redacted/wait': () => ({ status: 200, body: { id: 'h_redacted', state: 'acked', acked_by: { id: null, display_name: null } } }),
  });
  try {
    const { status, stdout } = await runAsync([
      'handoff', '--token', 'tok', '--api', baseUrl, '--wait', '-m', 'Ack?',
    ]);
    assert.equal(status, 0);
    assert.match(stdout, /^acked-by=$/m);
    assert.doesNotMatch(stdout, /\[object Object\]/);
  } finally {
    server.close();
  }
});

test('handoff --wait exits 0 on a NEGATIVE answer (hold is not a failure)', async () => {
  const { server, baseUrl } = await questionServer({
    'POST /api/agent/handoffs': () => ({ status: 201, body: { id: 'h_4', state: 'pending' } }),
    'GET /api/agent/handoffs/h_4/wait': () => ({ status: 200, body: { id: 'h_4', state: 'answered', answer: { value: 'hold', label: 'Hold' } } }),
  });
  try {
    const { status, stdout } = await runAsync([
      'handoff', '--token', 'tok', '--api', baseUrl, '--wait',
      '-m', 'Ship?', '--question', '-o', 'deploy:Deploy', '-o', 'hold:Hold',
    ]);
    assert.equal(status, 0);
    assert.match(stdout, /^state=answered$/m);
    assert.match(stdout, /^answer=hold$/m);
  } finally {
    server.close();
  }
});

test('handoff --wait exits 3 on expiry', async () => {
  const { server, baseUrl } = await questionServer({
    'POST /api/agent/handoffs': () => ({ status: 201, body: { id: 'h_5', state: 'open' } }),
    'GET /api/agent/handoffs/h_5/wait': () => ({ status: 200, body: { id: 'h_5', state: 'expired' } }),
  });
  try {
    const { status, stdout } = await runAsync([
      'handoff', '--token', 'tok', '--api', baseUrl, '--wait', '-m', 'Ack?',
    ]);
    assert.equal(status, 3);
    assert.match(stdout, /^state=expired$/m);
  } finally {
    server.close();
  }
});

test('handoff exits 4 on 409 recipient_not_ready with server guidance and mobile recovery', async () => {
  const { server, baseUrl } = await questionServer({
    'POST /api/agent/handoffs': () => ({ status: 409, body: { code: 'recipient_not_ready', message: 'no device' } }),
  });
  try {
    const { status, stderr } = await runAsync([
      'handoff', '--token', 'tok', '--api', baseUrl, '-m', 'Ack?',
    ]);
    assert.equal(status, 4);
    assert.match(stderr, /no device/);
    assert.match(stderr, /Install or update PingRoom at https:\/\/pingroom\.io\/i/);
    assert.match(stderr, /open it, sign in, and enable notifications/);
    assert.match(stderr, /pingroom activate/);
  } finally {
    server.close();
  }
});

// Since 2026-09-03 the server's own recipient_not_ready message carries the
// install instruction. Repeating it underneath made the CLI say the same
// sentence twice; the hint must shrink to what the server left out.
test('handoff does not repeat the install sentence the server already sent', async () => {
  const { server, baseUrl } = await questionServer({
    'POST /api/agent/handoffs': () => ({
      status: 409,
      body: {
        code: 'recipient_not_ready',
        message: 'Install or update PingRoom, open the app, sign in, and enable notifications before retrying.',
      },
    }),
  });
  try {
    const { status, stderr } = await runAsync([
      'handoff', '--token', 'tok', '--api', baseUrl, '-m', 'Ack?',
    ]);
    assert.equal(status, 4);
    assert.equal(stderr.match(/Install or update PingRoom/g)?.length, 1);
    assert.match(stderr, /Get it at https:\/\/pingroom\.io\/i/);
    assert.match(stderr, /pingroom activate/);
  } finally {
    server.close();
  }
});

test('handoff exits 1 on a generic server error', async () => {
  const { server, baseUrl } = await questionServer({
    'POST /api/agent/handoffs': () => ({ status: 503, body: { code: 'capability_check_unavailable', message: 'down' } }),
  });
  try {
    const { status, stderr } = await runAsync([
      'handoff', '--token', 'tok', '--api', baseUrl, '-m', 'Ack?',
    ]);
    assert.equal(status, 1);
    assert.match(stderr, /handoff failed/);
  } finally {
    server.close();
  }
});
