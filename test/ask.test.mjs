import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { run, runAsync, questionServer, parseGitHubOutputFile } from './helpers.mjs';

test('exit 0: ask --help prints the ask section plus the shared flags', () => {
  const { status, stdout } = run(['ask', '--help']);
  assert.equal(status, 0);
  assert.match(stdout, /^ask options \(agent token required\):/);
  assert.match(stdout, /-p, --prompt <text>/);
  assert.match(stdout, /--token <token>/);
  assert.doesNotMatch(stdout, /ping options:/);
  assert.doesNotMatch(stdout, /Connecting:/);
});

// ---------------------------------------------------------------------------
// Questions — ask / watch / list / cancel
// ---------------------------------------------------------------------------

test('exit 2: ask without --prompt', () => {
  const { status, stderr } = run(['ask', '--token', 't', '--room', 'ab12cd']);
  assert.equal(status, 2);
  assert.match(stderr, /--prompt is required/);
});

test('exit 2: ask without a token', () => {
  const { status, stderr } = run(['ask', '--room', 'ab12cd', '-p', 'Deploy?']);
  assert.equal(status, 2);
  assert.match(stderr, /agent token is required/);
});

test('exit 2: ask without --room', () => {
  const { status, stderr } = run(['ask', '--token', 't', '-p', 'Deploy?']);
  assert.equal(status, 2);
  assert.match(stderr, /--room is required/);
});

test('exit 2: watch without an id', () => {
  const { status, stderr } = run(['watch', '--token', 't']);
  assert.equal(status, 2);
  assert.match(stderr, /question id is required/);
});

test('--expected-room-sha256 pins the resolved room for ask, list, and watch', () => {
  const expected = createHash('sha256').update('private-room', 'utf8').digest('hex');
  const commands = [
    ['ask', '--token', 't', '--room', 'other-room', '--prompt', 'Approve?'],
    ['list', '--token', 't'],
    ['watch', '--token', 't', 'q_1'],
  ];
  for (const command of commands) {
    const { status, stderr } = run([...command, '--expected-room-sha256', expected], { PINGROOM_ROOM: 'other-room' });
    assert.equal(status, 2);
    assert.match(stderr, /resolved room does not match --expected-room-sha256/);
  }
});

test('the "await" alias for watch is dispatched, documented, and shares its help', () => {
  // The alias existed in the dispatch table but nothing advertised it, so the
  // only way to find it was reading the source.
  const help = run(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /alias: await/);

  const missingId = run(['await', '--token', 't']);
  assert.equal(missingId.status, 2);
  assert.match(missingId.stderr, /question id is required/);

  const aliasHelp = run(['await', '--help']);
  assert.equal(aliasHelp.status, 0);
  assert.equal(aliasHelp.stdout, run(['watch', '--help']).stdout);
  assert.match(aliasHelp.stdout, /^watch:/);
});

test('exit 2: bad --scope', () => {
  const { status, stderr } = run(['ask', '--token', 't', '--room', 'ab12cd', '-p', 'x', '--scope', 'sideways']);
  assert.equal(status, 2);
  assert.match(stderr, /--scope must be/);
});

test('exit 2: bad --text-max', () => {
  const { status, stderr } = run([
    'ask', '--token', 't', '--room', 'ab12cd', '-p', 'x',
    '--text-input', 'Why?', '--text-max', 'lots',
  ]);
  assert.equal(status, 2);
  assert.match(stderr, /--text-max must be an integer/);
});

test('exit 2: --text-max out of range', () => {
  const { status, stderr } = run([
    'ask', '--token', 't', '--room', 'ab12cd', '-p', 'x', '--text-max', '61',
  ]);
  assert.equal(status, 2);
  assert.match(stderr, /--text-max must be an integer/);
});

