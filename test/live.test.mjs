import test from 'node:test';
import assert from 'node:assert/strict';
import { run, runAsync, startServer, questionServer } from './helpers.mjs';

test('exit 0: live --help prints the live section (previously exit 2)', () => {
  // Before per-command help, `live -h` failed with "live needs a subcommand"
  // and `live start -h` silently ignored the flag.
  for (const argv of [['live', '--help'], ['live', '-h'], ['live', 'start', '-h']]) {
    const { status, stdout, stderr } = run(argv);
    assert.equal(status, 0, stderr);
    assert.match(stdout, /^live <start\|update\|end\|get\|claim> options/);
    assert.doesNotMatch(stdout, /hook options/);
  }
});

// `live` deliberately has no --urgent: a stream starts time-sensitive via
// `--category alert`, and the live-status endpoint does not accept is_urgent,
// so a parsed-then-dropped flag would be worse than a usage error.
test('exit 2: live rejects --urgent and points at --category alert', async () => {
  const { status, stderr } = await runAsync([
    'live', 'start', '-c', 'run-1', '-m', 'x', '--urgent', '--webhook', 'http://127.0.0.1:1/hook',
  ]);
  assert.equal(status, 2);
  assert.match(stderr, /--urgent/);
});

// ---------------------------------------------------------------------------
// live — live-status streams
// ---------------------------------------------------------------------------

test('exit 2: live needs a subcommand', () => {
  const { status, stderr } = run(['live', '-c', 'x']);
  assert.equal(status, 2);
  assert.match(stderr, /live needs a subcommand/);
});

test('exit 2: live requires a correlation id', () => {
  const { status, stderr } = run(['live', 'start']);
  assert.equal(status, 2);
  assert.match(stderr, /--correlation-id is required/);
});

test('exit 2: live rejects re-templating on update', () => {
  const { status, stderr } = run(['live', 'update', '-c', 'x', '--template', 'metrics']);
  assert.equal(status, 2);
  assert.match(stderr, /fixed at stream creation/);
});

// Number('') is 0, so an unset shell variable (`--progress "$PCT"`) used to send
// progress 0 and exit 0.
test('exit 2: live numeric flags refuse an empty or non-numeric value', () => {
  for (const [flag, value] of [
    ['--progress', ''], ['--progress', ' '], ['--progress', '50%'], ['--progress', '0x1'], ['--progress', '1e-1'],
    ['--step', ''], ['--step', '1e1'], ['--step', '0x2'],
    ['--deadline-at', ''], ['--deadline-at', ' '],
    ['--eta-at', ''], ['--eta-at', '1.7e12'],
    ['--duration-seconds', ''], ['--ack-timeout', ''],
  ]) {
    const { status, stderr } = run(['live', 'update', '-c', 'x', flag, value, '--token', 'x'.repeat(40), '--room', 'ab12cd']);
    assert.equal(status, 2, `${flag} ${JSON.stringify(value)}: ${stderr}`);
    assert.match(stderr, new RegExp(`${flag} must be a number`));
  }
});

test('exit 2: live validates --progress bounds', () => {
  const { status, stderr } = run(['live', 'update', '-c', 'x', '--progress', '5']);
  assert.equal(status, 2);
  assert.match(stderr, /--progress must be at most 1/);
});

test('exit 2: live validates the --steps label count', () => {
  const { status, stderr } = run(['live', 'start', '-c', 'x', '--steps', 'only-one']);
  assert.equal(status, 2);
  assert.match(stderr, /between 2 and 8/);
});

test('live start posts a steps stream to the agent route', async () => {
  const received = [];
  const { server, baseUrl } = await startServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ notification_id: 'n1', correlation_id: 'rel-1', state: 'started' }));
    });
  });
  try {
    const { status, stdout } = await runAsync([
      'live', 'start', '--token', 'tok', '--room', 'ab12cd', '--api', baseUrl,
      '-c', 'rel-1', '--template', 'steps', '--steps', 'Build, Test ,Ship', '-t', 'Deploy',
    ]);
    assert.equal(status, 0);
    assert.match(stdout, /live start → started/);
    assert.equal(received.length, 1);
    assert.equal(received[0].url, '/api/agent/rooms/ab12cd/live');
    assert.equal(received[0].auth, 'Bearer tok');
    assert.deepEqual(JSON.parse(received[0].body), {
      correlation_id: 'rel-1',
      live_status: { state: 'running', template: 'steps', steps: ['Build', 'Test', 'Ship'] },
      title: 'Deploy',
    });
  } finally {
    server.close();
  }
});

