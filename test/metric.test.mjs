import test from 'node:test';
import assert from 'node:assert/strict';
import { run, runAsync, questionServer } from './helpers.mjs';
import { buildMetricWrite, isMetricKey, normalizeMetricKey } from '../lib/metric-rules.js';
import { METRIC_MAX_PER_ROOM } from '../lib/constants.js';
import { CliExit } from '../lib/util.js';
import { parseMetricArgs } from '../lib/parser.js';

// ---------------------------------------------------------------------------
// Room metrics: `pingroom metric list|set|delete`.

const TOKEN = 'x'.repeat(40);

/** Run a function that is expected to exit through fail(), returning its stderr. */
function usageError(fn) {
  const write = process.stderr.write;
  let stderr = '';
  process.stderr.write = (chunk) => { stderr += chunk; return true; };
  const exitCode = process.exitCode;
  try {
    fn();
    return null;
  } catch (error) {
    if (!(error instanceof CliExit)) throw error;
    assert.equal(error.code, 2, `exit code for: ${stderr}`);
    return stderr.trim();
  } finally {
    process.stderr.write = write;
    process.exitCode = exitCode;
  }
}

const metricBody = (overrides = {}) => ({
  key: 'mrr',
  label: 'MRR',
  format: 'currency',
  unit: 'USD',
  value: 12400,
  value_updated_at: '2026-11-11T08:12:30.000000Z',
  ...overrides,
});

test('metric --help names its verbs and appears in the top-level help', () => {
  const one = run(['metric', '--help']);
  assert.equal(one.status, 0);
  assert.match(one.stdout, /metric set <room> <key> <value>/);
  assert.match(one.stdout, /metric set --webhook-url <url> <key> <value>/);
  assert.match(one.stdout, /metric delete <room> <key>/);
  assert.match(one.stdout, new RegExp(`at most ${METRIC_MAX_PER_ROOM}`));

  const all = run(['--help']);
  assert.match(all.stdout, /^ {2}metric {3}List, set, or delete/m);
});

// --- the client-side rules ---------------------------------------------------

test('a metric key is trimmed and lowercased, then must be 1-40 of [a-z0-9_-]', () => {
  assert.equal(normalizeMetricKey('  MRR '), 'mrr');
  for (const key of ['mrr', 'a', '0', 'open-tickets', 'a_b', 'a'.repeat(40), '9lives']) {
    assert.equal(isMetricKey(key), true, key);
  }
  for (const key of ['', '-a', '_a', 'a b', 'a.b', 'a/b', 'café', 'a'.repeat(41), 'MRR']) {
    assert.equal(isMetricKey(key), false, key);
  }
});

test('buildMetricWrite sends numbers as JSON numbers and text as strings', () => {
  assert.deepEqual(buildMetricWrite({ key: ' MRR ', value: '12400', label: 'MRR', format: 'currency', unit: 'usd' }), {
    key: 'mrr',
    body: { label: 'MRR', format: 'currency', unit: 'USD', value: 12400 },
  });
  assert.deepEqual(buildMetricWrite({ key: 'k', value: '-3.5' }).body, { value: -3.5 });
  assert.deepEqual(buildMetricWrite({ key: 'k', value: '0' }).body, { value: 0 });
  assert.deepEqual(buildMetricWrite({ key: 'k', value: 'All clear' }).body, { value: 'All clear' });
  assert.deepEqual(buildMetricWrite({ key: 'k', value: '42', format: 'text' }).body, { value: '42', format: 'text' });
  assert.deepEqual(buildMetricWrite({ key: 'k', value: 'NaN', format: 'text' }).body, { value: 'NaN', format: 'text' });
  assert.deepEqual(buildMetricWrite({ key: 'k', value: '240', format: 'unit', unit: 'ms' }).body, { format: 'unit', unit: 'ms', value: 240 });
  assert.deepEqual(buildMetricWrite({ key: 'k', value: String(1e15) }).body, { value: 1e15 });
  assert.deepEqual(buildMetricWrite({ key: 'k', value: '-1000000000000000' }).body, { value: -1e15 });
});

