import test from 'node:test';
import assert from 'node:assert/strict';
import { run, runAsync, questionServer } from './helpers.mjs';

test('approval requires a prompt and validates --ttl before the network', () => {
  const noPrompt = run(['approval', '--token', 'x'.repeat(40), '--room', 'ABC123']);
  assert.equal(noPrompt.status, 2);
  assert.match(noPrompt.stderr, /an approval needs --prompt/);

  const badTtl = run(['approval', '-p', 'Deploy?', '--ttl', 'soon', '--token', 'x'.repeat(40), '--room', 'ABC123']);
  assert.equal(badTtl.status, 2);
  assert.match(badTtl.stderr, /--ttl must be an integer/);
});

// --- approval: the deploy gate -------------------------------------------
//
// This command had zero tests that reached the network, which is how it shipped
// sending the wrong payload, reading a field the server never sends, and
// exiting 0 on a denial. Every assertion below pins one of those three.

test('approval creates a two-option Question, not a legacy approval', async () => {
  const { server, baseUrl, received } = await questionServer({
    'POST /api/agent/rooms/ab12cd/questions': () => ({ status: 201, body: { id: 'q_ap', state: 'pending' } }),
  });
  try {
    const { status, stdout, stderr } = await runAsync([
      'approval', '--token', 'tok', '--room', 'ab12cd', '--api', baseUrl,
      '-p', 'Ship v2 to production?', '-c', 'build 412',
    ]);
    assert.equal(status, 0, stderr);
    assert.equal(stdout.trim(), 'q_ap');

    const create = received.find((r) => r.method === 'POST');
    assert.equal(create.path, '/api/agent/rooms/ab12cd/questions');
    const body = JSON.parse(create.body);
    // `prompt`/`context` is the Question vocabulary. The old code sent these to
    // /approvals, which wants `question`/`title`, and 422'd every time.
    assert.equal(body.prompt, 'Ship v2 to production?');
    assert.equal(body.context, 'build 412');
    assert.deepEqual(body.options, [
      { value: 'approve', label: 'Approve', style: 'primary' },
      { value: 'deny', label: 'Deny', style: 'danger' },
    ]);
  } finally {
    server.close();
  }
});

test('approval --wait exits 0 and prints the decision on approve', async () => {
  const { server, baseUrl } = await questionServer({
    'POST /api/agent/rooms/ab12cd/questions': () => ({ status: 201, body: { id: 'q_ok', state: 'pending' } }),
    'GET /api/agent/questions/q_ok/wait': () => ({
      status: 200,
      body: { id: 'q_ok', state: 'answered', answer: { value: 'approve', label: 'Approve' } },
    }),
  });
  try {
    const { status, stdout, stderr, timedOut } = await runAsync(
      ['approval', '--token', 'tok', '--room', 'ab12cd', '--api', baseUrl, '--wait', '-p', 'Ship?'],
      {},
      { timeoutMs: 15000 },
    );
    assert.equal(timedOut, false, 'the wait loop must terminate once answered');
    assert.equal(status, 0, stderr);
    assert.equal(stdout.trim(), 'approve');
  } finally {
    server.close();
  }
});

test('approval --wait exits 4 on deny — a gate must never fail open', async () => {
  const { server, baseUrl } = await questionServer({
    'POST /api/agent/rooms/ab12cd/questions': () => ({ status: 201, body: { id: 'q_no', state: 'pending' } }),
    'GET /api/agent/questions/q_no/wait': () => ({
      status: 200,
      body: { id: 'q_no', state: 'answered', answer: { value: 'deny', label: 'Deny' } },
    }),
  });
  try {
    const { status, stdout, timedOut } = await runAsync(
      ['approval', '--token', 'tok', '--room', 'ab12cd', '--api', baseUrl, '--wait', '-p', 'Ship?'],
      {},
      { timeoutMs: 15000 },
    );
    assert.equal(timedOut, false);
    // The whole point: `answered` alone is not success. Only `approve` is.
    assert.equal(status, 4);
    assert.equal(stdout.trim(), 'deny');
  } finally {
    server.close();
  }
});

test('approval --wait exits 3 on expiry and 4 on cancellation', async () => {
  for (const [state, code] of [['expired', 3], ['cancelled', 4]]) {
    const { server, baseUrl } = await questionServer({
      'POST /api/agent/rooms/ab12cd/questions': () => ({ status: 201, body: { id: 'q_x', state: 'pending' } }),
      'GET /api/agent/questions/q_x/wait': () => ({ status: 200, body: { id: 'q_x', state, answer: null } }),
    });
    try {
      const { status, stdout, stderr, timedOut } = await runAsync(
        ['approval', '--token', 'tok', '--room', 'ab12cd', '--api', baseUrl, '--wait', '-p', 'Ship?'],
        {},
        { timeoutMs: 15000 },
      );
      assert.equal(timedOut, false, `${state} must terminate the wait loop`);
      assert.equal(status, code, `${state} exits ${code}`);
      assert.equal(stdout, '', 'a non-answer leaves stdout empty for $(...)');
      assert.match(stderr, new RegExp(`approval ${state}`));
    } finally {
      server.close();
    }
  }
});