test('live end sends a terminal ping, and --failed flips the state', async () => {
  const received = [];
  const { server, baseUrl } = await startServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push(JSON.parse(body));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ state: 'done' }));
    });
  });
  try {
    await runAsync(['live', 'end', '--token', 't', '--room', 'r', '--api', baseUrl, '-c', 'c1', '-m', 'Shipped']);
    await runAsync(['live', 'end', '--token', 't', '--room', 'r', '--api', baseUrl, '-c', 'c1', '--failed']);

    assert.equal(received[0].live_status.state, 'done');
    assert.equal(received[0].live_status.message, 'Shipped');
    assert.equal(received[1].live_status.state, 'failed');
  } finally {
    server.close();
  }
});

test('live works through a room webhook without a token', async () => {
  const received = [];
  const { server, baseUrl } = await startServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ url: req.url, body: JSON.parse(body) });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, live_status: { state: 'running' } }));
    });
  });
  try {
    const { status } = await runAsync([
      'live', 'update', '-w', `${baseUrl}/api/webhooks/ab12cd/secret`,
      '-c', 'c2', '--progress', '0.7', '--metric', 'RPS:1.2k',
    ]);
    assert.equal(status, 0);
    assert.equal(received[0].url, '/api/webhooks/ab12cd/secret');
    assert.deepEqual(received[0].body.live_status, {
      state: 'running', progress: 0.7, metrics: [{ label: 'RPS', value: '1.2k' }],
    });
  } finally {
    server.close();
  }
});

test('live start expresses the question template via --option', async () => {
  const received = [];
  const { server, baseUrl } = await startServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push(JSON.parse(body));
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ state: 'started' }));
    });
  });
  try {
    // A bare token is both value and label; the first colon splits the rest.
    // `--accent-override` normalizes a bare hex back to `#rrggbb` so a shell
    // that ate an unquoted `#` still produces a valid payload.
    const { status } = await runAsync([
      'live', 'start', '--token', 't', '--room', 'r', '--api', baseUrl,
      '-c', 'q1', '--template', 'question', '--prompt', 'Deploy where?',
      '--option', 'prod:Production', '--option', 'staging',
      '--accent-override', 'E33122',
    ]);
    assert.equal(status, 0);
    assert.deepEqual(received[0].live_status, {
      state: 'running',
      prompt: 'Deploy where?',
      template: 'question',
      options: [
        { value: 'prod', label: 'Production' },
        { value: 'staging', label: 'staging' },
      ],
      accent_override: '#e33122',
    });
  } finally {
    server.close();
  }
});

test('live start expresses the matchup template via --left/--right/--center', async () => {
  const received = [];
  const { server, baseUrl } = await startServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push(JSON.parse(body));
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ state: 'started' }));
    });
  });
  try {
    const { status } = await runAsync([
      'live', 'start', '--token', 't', '--room', 'r', '--api', baseUrl,
      '-c', 'm1', '--template', 'matchup',
      '--left', 'ARS:2', '--right', 'CHE:1', '--center', "68'",
    ]);
    assert.equal(status, 0);
    assert.deepEqual(received[0].live_status, {
      state: 'running',
      template: 'matchup',
      left: { label: 'ARS', value: '2' },
      right: { label: 'CHE', value: '1' },
      center: "68'",
    });
  } finally {
    server.close();
  }
});

test('live rejects malformed --option, --left, and --accent-override', async () => {
  const bad = [
    [['--option', ':nope'], /--option needs a value/],
    [['--left', 'ARS'], /--left must be "label:value"/],
    [['--right', 'CHE'], /--right must be "label:value"/],
    [['--accent-override', 'nothex'], /6-digit hex color/],
  ];
  for (const [extra, pattern] of bad) {
    const { status, stderr } = await runAsync([
      'live', 'start', '--token', 't', '--room', 'r', '--api', 'https://example.com',
      '-c', 'c1', ...extra,
    ]);
    assert.equal(status, 2);
    assert.match(stderr, pattern);
  }
});