test('buildMetricWrite refuses what the server would refuse', () => {
  for (const [input, expected] of [
    [{ key: '', value: '1' }, /key must be 1 to 40/],
    [{ key: 'bad key', value: '1' }, /key must be 1 to 40/],
    [{ key: 'k', value: '1', label: '' }, /--label must be 1 to 24/],
    [{ key: 'k', value: '1', label: 'x'.repeat(25) }, /--label must be 1 to 24/],
    [{ key: 'k', value: '1', label: 'a\nb' }, /--label must not contain control characters/],
    [{ key: 'k', value: '1', format: 'money' }, /--format must be one of: number, currency, percent, unit, text/],
    [{ key: 'k', value: '1', format: 'number', unit: 'ms' }, /--unit is only allowed with --format currency or --format unit/],
    [{ key: 'k', value: '1', format: 'text', unit: 'ms' }, /--unit is only allowed/],
    [{ key: 'k', value: '1', format: 'percent', unit: '%' }, /--unit is only allowed/],
    [{ key: 'k', value: '1', format: 'currency', unit: 'US' }, /ISO 4217 code/],
    [{ key: 'k', value: '1', format: 'currency', unit: 'dollars' }, /ISO 4217 code/],
    [{ key: 'k', value: '1', format: 'unit', unit: 'abcdefghi' }, /--unit must be 1 to 8/],
    [{ key: 'k', value: '1', unit: '' }, /--unit must be 1 to 8/],
    [{ key: 'k', value: 'abc', format: 'number' }, /value must be a plain number/],
    [{ key: 'k', value: 'NaN', format: 'number' }, /value must be a plain number/],
    [{ key: 'k', value: 'Infinity', format: 'percent' }, /value must be a plain number/],
    [{ key: 'k', value: '1e5', format: 'number' }, /value must be a plain number/],
    [{ key: 'k', value: '0x10', format: 'number' }, /value must be a plain number/],
    [{ key: 'k', value: '', format: 'number' }, /value must be a plain number/],
    [{ key: 'k', value: '1000000000000001' }, /absolute value of at most 1000000000000000/],
    [{ key: 'k', value: '-1000000000000001', format: 'number' }, /absolute value of at most/],
    [{ key: 'k', value: '9'.repeat(400), format: 'number' }, /absolute value of at most/],
    [{ key: 'k', value: 'NaN' }, /not a number; pass --format text/],
    [{ key: 'k', value: '-Infinity' }, /not a number; pass --format text/],
    [{ key: 'k', value: 'inf' }, /not a number; pass --format text/],
    [{ key: 'k', value: 'x'.repeat(25) }, /value must be a number, or text of 1 to 24/],
    [{ key: 'k', value: 'x'.repeat(25), format: 'text' }, /value must be 1 to 24 characters for --format text/],
    [{ key: 'k', value: 'a\tb', format: 'text' }, /value must not contain control characters/],
    [{ key: 'k', value: undefined }, /a value is required/],
  ]) {
    const message = usageError(() => buildMetricWrite(input));
    assert.match(message ?? '', expected, JSON.stringify(input));
  }
});

test('the label, unit and text limits count code points, as the server does', () => {
  assert.equal(buildMetricWrite({ key: 'k', value: '1', label: '😀'.repeat(24) }).body.label.length, 48);
  assert.ok(usageError(() => buildMetricWrite({ key: 'k', value: '1', label: '😀'.repeat(25) })));
  assert.equal(buildMetricWrite({ key: 'k', value: 'é'.repeat(24), format: 'text' }).body.value.length, 24);
  assert.ok(usageError(() => buildMetricWrite({ key: 'k', value: 'é'.repeat(25), format: 'text' })));
});

// --- the parser --------------------------------------------------------------