test('ask (no --wait) creates the question and prints its id', async () => {
  const { server, baseUrl, received } = await questionServer({
    'POST /api/agent/rooms/ab12cd/questions': () => ({ status: 201, body: { id: 'q_1', state: 'pending' } }),
  });
  try {
    const { status, stdout } = await runAsync([
      'ask', '--token', 'tok', '--room', 'ab12cd', '--api', baseUrl,
      '-p', 'Which env?', '-o', 'prod:Production', '-o', 'staging:Staging', '--scope', 'room',
    ]);
    assert.equal(status, 0);
    assert.equal(stdout.trim(), 'q_1');
    assert.equal(received[0].auth, 'Bearer tok');
    assert.deepEqual(JSON.parse(received[0].body), {
      prompt: 'Which env?',
      options: [{ value: 'prod', label: 'Production' }, { value: 'staging', label: 'Staging' }],
      responder_scope: 'room',
    });
  } finally {
    server.close();
  }
});

test('ask sends a bounded Idempotency-Key header without adding it to the body', async () => {
  let idemHeader;
  const { server, baseUrl, received } = await questionServer({
    'POST /api/agent/rooms/ab12cd/questions': () => ({ status: 201, body: { id: 'q_idem', state: 'pending' } }),
  });
  server.removeAllListeners('request');
  server.on('request', (req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      idemHeader = req.headers['idempotency-key'];
      received.push({ method: req.method, path: req.url.split('?')[0], auth: req.headers.authorization, body });
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'q_idem', state: 'pending' }));
    });
  });
  try {
    const { status, stdout, stderr } = await runAsync([
      'ask', '--token', 'tok', '--room', 'ab12cd', '--api', baseUrl,
      '-p', 'Ship?', '--idempotency-key', 'x-publish-approval:v1:abc123',
    ]);
    assert.equal(status, 0, stderr);
    assert.equal(stdout.trim(), 'q_idem');
    assert.equal(idemHeader, 'x-publish-approval:v1:abc123');
    assert.deepEqual(JSON.parse(received[0].body), { prompt: 'Ship?' });
  } finally {
    server.close();
  }
});

test('ask rejects unsafe Idempotency-Key values before creating a question', () => {
  for (const key of ['', '   ', 'line\nbreak', 'tab\there', 'ключ', 'deploy-✅', 'café', 'x'.repeat(256)]) {
    const { status, stderr } = run([
      'ask', '--token', 'tok', '--room', 'ab12cd', '-p', 'Ship?', '--idempotency-key', key,
    ]);
    assert.equal(status, 2, key);
    assert.match(stderr, /--idempotency-key must be 1–255 printable ASCII/);
  }
});

test('--idempotency-key takes what the server takes: interior spaces, ends trimmed', async () => {
  // RequestIdempotency::keyFrom trims and accepts 1-255 characters, spaces
  // included, and 0.13.0 sent any handoff key. A workflow keyed
  // "deploy ${{ github.sha }}" must keep working across the pin bump.
  const { server, baseUrl, received } = await questionServer({
    'POST /api/agent/rooms/ab12cd/questions': () => ({ status: 201, body: { id: 'q_s', state: 'pending' } }),
    'POST /api/agent/handoffs': () => ({ status: 201, body: { id: 'h_s', state: 'open', delivery_state: 'enqueued' } }),
    'POST /api/agent/rooms/ab12cd/actions/1/trigger': () => ({ body: { id: 'n1' } }),
  });
  try {
    for (const argv of [
      ['ask', '--room', 'ab12cd', '-p', 'Ship?'],
      ['approval', '--room', 'ab12cd', '-p', 'Ship?'],
      ['handoff', '-m', 'Ship?'],
      ['actions', 'trigger', '1', '--room', 'ab12cd'],
    ]) {
      for (const [key, sent] of [
        ['deploy 3f2c9e1', 'deploy 3f2c9e1'],
        ['  deploy 3f2c9e1 \t', 'deploy 3f2c9e1'],
        [`a ${'k'.repeat(253)}`, `a ${'k'.repeat(253)}`],
        ['!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~', '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'],
      ]) {
        const { status, stderr } = await runAsync([...argv, '--token', 'tok', '--api', baseUrl, '--idempotency-key', key]);
        assert.equal(status, 0, `${argv.join(' ')} ${JSON.stringify(key)}: ${stderr}`);
        assert.equal(received.at(-1).idempotency, sent, `${argv.join(' ')} ${JSON.stringify(key)}`);
      }
    }
  } finally {
    server.close();
  }
});