test('live get reads a stream back and prints its state', async () => {
  const { server, baseUrl } = await startServer((req, res) => {
    assert.equal(req.method, 'GET');
    assert.equal(req.url, '/api/agent/rooms/ab12cd/live/c3');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ state: 'running', progress: 0.5 }));
  });
  try {
    const { status, stdout } = await runAsync([
      'live', 'get', '--token', 't', '--room', 'ab12cd', '--api', baseUrl, '-c', 'c3',
    ]);
    assert.equal(status, 0);
    assert.equal(stdout.trim(), 'running');
  } finally {
    server.close();
  }
});

test('live surfaces the free-tier quota rejection', async () => {
  const { server, baseUrl } = await startServer((req, res) => {
    res.writeHead(402, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 'free_limit_reached', message: 'Free accounts can start 5 live streams per day.' }));
  });
  try {
    const { status, stderr } = await runAsync([
      'live', 'start', '--token', 't', '--room', 'r', '--api', baseUrl, '-c', 'c4',
    ]);
    assert.equal(status, 1);
    assert.match(stderr, /live start failed: Free accounts can start 5/);
  } finally {
    server.close();
  }
});

test('exit 2: live rejects an unknown --category', () => {
  const { status, stderr } = run(['live', 'start', '-c', 'x', '--category', 'urgent']);
  assert.equal(status, 2);
  assert.match(stderr, /--category must be status, steps or alert/);
});

// --category was validated locally but --template was not, so a typo left the
// CLI to 422 server-side — an outage-shaped failure for what is a usage error.
test('exit 2: live rejects an unknown --template', () => {
  const { status, stderr } = run(['live', 'start', '-c', 'x', '--template', 'progres']);
  assert.equal(status, 2);
  assert.match(stderr, /--template must be one of: .*progress.*matchup/);
});

test('live accepts every documented template name', () => {
  for (const name of ['status', 'steps', 'progress', 'metrics', 'countdown', 'question', 'matchup', 'claim']) {
    // No transport configured, so a valid template must fall through to the
    // "provide a webhook or a token" usage error, never to a --template one.
    const { stderr } = run(['live', 'start', '-c', 'x', '--template', name]);
    assert.doesNotMatch(stderr, /--template must be one of/, `rejected valid template "${name}"`);
  }
});

test('exit 2: live rejects --category on update', () => {
  const { status, stderr } = run(['live', 'update', '-c', 'x', '--category', 'alert']);
  assert.equal(status, 2);
  assert.match(stderr, /fixed at stream creation/);
});

test('live start sends category=alert for a time-sensitive stream', async () => {
  const received = [];
  const { server, baseUrl } = await startServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push(JSON.parse(body));
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ state: 'started' }));
    });
  });
  try {
    const { status } = await runAsync([
      'live', 'start', '--token', 't', '--room', 'r', '--api', baseUrl,
      '-c', 'incident-1', '--category', 'alert', '-m', '5xx climbing',
    ]);
    assert.equal(status, 0);
    // `alert` is the only urgency lever that does not also demand an ack.
    assert.deepEqual(received[0].live_status, {
      state: 'running', category: 'alert', message: '5xx climbing',
    });
  } finally {
    server.close();
  }
});

test('live rejects an empty --data the same way ping does', () => {
  // `if (args.data)` dropped `-d ''` on the floor and shipped the ping without
  // it; ping/ask/handoff all reject it. Silently sending different data than
  // the caller asked for is the worst of the three options.
  const live = run(['live', 'start', '-c', 'x', '--token', 't', '--room', 'ab12cd', '-d', '']);
  assert.equal(live.status, 2);
  assert.match(live.stderr, /--data must be valid JSON/);

  const png = run(['ping', '-w', 'https://example.test/hook', '-m', 'hi', '-d', '']);
  assert.equal(png.status, 2);
  assert.match(png.stderr, /--data must be valid JSON/);
});