test('metric takes a negative number as a value and refuses unknown flags', () => {
  assert.deepEqual(parseMetricArgs(['set', 'ab12cd', 'delta', '-3.5'])._, ['set', 'ab12cd', 'delta', '-3.5']);
  assert.deepEqual(parseMetricArgs(['set', 'ab12cd', 'delta', '-7', '--label', 'Delta'])._, ['set', 'ab12cd', 'delta', '-7']);
  assert.match(usageError(() => parseMetricArgs(['set', 'ab12cd', 'k', '-x'])) ?? '', /Unknown option: -x/);
  assert.match(usageError(() => parseMetricArgs(['set', 'ab12cd', 'k', '--room', 'x'])) ?? '', /--room is not supported here: a room is named by its invite code/);
  assert.match(usageError(() => parseMetricArgs(['list', 'ab12cd', '--label', 'x'])) ?? '', /--label is only supported by metric set/);
  assert.match(usageError(() => parseMetricArgs(['delete', 'ab12cd', 'k', '--format', 'text'])) ?? '', /--format is only supported by metric set/);
  assert.match(usageError(() => parseMetricArgs(['list', 'ab12cd', '--webhook-url', 'https://x'])) ?? '', /--webhook is only supported by metric set/);
  for (const alias of ['-w', '--webhook', '--webhook-url']) {
    assert.equal(parseMetricArgs(['set', alias, 'https://example.com/h', 'k', '1']).webhook, 'https://example.com/h');
  }
});

test('metric needs a token, a sub-command and the right number of arguments', () => {
  for (const [argv, expected] of [
    [['metric'], /usage: pingroom metric <list\|set\|delete>/],
    [['metric', 'bogus'], /usage: pingroom metric <list\|set\|delete>/],
    [['metric', 'list'], /usage: pingroom metric list <room>/],
    [['metric', 'list', 'ab12cd', 'extra'], /usage: pingroom metric list <room>/],
    [['metric', 'delete', 'ab12cd'], /usage: pingroom metric delete <room> <key>/],
    [['metric', 'delete', 'ab12cd', 'bad key'], /key must be 1 to 40/],
    [['metric', 'set', 'ab12cd', 'mrr'], /usage: pingroom metric set <room> <key> <value>/],
    [['metric', 'set', 'ab12cd', 'mrr', '1', 'extra'], /usage: pingroom metric set <room> <key> <value>/],
    [['metric', 'set', 'ab12cd', 'mrr', '1', '--format', 'currency', '--unit', 'US'], /ISO 4217 code/],
    [['metric', 'set', '--webhook-url', 'https://x.test/h', 'mrr'], /usage: pingroom metric set --webhook-url <url> <key> <value>/],
    [['metric', 'set', '--webhook-url', 'https://x.test/h', 'ab12cd', 'mrr', '1'], /usage: pingroom metric set --webhook-url <url> <key> <value>/],
    [['metric', 'set', '--webhook-url', 'https://x.test/h', 'mrr', '1', '--token', TOKEN], /--webhook-url cannot be combined with --token or --api/],
    [['metric', 'set', '--webhook-url', 'https://x.test/h', 'mrr', '1', '--api', 'https://api.example'], /--webhook-url cannot be combined with --token or --api/],
    [['metric', 'list', 'ab12cd'], /an agent token is required/],
    [['metric', 'set', 'ab12cd', 'mrr', '1'], /an agent token is required/],
    [['metric', 'delete', 'ab12cd', 'mrr'], /an agent token is required/],
  ]) {
    const { status, stderr } = run(argv);
    assert.equal(status, 2, `${argv.join(' ')}: ${stderr}`);
    assert.match(stderr, expected);
  }
});

// --- token mode --------------------------------------------------------------