test('ask surfaces an idempotency conflict and never waits', async () => {
  const { server, baseUrl, received } = await questionServer({
    'POST /api/agent/rooms/ab12cd/questions': () => ({
      status: 409,
      body: { code: 'idempotency_conflict', message: 'Idempotency key already used for a different request.' },
    }),
  });
  try {
    const { status, stdout, stderr } = await runAsync([
      'ask', '--token', 'tok', '--room', 'ab12cd', '--api', baseUrl,
      '--wait', '-p', 'Changed?', '--idempotency-key', 'x-publish-approval:v1:abc123',
    ]);
    assert.equal(status, 1);
    assert.equal(stdout, '');
    assert.match(stderr, /ask failed: Idempotency key already used/);
    assert.equal(received.length, 1);
  } finally {
    server.close();
  }
});

test('ask serializes option styles, text_input, and reply_to', async () => {
  const { server, baseUrl, received } = await questionServer({
    'POST /api/agent/rooms/ab12cd/questions': () => ({ status: 201, body: { id: 'q_s', state: 'pending' } }),
  });
  try {
    const { status } = await runAsync([
      'ask', '--token', 'tok', '--room', 'ab12cd', '--api', baseUrl,
      '-p', 'Roll back?',
      '-o', 'yes:Roll back:danger', '-o', 'no:Keep it',
      '--text-input', 'Why?', '--text-max', '40',
      '--reply-to', 'ping_9',
    ]);
    assert.equal(status, 0);
    assert.deepEqual(JSON.parse(received[0].body), {
      prompt: 'Roll back?',
      options: [
        { value: 'yes', label: 'Roll back', style: 'danger' },
        { value: 'no', label: 'Keep it' },
      ],
      reply_to: 'ping_9',
      text_input: { placeholder: 'Why?', max_length: 40 },
    });
  } finally {
    server.close();
  }
});