test('live accepts "decision" — the name the app shows — and sends the wire id', async () => {
  for (const typed of ['decision', 'question']) {
    const { server, baseUrl, received } = await questionServer({
      'POST /api/agent/rooms/ab12cd/live': () => ({ status: 201, body: { state: 'running' } }),
    });
    try {
      const { status } = await runAsync([
        'live', 'start', '-c', 'deploy-1', '--template', typed,
        '--prompt', 'Ship it?', '--option', 'yes:Ship', '--option', 'no:Hold',
        '--token', 'tok', '--room', 'ab12cd', '--api', baseUrl,
      ]);
      assert.equal(status, 0);
      // The template was renamed for people, not on the wire: the API and the
      // Lock Screen still speak `question`, so both spellings must arrive as it.
      assert.equal(JSON.parse(received[0].body).live_status.template, 'question');
    } finally {
      server.close();
    }
  }
});

test('an unknown template names the alias, not the wire id, in the usage error', async () => {
  const { status, stderr } = await runAsync([
    'live', 'start', '-c', 'x', '--template', 'nope',
    '--token', 'tok', '--room', 'ab12cd', '--api', 'https://api.pingroom.io',
  ]);
  assert.equal(status, 2);
  assert.match(stderr, /decision/);
  assert.doesNotMatch(stderr, /question/);
});

// CL-02: `live -a two` posted "action": null, so the card silently had no action.
test('live refuses a --action that is not a slot from 1 to 16, and sends a valid one as a number', async () => {
  const received = [];
  const { server, baseUrl } = await startServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ state: 'running' }));
    });
  });
  try {
    const base = ['live', 'start', '-c', 'rel-1', '--token', 'tok', '--room', 'ab12cd', '--api', baseUrl];
    for (const bad of ['two', '2a', '#2', '0', '17', '']) {
      const { status, stderr } = await runAsync([...base, '-a', bad]);
      assert.equal(status, 2, `-a ${JSON.stringify(bad)}: ${stderr}`);
      assert.match(stderr, /--action must be an integer 1–16/);
    }
    assert.equal(received.length, 0);
    const ok = await runAsync([...base, '-a', '3']);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(JSON.parse(received[0]).action, 3);
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------
// live claim — "Who's on it?"
// ---------------------------------------------------------------------------

const NOTIFICATION_ID = '0198f3c2-6f0e-7d3a-9a55-3b1c2d4e5f60';

test('live start --template claim sends the request as a 120-character title and prints the notification id', async () => {
  const received = [];
  const { server, baseUrl } = await startServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ url: req.url, body });
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ notification_id: NOTIFICATION_ID, correlation_id: 'milk-1', state: 'started' }));
    });
  });
  try {
    const request = 'Buy milk and eggs on the way home. '.repeat(3).slice(0, 110);
    const { status, stdout } = await runAsync([
      'live', 'start', '--token', 'tok', '--room', 'ab12cd', '--api', baseUrl,
      '-c', 'milk-1', '--template', 'claim', '-t', request, '--deadline-at', '1794148500',
    ]);
    assert.equal(status, 0);
    assert.match(stdout, /live start → started/);
    assert.match(stdout, new RegExp(`notification_id: ${NOTIFICATION_ID}`));
    assert.deepEqual(JSON.parse(received[0].body), {
      correlation_id: 'milk-1',
      live_status: { state: 'running', template: 'claim', deadline_at: 1794148500 },
      title: request,
    });
  } finally {
    server.close();
  }
});

test('exit 2: a title over 40 characters is still refused for every template but claim, and over 120 for claim', () => {
  const long = 'x'.repeat(41);
  let result = run(['live', 'start', '-c', 'x', '-t', long]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--title must be at most 40 characters/);
  result = run(['live', 'start', '-c', 'x', '--template', 'claim', '-t', 'x'.repeat(121)]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--title must be at most 120 characters/);
});