test('metric set PUTs the key to the agent route and prints the stored value', async () => {
  const { server, baseUrl, received } = await questionServer({
    'PUT /api/agent/rooms/ab12cd/metrics/mrr': () => ({ status: 201, body: metricBody() }),
  });
  try {
    const { status, stdout, stderr } = await runAsync([
      'metric', 'set', 'ab12cd', 'MRR', '12400', '--label', 'MRR', '--format', 'currency', '--unit', 'usd',
      '--token', TOKEN, '--api', baseUrl,
    ]);
    assert.equal(status, 0, stderr);
    assert.equal(stdout, 'mrr  MRR  12400 USD  (updated 2026-11-11T08:12:30.000000Z) ✅ (created)\n');
    assert.equal(received.length, 1);
    assert.equal(received[0].auth, `Bearer ${TOKEN}`);
    assert.deepEqual(JSON.parse(received[0].body), { label: 'MRR', format: 'currency', unit: 'USD', value: 12400 });
  } finally {
    server.close();
  }
});

test('metric set with only a value leaves the label, format and unit to the server', async () => {
  const { server, baseUrl, received } = await questionServer({
    'PUT /api/agent/rooms/ab12cd/metrics/mrr': () => ({ status: 200, body: metricBody({ value: 12650 }) }),
  });
  try {
    const { status, stdout, stderr } = await runAsync(['metric', 'set', '#ab-12 cd', 'mrr', '12650', '--token', TOKEN, '--api', baseUrl]);
    assert.equal(status, 0, stderr);
    assert.doesNotMatch(stdout, /created/);
    assert.deepEqual(JSON.parse(received[0].body), { value: 12650 });
  } finally {
    server.close();
  }
});

test('metric set sends a negative number and a text value as typed', async () => {
  const { server, baseUrl, received } = await questionServer({
    'PUT /api/agent/rooms/ab12cd/metrics/delta': () => ({ status: 200, body: metricBody({ key: 'delta', label: 'delta', format: 'number', unit: null, value: -3.5 }) }),
    'PUT /api/agent/rooms/ab12cd/metrics/status': () => ({ status: 200, body: metricBody({ key: 'status', label: 'Status', format: 'text', unit: null, value: 'All clear' }) }),
  });
  try {
    const negative = await runAsync(['metric', 'set', 'ab12cd', 'delta', '-3.5', '--token', TOKEN, '--api', baseUrl]);
    assert.equal(negative.status, 0, negative.stderr);
    const text = await runAsync(['metric', 'set', 'ab12cd', 'status', 'All clear', '--label', 'Status', '--token', TOKEN, '--api', baseUrl]);
    assert.equal(text.status, 0, text.stderr);
    assert.deepEqual(JSON.parse(received[0].body), { value: -3.5 });
    assert.deepEqual(JSON.parse(received[1].body), { label: 'Status', value: 'All clear' });
    assert.match(text.stdout, /^status {2}Status {2}All clear /);
  } finally {
    server.close();
  }
});

test('metric set --json prints the raw answer and still fails on a refusal', async () => {
  const { server, baseUrl } = await questionServer({
    'PUT /api/agent/rooms/ab12cd/metrics/mrr': () => ({ status: 200, body: metricBody() }),
    'PUT /api/agent/rooms/ab12cd/metrics/full': () => ({ status: 422, body: { message: 'Maximum of 8 metrics per room reached. Please delete an existing metric first.', code: 'metrics_limit_reached' } }),
    'PUT /api/agent/rooms/ab12cd/metrics/off': () => ({ status: 403, body: { message: 'Room metrics are turned off.', code: 'feature_disabled', feature: 'rooms.metrics' } }),
    'PUT /api/agent/rooms/ab12cd/metrics/member': () => ({ status: 403, body: { message: 'Only the room owner or admins can edit metrics' } }),
  });
  try {
    const ok = await runAsync(['metric', 'set', 'ab12cd', 'mrr', '1', '--json', '--token', TOKEN, '--api', baseUrl]);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(JSON.parse(ok.stdout).key, 'mrr');

    for (const [key, expected] of [
      ['full', /metric set failed: .*Maximum of 8 metrics per room reached/],
      ['off', /metric set failed: .*Room metrics are turned off/],
      ['member', /metric set failed: .*Only the room owner or admins/],
    ]) {
      const refused = await runAsync(['metric', 'set', 'ab12cd', key, '1', '--token', TOKEN, '--api', baseUrl]);
      assert.equal(refused.status, 1, key);
      assert.equal(refused.stdout, '');
      assert.match(refused.stderr, expected);
    }
  } finally {
    server.close();
  }
});