test('approval --wait re-polls a pending hold without hot-looping', async () => {
  let waits = 0;
  const { server, baseUrl } = await questionServer({
    'POST /api/agent/rooms/ab12cd/questions': () => ({ status: 201, body: { id: 'q_p', state: 'pending' } }),
    'GET /api/agent/questions/q_p/wait': () => {
      waits += 1;
      // A server that answers `pending` instantly, ignoring the hold. Without
      // the 1s floor this spins at full speed.
      return waits < 3
        ? { status: 200, body: { id: 'q_p', state: 'pending' } }
        : { status: 200, body: { id: 'q_p', state: 'answered', answer: { value: 'approve' } } };
    },
  });
  try {
    const started = Date.now();
    const { status, timedOut } = await runAsync(
      ['approval', '--token', 'tok', '--room', 'ab12cd', '--api', baseUrl, '--wait', '-p', 'Ship?'],
      {},
      { timeoutMs: 20000 },
    );
    assert.equal(timedOut, false);
    assert.equal(status, 0);
    assert.equal(waits, 3);
    assert.ok(Date.now() - started >= 2000, 'two pending rounds must cost at least the 1s floor each');
  } finally {
    server.close();
  }
});

test('approval sends Idempotency-Key as a header, never in the body', async () => {
  const { server, baseUrl, received } = await questionServer({
    'POST /api/agent/rooms/ab12cd/questions': () => ({ status: 201, body: { id: 'q_i', state: 'pending' } }),
  });
  try {
    const { status } = await runAsync([
      'approval', '--token', 'tok', '--room', 'ab12cd', '--api', baseUrl,
      '-p', 'Ship?', '--idempotency-key', 'deploy-412',
    ]);
    assert.equal(status, 0);
    const create = received.find((r) => r.method === 'POST');
    assert.equal(create.idempotency, 'deploy-412');
    assert.equal(JSON.parse(create.body).idempotency_key, undefined);
  } finally {
    server.close();
  }

  const unsafe = run([
    'approval', '-p', 'Ship?', '--idempotency-key', 'deploy-✅',
    '--token', 'x'.repeat(40), '--room', 'ABC123',
  ]);
  assert.equal(unsafe.status, 2);
  assert.match(unsafe.stderr, /--idempotency-key must be/);
});

// --- watch on an approval is a gate ------------------------------------------

/** The approve/deny options as the server presents them on a question. */
const APPROVE_DENY_WIRE = [
  { value: 'approve', label: 'Approve', primary: true, destructive: false },
  { value: 'deny', label: 'Deny', primary: false, destructive: true },
];

test('watch exits 4 when an approve/deny question is denied, 0 when approved', async () => {
  for (const [value, code] of [['deny', 4], ['approve', 0]]) {
    const { server, baseUrl } = await questionServer({
      'GET /api/agent/questions/q_gate/wait': () => ({ status: 200, body: {
        id: 'q_gate', state: 'answered', options: APPROVE_DENY_WIRE, answer: { value, label: value },
      } }),
    });
    try {
      for (const command of ['watch', 'await']) {
        const { status, stdout } = await runAsync([command, '--token', 'tok', '--api', baseUrl, 'q_gate']);
        assert.equal(status, code, `${command} on ${value}`);
        assert.equal(stdout.trim(), value);
      }
    } finally {
      server.close();
    }
  }
});

test('watch still exits 0 on any answer to a question that is not approve/deny', async () => {
  const { server, baseUrl } = await questionServer({
    'GET /api/agent/questions/q_env/wait': () => ({ status: 200, body: {
      id: 'q_env', state: 'answered',
      options: [{ value: 'hold', label: 'Hold' }, { value: 'deny', label: 'Deny' }],
      answer: { value: 'deny' },
    } }),
  });
  try {
    const { status, stdout } = await runAsync(['watch', '--token', 'tok', '--api', baseUrl, 'q_env']);
    assert.equal(status, 0);
    assert.equal(stdout.trim(), 'deny');
  } finally {
    server.close();
  }
});

test('watch and approval help say that watch resumes an approval as a gate', () => {
  assert.match(run(['watch', '--help']).stdout, /gate: exit 0 only on approve, 4 on deny/);
  assert.match(run(['approval', '--help']).stdout, /pingroom watch <id>\s+Resume a pending approval/);
});