test('live claim posts the action to the transition route and prints who holds it', async () => {
  const received = [];
  const { server, baseUrl } = await startServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      const released = JSON.parse(body).action === 'release';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        notification_id: NOTIFICATION_ID, correlation_id: 'milk-1', state: 'running', idempotent: false,
        claim: { status: released ? 'open' : 'claimed', by: released ? null : { id: 'u1', name: 'Alex' }, at: released ? null : 1794146700, late: false },
      }));
    });
  });
  try {
    // The action defaults to claim.
    let result = await runAsync([
      'live', 'claim', '--token', 'tok', '--room', 'ab12cd', '--api', baseUrl, '-n', NOTIFICATION_ID,
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /live claim claim → claimed by Alex ✅/);
    result = await runAsync([
      'live', 'claim', 'release', '--token', 'tok', '--room', 'ab12cd', '--api', baseUrl, '--notification-id', NOTIFICATION_ID,
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(received.length, 2);
    for (const call of received) {
      assert.equal(call.method, 'POST');
      assert.equal(call.url, `/api/agent/rooms/ab12cd/live/${NOTIFICATION_ID}/claim`);
      assert.equal(call.auth, 'Bearer tok');
    }
    assert.deepEqual(received.map((call) => JSON.parse(call.body)), [{ action: 'claim' }, { action: 'release' }]);
  } finally {
    server.close();
  }
});

test('live claim exits 1 with the server message when someone got it first', async () => {
  const { server, baseUrl } = await startServer((req, res) => {
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      code: 'claim_conflict', message: 'Sam is already on it.', state: 'running',
      claim: { status: 'claimed', by: { id: 'u2', name: 'Sam' }, at: 1794146700, late: false },
    }));
  });
  try {
    const { status, stderr } = await runAsync([
      'live', 'claim', '--token', 'tok', '--room', 'ab12cd', '--api', baseUrl, '-n', NOTIFICATION_ID,
    ]);
    assert.equal(status, 1);
    assert.match(stderr, /live claim claim failed: Sam is already on it\./);
  } finally {
    server.close();
  }
});

test('live claim marks a repeated action as no change', async () => {
  const { server, baseUrl } = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      notification_id: NOTIFICATION_ID, correlation_id: 'milk-1', state: 'running', idempotent: true,
      claim: { status: 'claimed', by: { id: 'u1', name: 'Alex' }, at: 1794146700, late: false },
    }));
  });
  try {
    const { status, stdout } = await runAsync([
      'live', 'claim', '--token', 'tok', '--room', 'ab12cd', '--api', baseUrl, '-n', NOTIFICATION_ID,
    ]);
    assert.equal(status, 0);
    assert.match(stdout, /\(no change\)/);
  } finally {
    server.close();
  }
});

test('exit 2: live claim usage errors', () => {
  const base = ['--token', 'x'.repeat(40), '--room', 'ab12cd'];
  let result = run(['live', 'claim', 'grab', '-n', NOTIFICATION_ID, ...base]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /live claim takes an action: claim \| release \| done \| cancel/);
  result = run(['live', 'claim', ...base]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--notification-id is required/);
  result = run(['live', 'claim', '-n', NOTIFICATION_ID, '--room', 'ab12cd']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /requires an agent token/);
  result = run(['live', 'claim', '-n', NOTIFICATION_ID, '--webhook', 'http://127.0.0.1:1/hook']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /webhook has no member to act as/);
});

function claimReceipt(action = 'claim', idempotent = false) {
  const [status, state] = { claim: ['claimed', 'running'], release: ['open', 'running'], done: ['done', 'done'], cancel: ['cancelled', 'failed'] }[action];
  return {
    notification_id: NOTIFICATION_ID, correlation_id: 'milk-1', state, idempotent,
    claim: { status, by: action === 'release' ? null : { id: 'member-1', name: 'Alex', image_url: null }, at: action === 'release' ? null : 1794146700, late: false },
  };
}

test('live claim accepts each documented transition and idempotent receipt, including nullable actor metadata', async () => {
  let receipt;
  const received = [];
  const { server, baseUrl } = await startServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      received.push(JSON.parse(body));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(receipt));
    });
  });
  try {
    for (const action of ['claim', 'release', 'done', 'cancel']) {
      for (const idempotent of [false, true]) {
        receipt = claimReceipt(action, idempotent);
        // Finishing an open request does not imply anyone previously took it.
        if (action === 'done') receipt.claim.at = null;
        if (action === 'cancel') receipt.claim.by = null;
        const before = received.length;
        const result = await runAsync(['live', 'claim', action, '-n', NOTIFICATION_ID.toUpperCase(), '--room', 'ab12cd', '--token', 'synthetic', '--api', baseUrl, '--json']);
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), receipt);
        assert.equal(received.length, before + 1);
        assert.deepEqual(received.at(-1), { action });
      }
    }
  } finally { server.close(); }
});