test('metric set fails on a 2xx that is not the metric it wrote', async () => {
  const { server, baseUrl } = await questionServer({
    'PUT /api/agent/rooms/ab12cd/metrics/mrr': () => ({ status: 200, body: {} }),
    'PUT /api/agent/rooms/ab12cd/metrics/other': () => ({ status: 200, body: metricBody({ key: 'mrr' }) }),
  });
  try {
    for (const key of ['mrr', 'other']) {
      const { status, stdout, stderr } = await runAsync(['metric', 'set', 'ab12cd', key, '1', '--token', TOKEN, '--api', baseUrl]);
      assert.equal(status, 1, key);
      assert.equal(stdout, '');
      assert.match(stderr, /returned an invalid receipt/);
    }
  } finally {
    server.close();
  }
});

test('metric list prints one line per metric and strips terminal controls', async () => {
  const { server, baseUrl, received } = await questionServer({
    'GET /api/agent/rooms/ab12cd/metrics': () => ({
      status: 200,
      body: {
        limit: 8,
        metrics: [
          metricBody(),
          metricBody({ key: 'status', label: 'Sta\u001b[31mtus', format: 'text', unit: null, value: 'All clear' }),
          metricBody({ key: 'empty', label: 'Empty', format: 'number', unit: null, value: null, value_updated_at: null }),
        ],
      },
    }),
  });
  try {
    const { status, stdout, stderr } = await runAsync(['metric', 'list', 'ab12cd', '--token', TOKEN, '--api', baseUrl]);
    assert.equal(status, 0, stderr);
    assert.equal(stdout, [
      'mrr  MRR  12400 USD  (updated 2026-11-11T08:12:30.000000Z)',
      'status  Sta[31mtus  All clear  (updated 2026-11-11T08:12:30.000000Z)',
      'empty  Empty  (no value)',
      '',
    ].join('\n'));
    assert.equal(received[0].auth, `Bearer ${TOKEN}`);
  } finally {
    server.close();
  }
});

test('metric list says so when the room has none, and --json prints the raw answer', async () => {
  const { server, baseUrl } = await questionServer({
    'GET /api/agent/rooms/ab12cd/metrics': () => ({ status: 200, body: { metrics: [], limit: 8 } }),
  });
  try {
    const empty = await runAsync(['metric', 'list', 'ab12cd', '--token', TOKEN, '--api', baseUrl]);
    assert.equal(empty.stdout, '(no metrics)\n');
    const raw = await runAsync(['metric', 'list', 'ab12cd', '--json', '--token', TOKEN, '--api', baseUrl]);
    assert.deepEqual(JSON.parse(raw.stdout), { metrics: [], limit: 8 });
  } finally {
    server.close();
  }
});

test('metric delete sends DELETE for the lowercased key and reports a missing one', async () => {
  const { server, baseUrl, received } = await questionServer({
    'DELETE /api/agent/rooms/ab12cd/metrics/mrr': () => ({ status: 200, body: { message: 'Metric deleted successfully' } }),
    'DELETE /api/agent/rooms/ab12cd/metrics/gone': () => ({ status: 404, body: { message: 'Metric not found', code: 'metric_not_found' } }),
  });
  try {
    const ok = await runAsync(['metric', 'delete', 'ab12cd', 'MRR', '--token', TOKEN, '--api', baseUrl]);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ok.stdout, 'deleted\n');
    assert.equal(received[0].method, 'DELETE');

    const missing = await runAsync(['metric', 'delete', 'ab12cd', 'gone', '--token', TOKEN, '--api', baseUrl]);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /metric delete failed: .*Metric not found/);
  } finally {
    server.close();
  }
});

