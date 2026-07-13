import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '..', 'bin', 'pingroom.js');

test('GitHub Action forwards acknowledgement inputs to the CLI', () => {
  const action = readFileSync(join(__dirname, '..', 'action.yml'), 'utf8');
  assert.match(action, /^  require-ack:/m);
  assert.match(action, /^  ack-timeout:/m);
  assert.match(action, /args\+=\(--require-ack\)/);
  assert.match(action, /args\+=\(--ack-timeout "\$PR_ACK_TIMEOUT"\)/);
});

test('GitHub Action exposes handoff inputs and outputs', () => {
  const action = readFileSync(join(__dirname, '..', 'action.yml'), 'utf8');
  // Handoff inputs
  assert.match(action, /^  handoff:/m);
  assert.match(action, /^  question:/m);
  assert.match(action, /^  options:/m);
  assert.match(action, /^  idempotency-key:/m);
  assert.match(action, /^  target:/m);
  assert.match(action, /^  expires-in:/m);
  assert.match(action, /^  wait:/m);
  // Outputs
  assert.match(action, /^outputs:/m);
  assert.match(action, /^  handoff-id:/m);
  assert.match(action, /^  state:/m);
  assert.match(action, /^  acknowledged-by:/m);
  assert.match(action, /^  answer:/m);
  assert.match(action, /^  delivery-state:/m);
  // The CLI owns GitHub's output-file protocol; the shell never interprets
  // untrusted answer stdout as output commands.
  assert.match(action, /args=\(handoff -m "\$PR_MESSAGE"\)/);
  assert.match(action, /Idempotency-Key/i);
  assert.match(action, /--github-output "\$GITHUB_OUTPUT"/);
  assert.doesNotMatch(action, /while IFS=['"]?=['"]? read/);
  assert.doesNotMatch(action, />>\s*"\$GITHUB_OUTPUT"/);
  assert.match(action, /exit \$code/);
  assert.match(action, /@pingroom\/cli@0\.3\.0/);
});

test('package version matches the GitHub Action CLI pin', () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(__dirname, '..', 'package-lock.json'), 'utf8'));
  const action = readFileSync(join(__dirname, '..', 'action.yml'), 'utf8');
  assert.equal(pkg.version, '0.3.0');
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.match(action, new RegExp(`@pingroom/cli@${pkg.version.replaceAll('.', '\\.')}`));
});

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

test('exit 2: --ack-timeout requires --require-ack', () => {
  const { status, stderr } = run(['ping', '-w', 'http://127.0.0.1:1/hook', '-m', 'hi', '--ack-timeout', '120']);
  assert.equal(status, 2);
  assert.match(stderr, /--ack-timeout requires --require-ack/);
});

test('exit 2: --ack-timeout needs a value', () => {
  const { status, stderr } = run([
    'ping', '-w', 'http://127.0.0.1:1/hook', '-m', 'hi', '--require-ack', '--ack-timeout',
  ]);
  assert.equal(status, 2);
  assert.match(stderr, /option --ack-timeout needs a value/);
});

test('exit 2: webhook --ack-timeout must be within 1–86400 seconds', () => {
  const { status, stderr } = run([
    'ping', '-w', 'http://127.0.0.1:1/hook', '-m', 'hi', '--require-ack', '--ack-timeout', '0',
  ]);
  assert.equal(status, 2);
  assert.match(stderr, /between 1 and 86400/);
});

test('exit 2: agent room --ack-timeout must be within 60–86400 seconds', () => {
  const { status, stderr } = run([
    'ping', '--token', 'tok', '--room', 'ab12cd', '--api', 'http://127.0.0.1:1',
    '-m', 'hi', '--require-ack', '--ack-timeout', '30',
  ]);
  assert.equal(status, 2);
  assert.match(stderr, /between 60 and 86400/);
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
    const { status, stdout } = await runAsync([
      'ping', '-w', `${baseUrl}/hook`, '-m', 'hello', '--require-ack', '--ack-timeout', '45',
    ]);
    assert.equal(status, 0);
    assert.match(stdout, /ping sent/);
    assert.equal(received.length, 1);
    assert.equal(received[0].method, 'POST');
    assert.deepEqual(JSON.parse(received[0].body), {
      message: 'hello', requires_ack: true, ack_timeout_seconds: 45,
    });
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
      '--require-ack', '--ack-timeout', '300',
    ]);
    assert.equal(status, 0);
    assert.match(stdout, /ping sent/);
    assert.equal(received[0].url, '/api/agent/rooms/ab12cd/notifications');
    assert.equal(received[0].auth, 'Bearer tok_abc');
    assert.deepEqual(JSON.parse(received[0].body), {
      message: 'shipped', title: 'CI', action_number: 2, data: { version: '1.4.0' },
      requires_ack: true, ack_timeout_seconds: 300,
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

// ---------------------------------------------------------------------------
// Questions — ask / watch / list / cancel
// ---------------------------------------------------------------------------

/** Route a stub server by "METHOD /pathname". Each handler returns { status, body }. */
function questionServer(routes) {
  const received = [];
  return startServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const path = req.url.split('?')[0];
      received.push({ method: req.method, path, query: req.url.split('?')[1] ?? '', auth: req.headers['authorization'], body });
      const handler = routes[`${req.method} ${path}`];
      const out = handler ? handler(body) : { status: 404, body: { message: 'no route' } };
      res.writeHead(out.status ?? 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out.body ?? {}));
    });
  }).then((s) => ({ ...s, received }));
}

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

test('exit 2: bad --scope', () => {
  const { status, stderr } = run(['ask', '--token', 't', '--room', 'ab12cd', '-p', 'x', '--scope', 'sideways']);
  assert.equal(status, 2);
  assert.match(stderr, /--scope must be/);
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

// ---------------------------------------------------------------------------
// handoff
// ---------------------------------------------------------------------------

function parseGitHubOutputFile(raw) {
  const lines = raw.split('\n');
  const outputs = {};
  for (let i = 0; i < lines.length;) {
    if (lines[i] === '') {
      i += 1;
      continue;
    }
    const header = /^([A-Za-z0-9_-]+)<<(.+)$/.exec(lines[i]);
    assert.ok(header, `invalid GitHub output header: ${lines[i]}`);
    const [, name, delimiter] = header;
    i += 1;
    const valueLines = [];
    while (i < lines.length && lines[i] !== delimiter) {
      valueLines.push(lines[i]);
      i += 1;
    }
    assert.equal(lines[i], delimiter, `missing delimiter for ${name}`);
    i += 1;
    outputs[name] = valueLines.join('\n');
  }
  return outputs;
}

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

    // Preserve the normal key=value stdout contract for non-Action callers.
    assert.match(stdout, /answer=ok\nstate=acked\r\nanswer=owned/);

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

test('handoff exits 4 on 409 recipient_not_ready', async () => {
  const { server, baseUrl } = await questionServer({
    'POST /api/agent/handoffs': () => ({ status: 409, body: { code: 'recipient_not_ready', message: 'no device' } }),
  });
  try {
    const { status, stderr } = await runAsync([
      'handoff', '--token', 'tok', '--api', baseUrl, '-m', 'Ack?',
    ]);
    assert.equal(status, 4);
    assert.match(stderr, /recipient not ready/);
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