test('live claim rejects unusable success receipts without printing success or repeating the POST', async () => {
  const changed = (mutate) => { const receipt = claimReceipt('done'); mutate(receipt); return receipt; };
  const invalid = [
    {}, null, [],
    changed((r) => { r.notification_id = 'other-notification'; }),
    changed((r) => { delete r.notification_id; }),
    changed((r) => { r.correlation_id = ''; }),
    changed((r) => { r.idempotent = 'false'; }),
    changed((r) => { delete r.idempotent; }),
    changed((r) => { r.state = 'running'; }),
    changed((r) => { r.claim = null; }),
    changed((r) => { r.claim.status = 'claimed'; r.state = 'running'; }),
    changed((r) => { r.claim.status = 'expired'; r.state = 'failed'; }),
    changed((r) => { r.claim.by = []; }),
    changed((r) => { r.claim.by.id = ''; }),
    changed((r) => { r.claim.by.name = 42; }),
    changed((r) => { r.claim.at = '1794146700'; }),
    changed((r) => { delete r.claim.at; }),
    changed((r) => { r.claim.late = 'false'; }),
  ];
  let receipt;
  let requests = 0;
  const { server, baseUrl } = await startServer((req, res) => {
    requests += 1;
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(receipt));
    });
  });
  try {
    for (const candidate of invalid) for (const json of [false, true]) {
      receipt = candidate;
      const before = requests;
      const result = await runAsync(['live', 'claim', 'done', '-n', NOTIFICATION_ID, '--room', 'ab12cd', '--token', 'synthetic', '--api', baseUrl, ...(json ? ['--json'] : [])]);
      assert.equal(result.status, 1, JSON.stringify(candidate));
      assert.equal(result.stdout, '', 'no receipt or success mark may escape validation');
      assert.match(result.stderr, /invalid receipt; the action may have completed/);
      assert.equal(requests, before + 1, 'an uncertain action must not be retried automatically');
    }
  } finally { server.close(); }
});

test('live claim preserves refusal JSON and exits nonzero without retrying', async () => {
  const receipt = { code: 'claim_conflict', message: 'Sam got it first.', claim: { status: 'claimed', by: { id: 'member-2', name: 'Sam' } }, state: 'running' };
  let requests = 0;
  const { server, baseUrl } = await startServer((req, res) => {
    requests += 1;
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(receipt));
  });
  try {
    const result = await runAsync(['live', 'claim', '-n', NOTIFICATION_ID, '--room', 'ab12cd', '--token', 'synthetic', '--api', baseUrl, '--json']);
    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(result.stdout), receipt);
    assert.match(result.stderr, /Sam got it first/);
    assert.equal(requests, 1);
  } finally { server.close(); }
});

test('live claim refuses unread stream flags and other live commands refuse notification-id before any request', async () => {
  const { server, baseUrl, received } = await questionServer({});
  try {
    const common = ['--token', 'synthetic', '--room', 'ab12cd', '--api', baseUrl];
    for (const flag of [
      ['--failed'], ['--correlation-id', 'milk-1'], ['--title', 'x'], ['--message', 'x'], ['--template', 'claim'],
      ['--category', 'status'], ['--progress', '0.5'], ['--step', '1'], ['--steps', 'a,b'], ['--metric', 'a:1'],
      ['--deadline-at', '1794146700'], ['--duration-seconds', '60'], ['--eta-at', '1794146700'], ['--prompt', 'x'],
      ['--option', 'a:A'], ['--left', 'a'], ['--right', 'b'], ['--center', 'c'], ['--accent-override', '123456'],
      ['--action', '1'], ['--data', '{}'], ['--require-ack'], ['--ack-timeout', '60'],
    ]) {
      const result = await runAsync(['live', 'claim', '-n', NOTIFICATION_ID, ...common, ...flag]);
      assert.equal(result.status, 2, `${flag[0]}: ${result.stderr}`);
      assert.match(result.stderr, new RegExp(`${flag[0]} is not supported by live claim`));
    }
    for (const sub of ['start', 'update', 'end', 'get']) for (const flag of ['--notification-id', '-n']) {
      const result = await runAsync(['live', sub, '-c', 'milk-1', flag, NOTIFICATION_ID, ...common]);
      assert.equal(result.status, 2, result.stderr);
      assert.match(result.stderr, /--notification-id is only supported by live claim/);
    }
    assert.equal(received.length, 0);
    const help = await runAsync(['live', 'claim', '--failed', '--help']);
    assert.equal(help.status, 0, help.stderr);
  } finally { server.close(); }
});