test('metric reads the token from PINGROOM_TOKEN and refuses a path-like key', async () => {
  const { server, baseUrl, received } = await questionServer({
    'GET /api/agent/rooms/ab12cd/metrics': () => ({ status: 200, body: { metrics: [], limit: 8 } }),
  });
  try {
    const { status } = await runAsync(['metric', 'list', 'ab12cd', '--api', baseUrl], { PINGROOM_TOKEN: TOKEN });
    assert.equal(status, 0);
    assert.equal(received[0].auth, `Bearer ${TOKEN}`);
  } finally {
    server.close();
  }
  for (const key of ['..', '.', 'a/b']) {
    const { status } = run(['metric', 'delete', 'ab12cd', key, '--token', TOKEN]);
    assert.equal(status, 2, key);
  }
});

// --- webhook mode ------------------------------------------------------------

test('metric set --webhook-url posts a top-level metric object with no credential', async () => {
  const { server, baseUrl, received } = await questionServer({
    'POST /api/webhooks/ab12cd/s3cr3t': () => ({ status: 201, body: { success: true, metric: metricBody() } }),
  });
  try {
    const { status, stdout, stderr } = await runAsync([
      'metric', 'set', '--webhook-url', `${baseUrl}/api/webhooks/ab12cd/s3cr3t`, 'MRR', '12400',
      '--label', 'MRR', '--format', 'currency', '--unit', 'USD',
    ]);
    assert.equal(status, 0, stderr);
    assert.equal(stdout, 'mrr  MRR  12400 USD  (updated 2026-11-11T08:12:30.000000Z) ✅\n');
    assert.equal(received[0].auth, undefined);
    assert.deepEqual(JSON.parse(received[0].body), {
      metric: { key: 'mrr', label: 'MRR', format: 'currency', unit: 'USD', value: 12400 },
    });
  } finally {
    server.close();
  }
});

test('metric set --webhook-url says when the stored value was repeated', async () => {
  const { server, baseUrl } = await questionServer({
    'POST /api/webhooks/ab12cd/s3cr3t': () => ({ status: 200, body: { success: true, unchanged: true, metric: metricBody() } }),
  });
  try {
    const { status, stdout } = await runAsync(['metric', 'set', '-w', `${baseUrl}/api/webhooks/ab12cd/s3cr3t`, 'mrr', '12400']);
    assert.equal(status, 0);
    assert.match(stdout, / ✅ \(unchanged\)\n$/);
  } finally {
    server.close();
  }
});

test('metric set --webhook-url fails on the webhook envelope refusals', async () => {
  const { server, baseUrl } = await questionServer({
    'POST /api/webhooks/ab12cd/bad': () => ({ status: 403, body: { success: false, error: 'invalid_secret', message: 'Invalid webhook secret' } }),
    'POST /api/webhooks/ab12cd/full': () => ({ status: 422, body: { success: false, error: 'metrics_limit_reached', code: 'metrics_limit_reached', message: 'Maximum of 8 metrics per room reached.' } }),
    'POST /api/webhooks/ab12cd/odd': () => ({ status: 200, body: { success: false, message: 'Nope' } }),
  });
  try {
    for (const [secret, expected] of [
      ['bad', /metric set failed: .*Invalid webhook secret/],
      ['full', /metric set failed: .*Maximum of 8 metrics/],
      ['odd', /metric set failed: .*Nope/],
    ]) {
      const { status, stderr } = await runAsync(['metric', 'set', '--webhook-url', `${baseUrl}/api/webhooks/ab12cd/${secret}`, 'mrr', '1']);
      assert.equal(status, 1, secret);
      assert.match(stderr, expected);
    }
  } finally {
    server.close();
  }
});

test('metric set --webhook-url refuses an unsafe URL before sending anything', () => {
  const { status, stderr } = run(['metric', 'set', '--webhook-url', 'ftp://example.com/h', 'mrr', '1']);
  assert.equal(status, 2);
  assert.match(stderr, /--webhook-url/);
});