test('ask --wait blocks and prints the chosen value with exit 0', async () => {
  const { server, baseUrl } = await questionServer({
    'POST /api/agent/rooms/ab12cd/questions': () => ({ status: 201, body: { id: 'q_2', state: 'pending' } }),
    'GET /api/agent/questions/q_2/wait': () => ({ status: 200, body: { id: 'q_2', state: 'answered', answer: { value: 'approve', label: 'Approve' } } }),
  });
  try {
    const { status, stdout } = await runAsync([
      'ask', '--token', 'tok', '--room', 'ab12cd', '--api', baseUrl, '--wait', '-p', 'Deploy?',
    ]);
    assert.equal(status, 0);
    assert.equal(stdout.trim(), 'approve');
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------
// Polls — ask --poll (resolution_policy: all)
// ---------------------------------------------------------------------------

function pollResults(counts, audience) {
  const options = Object.entries(counts).map(([value, count]) => ({ value, label: value, count }));
  const voted = options.reduce((sum, o) => sum + o.count, 0);
  return { audience_count: audience, response_count: voted, options, responses: [], viewer: null };
}

test('ask --poll sends resolution_policy all and leaves the scope to the server', async () => {
  const { server, baseUrl, received } = await questionServer({
    'POST /api/agent/rooms/ab12cd/questions': () => ({ status: 201, body: { id: 'q_poll', state: 'pending', resolution_policy: 'all' } }),
  });
  try {
    const { status, stdout, stderr } = await runAsync([
      'ask', '--token', 'tok', '--room', 'ab12cd', '--api', baseUrl,
      '-p', 'Lunch?', '-o', 'pizza:Pizza', '-o', 'tacos:Tacos', '--poll',
    ]);
    assert.equal(status, 0, stderr);
    assert.equal(stdout.trim(), 'q_poll');
    assert.equal(stderr, '');
    assert.deepEqual(JSON.parse(received[0].body), {
      prompt: 'Lunch?',
      options: [{ value: 'pizza', label: 'Pizza' }, { value: 'tacos', label: 'Tacos' }],
      resolution_policy: 'all',
    });
  } finally {
    server.close();
  }
});

test('exit 2: --poll with a direct scope, a target, or a typed answer', () => {
  const base = ['ask', '--token', 't', '--room', 'ab12cd', '-p', 'Lunch?', '--poll'];
  for (const [extra, message] of [
    [['--scope', 'direct'], /--poll asks the whole room/],
    [['--target', '0190a2b4-0000-7000-8000-000000000001'], /--poll asks the whole room/],
    [['--text-input', 'Other?'], /--poll counts option votes/],
    [['--text-max', '20'], /--poll counts option votes/],
  ]) {
    const { status, stderr } = run([...base, ...extra]);
    assert.equal(status, 2, extra.join(' '));
    assert.match(stderr, message);
  }
});

test('ask --poll --wait reports the tally on stderr and prints the winner', async () => {
  let waits = 0;
  const { server, baseUrl } = await questionServer({
    'POST /api/agent/rooms/ab12cd/questions': () => ({ status: 201, body: { id: 'q_p', state: 'pending', resolution_policy: 'all' } }),
    'GET /api/agent/questions/q_p/wait': () => {
      waits += 1;
      if (waits <= 2) {
        // Two holds time out with the same single vote: one progress line, not two.
        return { status: 200, body: { id: 'q_p', state: 'pending', resolution_policy: 'all', answer: null, results: pollResults({ pizza: 1, tacos: 0 }, 3) } };
      }
      return { status: 200, body: {
        id: 'q_p', state: 'answered', resolution_policy: 'all',
        answer: { value: 'pizza', label: 'Pizza', text: null, responder: null, answered_at: '2026-10-17T10:00:00+00:00' },
        results: pollResults({ pizza: 2, tacos: 1 }, 3),
      } };
    },
  });
  try {
    const { status, stdout, stderr } = await runAsync([
      'ask', '--token', 'tok', '--room', 'ab12cd', '--api', baseUrl, '--wait', '--poll',
      '-p', 'Lunch?', '-o', 'pizza', '-o', 'tacos',
    ]);
    assert.equal(status, 0, stderr);
    assert.equal(stdout, 'pizza\n');
    assert.equal(stderr,
      'pingroom: poll: pizza 1 · tacos 0 · 1 of 3 voted\n'
      + 'pingroom: poll closed: pizza 2 · tacos 1 · 3 of 3 voted\n');
  } finally {
    server.close();
  }
});

test('a tied poll exits 0 with nothing on stdout', async () => {
  const { server, baseUrl } = await questionServer({
    'GET /api/agent/questions/q_t/wait': () => ({ status: 200, body: {
      id: 'q_t', state: 'answered', resolution_policy: 'all', answer: null,
      results: pollResults({ pizza: 1, tacos: 1 }, 2),
    } }),
  });
  try {
    const { status, stdout, stderr } = await runAsync(['watch', '--token', 'tok', '--api', baseUrl, 'q_t']);
    assert.equal(status, 0);
    assert.equal(stdout, '');
    assert.equal(stderr, 'pingroom: poll tied: pizza 1 · tacos 1 · 2 of 2 voted\n');
  } finally {
    server.close();
  }
});

test('a poll nobody voted in exits 3 and still reports the tally', async () => {
  const { server, baseUrl } = await questionServer({
    'GET /api/agent/questions/q_e/wait': () => ({ status: 200, body: {
      id: 'q_e', state: 'expired', resolution_policy: 'all', answer: null,
      results: pollResults({ pizza: 0, tacos: 0 }, 4),
    } }),
  });
  try {
    const { status, stdout, stderr } = await runAsync(['watch', '--token', 'tok', '--api', baseUrl, 'q_e']);
    assert.equal(status, 3);
    assert.equal(stdout, '');
    assert.equal(stderr, 'pingroom: question expired\npingroom: poll: pizza 0 · tacos 0 · 0 of 4 voted\n');
  } finally {
    server.close();
  }
});

test('ask --poll says so when a room with nobody else falls back to a direct question', async () => {
  const { server, baseUrl } = await questionServer({
    'POST /api/agent/rooms/ab12cd/questions': () => ({ status: 201, body: { id: 'q_solo', state: 'pending', resolution_policy: 'first', responder_scope: 'direct' } }),
  });
  try {
    const { status, stdout, stderr } = await runAsync([
      'ask', '--token', 'tok', '--room', 'ab12cd', '--api', baseUrl, '-p', 'Lunch?', '--poll',
    ]);
    assert.equal(status, 0);
    assert.equal(stdout.trim(), 'q_solo');
    assert.match(stderr, /^pingroom: the server asked this as a direct, first-answer question \(nobody else in the room to poll\)$/m);
  } finally {
    server.close();
  }
});

test('list marks a poll with its vote count', async () => {
  const { server, baseUrl } = await questionServer({
    'GET /api/agent/questions': () => ({ status: 200, body: { questions: [
      { id: 'q_p', state: 'pending', prompt: 'Lunch?', resolution_policy: 'all', answer: null, results: pollResults({ pizza: 2, tacos: 1 }, 5) },
      { id: 'q_f', state: 'pending', prompt: 'Deploy?', resolution_policy: 'first', answer: null, results: null },
    ] } }),
  });
  try {
    const { status, stdout } = await runAsync(['list', '--token', 'tok', '--api', baseUrl]);
    assert.equal(status, 0);
    assert.match(stdout, /q_p\s+pending\s+Lunch\?  \[poll 3\/5 voted\]\n/);
    assert.match(stdout, /q_f\s+pending\s+Deploy\?\n/);
  } finally {
    server.close();
  }
});

test('ask --wait --json prints the terminal response as JSON', async () => {
  const terminal = { id: 'q_json', state: 'answered', answer: { value: 'approve', label: 'Approve' } };
  const { server, baseUrl } = await questionServer({
    'POST /api/agent/rooms/ab12cd/questions': () => ({ status: 201, body: { id: 'q_json', state: 'pending' } }),
    'GET /api/agent/questions/q_json/wait': () => ({ status: 200, body: terminal }),
  });
  try {
    const { status, stdout, stderr } = await runAsync([
      'ask', '--token', 'tok', '--room', 'ab12cd', '--api', baseUrl,
      '--wait', '--json', '-p', 'Deploy?',
    ]);
    assert.equal(status, 0, stderr);
    assert.deepEqual(JSON.parse(stdout), terminal);
  } finally {
    server.close();
  }
});

test('ask --wait exits 3 on expiry', async () => {
  const { server, baseUrl } = await questionServer({
    'POST /api/agent/rooms/ab12cd/questions': () => ({ status: 201, body: { id: 'q_3', state: 'pending' } }),
    'GET /api/agent/questions/q_3/wait': () => ({ status: 200, body: { id: 'q_3', state: 'expired', answer: null } }),
  });
  try {
    const { status, stdout, stderr } = await runAsync([
      'ask', '--token', 'tok', '--room', 'ab12cd', '--api', baseUrl, '--wait', '-p', 'Deploy?',
    ]);
    assert.equal(status, 3);
    assert.equal(stdout.trim(), '');
    assert.match(stderr, /question expired/);
  } finally {
    server.close();
  }
});

test('ask --github-output writes the answered question through the delimiter protocol', async () => {
  // The same containment the handoff path has: an answer that looks like output
  // commands must land as one value, never as extra keys.
  const maliciousAnswer = 'approve\nstate=answered\r\nquestion-id=owned\nEOF_like';
  const { server, baseUrl } = await questionServer({
    'POST /api/agent/rooms/ab12cd/questions': () => ({
      status: 201,
      body: { id: 'q_gh', state: 'pending' },
    }),
    'GET /api/agent/questions/q_gh/wait': () => ({
      status: 200,
      body: { id: 'q_gh', state: 'answered', answer: { value: maliciousAnswer, label: 'Untrusted' } },
    }),
  });
  const dir = mkdtempSync(join(tmpdir(), 'pingroom-cli-ask-output-'));
  const outputPath = join(dir, 'github-output');
  try {
    const { status, stdout, stderr } = await runAsync([
      'ask', '--token', 'tok', '--room', 'ab12cd', '--api', baseUrl, '--wait',
      '--github-output', outputPath, '-p', 'Deploy?', '-o', 'approve:Approve', '-o', 'hold:Hold',
    ]);
    assert.equal(status, 0, stderr);
    // Terminal controls are removed; the GitHub output file retains the original answer.
    assert.equal(stdout, 'approve state=answered question-id=owned EOF_like\n');

    const raw = readFileSync(outputPath, 'utf8');
    assert.match(raw, /^question-id<<pingroom_[0-9a-f]{48}$/m);
    const outputs = parseGitHubOutputFile(raw);
    assert.deepEqual(Object.keys(outputs).sort(), ['answer', 'question-id', 'state']);
    assert.equal(outputs['question-id'], 'q_gh');
    assert.equal(outputs.state, 'answered');
    assert.equal(outputs.answer, maliciousAnswer);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ask --github-output without --wait reports state=pending and no answer', async () => {
  const { server, baseUrl } = await questionServer({
    'POST /api/agent/rooms/ab12cd/questions': () => ({
      status: 201,
      body: { id: 'q_nowait', state: 'pending' },
    }),
  });
  const dir = mkdtempSync(join(tmpdir(), 'pingroom-cli-ask-pending-'));
  const outputPath = join(dir, 'github-output');
  try {
    const { status, stdout, stderr } = await runAsync([
      'ask', '--token', 'tok', '--room', 'ab12cd', '--api', baseUrl,
      '--github-output', outputPath, '-p', 'Deploy?',
    ]);
    assert.equal(status, 0, stderr);
    assert.equal(stdout.trim(), 'q_nowait');

    const outputs = parseGitHubOutputFile(readFileSync(outputPath, 'utf8'));
    // `answer` must be absent, not empty: an unanswered question has no answer.
    assert.deepEqual(Object.keys(outputs).sort(), ['question-id', 'state']);
    assert.equal(outputs['question-id'], 'q_nowait');
    assert.equal(outputs.state, 'pending');
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('exit 2: ask --github-output rejects an empty path instead of silently dropping outputs', async () => {
  const { server, baseUrl, received } = await questionServer({
    'POST /api/agent/rooms/ab12cd/questions': () => ({ status: 201, body: { id: 'q_x', state: 'pending' } }),
  });
  try {
    const { status, stderr } = await runAsync([
      'ask', '--token', 'tok', '--room', 'ab12cd', '--api', baseUrl,
      '--github-output', '', '-p', 'Deploy?',
    ]);
    assert.equal(status, 2);
    assert.match(stderr, /--github-output must be a non-empty path/);
    assert.equal(received.length, 1);
  } finally {
    server.close();
  }
});

test('list prints a row per question', async () => {
  const { server, baseUrl, received } = await questionServer({
    'GET /api/agent/questions': () => ({ status: 200, body: { questions: [
      { id: 'q_1', state: 'answered', prompt: 'Deploy?', answer: { value: 'approve' } },
      { id: 'q_2', state: 'pending', prompt: 'Merge?', answer: null },
    ] } }),
  });
  try {
    const { status, stdout } = await runAsync(['list', '--token', 'tok', '--api', baseUrl, '--state', 'all']);
    assert.equal(status, 0);
    assert.match(stdout, /q_1\s+answered\s+Deploy\? → approve/);
    assert.match(stdout, /q_2\s+pending\s+Merge\?/);
    assert.match(received[0].query, /state=all/);
  } finally {
    server.close();
  }
});

test('cancel withdraws a pending question', async () => {
  const { server, baseUrl } = await questionServer({
    'POST /api/agent/questions/q_9/cancel': () => ({ status: 200, body: { id: 'q_9', state: 'cancelled' } }),
  });
  try {
    const { status, stdout } = await runAsync(['cancel', '--token', 'tok', '--api', baseUrl, 'q_9']);
    assert.equal(status, 0);
    assert.match(stdout, /cancelled \(cancelled\)/);
  } finally {
    server.close();
  }
});

test('list sanitizes untrusted prompts and answers before terminal output', async () => {
  const { server, baseUrl } = await questionServer({
    'GET /api/agent/questions': () => ({ status: 200, body: { questions: [
      { id: 'q_1', state: 'answered', prompt: 'Ship?\x1b[2J\nforged', answer: { value: 'deny\rapproved\x9b' } },
    ] } }),
  });
  try {
    const { status, stdout } = await runAsync(['list', '--token', 'tok', '--api', baseUrl]);
    assert.equal(status, 0);
    assert.equal(stdout, 'q_1  answered   Ship?[2J forged → deny approved\n');
  } finally { server.close(); }
});
