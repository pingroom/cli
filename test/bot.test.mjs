import test from 'node:test';
import assert from 'node:assert/strict';
import { run, runAsync, questionServer } from './helpers.mjs';

const E1 = '0192f3a0-1111-7000-8000-000000000001';
const E2 = '0192f3a0-2222-7000-8000-000000000002';
const E3 = '0192f3a0-3333-7000-8000-000000000003';
const LEASE_UNTIL = '2026-11-06T10:10:00Z';

const event = (id, overrides = {}) => ({
  id, type: 'message', actor: 'owner', trust: 'owner_text', delivery: 1, stale: false,
  occurred_at: '2026-11-06T10:00:00Z', room: { code: 'BOT123', name: 'Grok Bot', shared: false }, data: {},
  ...overrides,
});

const claimBody = (events) => ({
  lease_id: 'lease-1', lease_until: LEASE_UNTIL, events, open_tasks: [], room: { code: 'BOT123', name: 'Grok Bot' },
});

/** Run `pingroom bot ...` against a stub holding the given routes. */
async function bot(argv, routes) {
  const stub = await questionServer(routes);
  try {
    const result = await runAsync(['bot', ...argv, '--token', 'bot-key', '--api', stub.baseUrl], {}, { timeoutMs: 8000 });
    return { ...result, received: stub.received };
  } finally {
    stub.server.close();
  }
}

const claimRoute = (body) => ({ 'POST /api/agent/bot/claim': () => ({ status: 200, body }) });

test('bot claim posts to the claim route with the bearer token and prints the body as is', async () => {
  const body = claimBody([event(E1)]);
  const { status, stdout, received } = await bot(['claim', '--json'], claimRoute(body));
  assert.equal(status, 0);
  assert.equal(stdout, `${JSON.stringify(body)}\n`);
  assert.equal(received.length, 1);
  assert.equal(received[0].method, 'POST');
  assert.equal(received[0].path, '/api/agent/bot/claim');
  assert.equal(received[0].auth, 'Bearer bot-key');
  assert.deepEqual(JSON.parse(received[0].body), {});
});

test('bot claim --limit is sent as an integer in the body', async () => {
  const { status, received } = await bot(['claim', '--limit', '7', '--json'], claimRoute(claimBody([])));
  assert.equal(status, 0);
  assert.deepEqual(JSON.parse(received[0].body), { limit: 7 });
});

test('bot claim prints one line per event and a summary', async () => {
  const body = claimBody([
    event(E1),
    event(E2, { type: 'question', trust: 'decision', delivery: 2, stale: true }),
  ]);
  const { status, stdout, stderr } = await bot(['claim'], claimRoute(body));
  assert.equal(status, 0, stderr);
  assert.equal(stdout, [
    `${E1} message owner_text delivery=1`,
    `${E2} question decision delivery=2 stale`,
    `2 events leased until ${LEASE_UNTIL}`,
    '',
  ].join('\n'));
});

test('bot claim words a single event in the singular', async () => {
  const { stdout } = await bot(['claim'], claimRoute(claimBody([event(E1)])));
  assert.match(stdout, /^1 event leased until /m);
});

test('bot claim strips terminal controls from server text', async () => {
  const body = claimBody([event(E1, { type: 'mess\u001b[2Jage', trust: 'owner‮_text' })]);
  const { stdout } = await bot(['claim'], claimRoute(body));
  assert.doesNotMatch(stdout, /[\u001b‮]/);
  assert.match(stdout, /^\S+ mess\[2Jage owner_text delivery=1$/m);
});

test('bot claim with nothing waiting prints nothing and exits 0', async () => {
  const { status, stdout, stderr } = await bot(['claim'], claimRoute(claimBody([])));
  assert.equal(status, 0);
  assert.equal(stdout, '');
  assert.equal(stderr, '');
});

test('bot claim --json with nothing waiting still prints the body', async () => {
  const body = claimBody([]);
  const { status, stdout } = await bot(['claim', '--json'], claimRoute(body));
  assert.equal(status, 0);
  assert.equal(stdout, `${JSON.stringify(body)}\n`);
});

test('bot claim rejects a bad --limit before any request', () => {
  for (const limit of ['0', '51', '2.5', 'many']) {
    const { status, stderr } = run(['bot', 'claim', '--limit', limit, '--token', 'bot-key']);
    assert.equal(status, 2, limit);
    assert.match(stderr, /--limit must be/, limit);
  }
});

test('bot ack sends lowercase, de-duplicated event_ids and reports the outcome', async () => {
  const { status, stdout, stderr, received } = await bot(
    ['ack', E1.toUpperCase(), E2, E1],
    { 'POST /api/agent/bot/ack': () => ({ status: 200, body: { acked: [E1], unknown: [E2] } }) },
  );
  assert.equal(status, 0, stderr);
  assert.equal(received[0].method, 'POST');
  assert.equal(received[0].path, '/api/agent/bot/ack');
  assert.equal(received[0].auth, 'Bearer bot-key');
  assert.deepEqual(JSON.parse(received[0].body), { event_ids: [E1, E2] });
  assert.equal(stdout, `acked ${E1}\nunknown ${E2}\n`);
});

test('bot ack --json prints the response as is', async () => {
  const body = { acked: [E1], unknown: [] };
  const { status, stdout } = await bot(
    ['ack', E1, '--json'],
    { 'POST /api/agent/bot/ack': () => ({ status: 200, body }) },
  );
  assert.equal(status, 0);
  assert.equal(stdout, `${JSON.stringify(body)}\n`);
});

test('bot ack validates ids before sending anything', async () => {
  const stub = await questionServer({});
  try {
    const cases = [
      [['ack'], /needs at least one event id/],
      [['ack', 'not-a-uuid'], /"not-a-uuid" is not an event id/],
      [['ack', E1, 'abc'], /"abc" is not an event id/],
      [['ack', ...Array.from({ length: 51 }, (_, i) => `0192f3a0-0000-7000-8000-${String(i).padStart(12, '0')}`)], /at most 50/],
    ];
    for (const [argv, message] of cases) {
      const { status, stderr } = await runAsync(['bot', ...argv, '--token', 'bot-key', '--api', stub.baseUrl], {}, { timeoutMs: 8000 });
      assert.equal(status, 2, argv.join(' '));
      assert.match(stderr, message);
    }
    assert.equal(stub.received.length, 0);
  } finally {
    stub.server.close();
  }
});

test('bot extend posts to the extend route and prints the new lease', async () => {
  const { status, stdout, received } = await bot(
    ['extend'],
    { 'POST /api/agent/bot/extend': () => ({ status: 200, body: { lease_until: LEASE_UNTIL } }) },
  );
  assert.equal(status, 0);
  assert.equal(received[0].method, 'POST');
  assert.equal(received[0].path, '/api/agent/bot/extend');
  assert.equal(received[0].auth, 'Bearer bot-key');
  assert.equal(stdout, `lease until ${LEASE_UNTIL}\n`);
});

test('bot extend with nothing leased says so, and --json prints the body', async () => {
  const routes = { 'POST /api/agent/bot/extend': () => ({ status: 200, body: { lease_until: null } }) };
  assert.equal((await bot(['extend'], routes)).stdout, 'no leased events\n');
  assert.equal((await bot(['extend', '--json'], routes)).stdout, '{"lease_until":null}\n');
});

test('bot done with nothing waiting exits 0', async () => {
  const route = { 'POST /api/agent/bot/done': () => ({ status: 200, body: { done: true } }) };
  const human = await bot(['done'], route);
  assert.equal(human.status, 0);
  assert.equal(human.stdout, 'done\n');
  assert.equal(human.received[0].method, 'POST');
  assert.equal(human.received[0].path, '/api/agent/bot/done');
  assert.equal(human.received[0].auth, 'Bearer bot-key');
  const json = await bot(['done', '--json'], route);
  assert.equal(json.status, 0);
  assert.equal(json.stdout, '{"done":true}\n');
});

test('bot done exits 5 and prints the events when some arrived mid-run', async () => {
  const body = { done: false, lease_id: 'lease-2', lease_until: LEASE_UNTIL, events: [event(E3, { type: 'quick_action', trust: 'signal' })] };
  const route = { 'POST /api/agent/bot/done': () => ({ status: 200, body }) };
  const human = await bot(['done'], route);
  assert.equal(human.status, 5);
  assert.equal(human.stdout, `${E3} quick_action signal delivery=1\n1 event leased until ${LEASE_UNTIL}\n`);
  const json = await bot(['done', '--json'], route);
  assert.equal(json.status, 5);
  assert.equal(json.stdout, `${JSON.stringify(body)}\n`);
});

test('bot peek reads without leasing', async () => {
  const body = { pending: 1, leased: 1, dead: 0, events: [{ id: E1, type: 'message', state: 'pending', delivery: 0 }, { id: E2, type: 'ack', state: 'leased', delivery: 1 }] };
  const route = { 'GET /api/agent/bot/peek': () => ({ status: 200, body }) };
  const human = await bot(['peek'], route);
  assert.equal(human.status, 0);
  assert.equal(human.received[0].method, 'GET');
  assert.equal(human.received[0].body, '');
  assert.equal(human.received[0].auth, 'Bearer bot-key');
  assert.equal(human.stdout, `pending=1 leased=1 dead=0\n${E1} message pending delivery=0\n${E2} ack leased delivery=1\n`);
  const json = await bot(['peek', '--json'], route);
  assert.equal(json.stdout, `${JSON.stringify(body)}\n`);
});

test('404 no_bot_connection says the credential has no bot connection', async () => {
  for (const sub of ['claim', 'extend', 'done', 'peek']) {
    const method = sub === 'peek' ? 'GET' : 'POST';
    const { status, stdout, stderr } = await bot([sub, '--json'], {
      [`${method} /api/agent/bot/${sub}`]: () => ({ status: 404, body: { message: 'No bot connection.', code: 'no_bot_connection' } }),
    });
    assert.equal(status, 1, sub);
    assert.equal(stdout, '', sub);
    assert.equal(stderr, `pingroom: bot ${sub} failed: this credential has no PingRoom bot connection. Use the bot key shown when Grok Bot was connected in PingRoom.\n`);
  }
});

test('a plain 404 (the switch is off) says Grok Bot is not available', async () => {
  const { status, stdout, stderr } = await bot(['claim'], {
    'POST /api/agent/bot/claim': () => ({ status: 404, body: { message: 'The route api/agent/bot/claim could not be found.' } }),
  });
  assert.equal(status, 1);
  assert.equal(stdout, '');
  assert.equal(stderr, 'pingroom: bot claim failed: Grok Bot is not available on this PingRoom server (it is switched off).\n');
});

test('a 401 gives the existing re-authentication message', async () => {
  const { status, stdout, stderr } = await bot(['claim'], {
    'POST /api/agent/bot/claim': () => ({ status: 401, body: { message: 'Unauthenticated.' } }),
  });
  assert.equal(status, 1);
  assert.equal(stdout, '');
  assert.match(stderr, /bot claim failed: Unauthenticated\.\n {2}This credential is no longer valid — run "pingroom reconnect" to pair again\./);
});

test('other errors follow the CLI handling: server wording, exit 1, nothing on stdout', async () => {
  const cases = [
    [403, { message: 'Missing scope.', code: 'insufficient_scope' }, /bot ack failed: Missing scope\./],
    [429, { message: 'Too Many Attempts.' }, /bot ack failed: Too Many Attempts\./],
    [500, { message: 'Server Error' }, /bot ack failed: Server Error/],
  ];
  for (const [httpStatus, body, message] of cases) {
    const { status, stdout, stderr } = await bot(['ack', E1], {
      'POST /api/agent/bot/ack': () => ({ status: httpStatus, body }),
    });
    assert.equal(status, 1, String(httpStatus));
    assert.equal(stdout, '');
    assert.match(stderr, message);
  }
});

test('a 200 the CLI cannot read is an error, never "nothing to do"', async () => {
  const cases = [
    [['claim'], 'POST /api/agent/bot/claim', {}],
    [['done'], 'POST /api/agent/bot/done', { events: [] }],
    [['peek'], 'GET /api/agent/bot/peek', { pending: 0 }],
    [['ack', E1], 'POST /api/agent/bot/ack', {}],
    [['extend'], 'POST /api/agent/bot/extend', {}],
  ];
  for (const [argv, route, body] of cases) {
    const { status, stdout, stderr } = await bot([...argv, '--json'], { [route]: () => ({ status: 200, body }) });
    assert.equal(status, 1, route);
    assert.equal(stdout, '', route);
    assert.match(stderr, /unexpected response from PingRoom/, route);
  }
});

test('an unreachable server exits 1 with a network error', () => {
  const { status, stderr } = run(['bot', 'claim', '--token', 'bot-key']);
  assert.equal(status, 1);
  assert.match(stderr, /network error/);
});

test('bot usage errors exit 2 before any request', () => {
  const cases = [
    [['bot'], /usage: pingroom bot <claim\|ack\|extend\|done\|peek>/],
    [['bot', 'send'], /usage: pingroom bot/],
    [['bot', 'peek', 'extra'], /bot peek takes no arguments/],
    [['bot', 'done', E1], /bot done takes no arguments/],
    [['bot', 'ack', E1, '--limit', '3'], /--limit applies to "bot claim" only/],
    [['bot', 'peek', '--limit', '3'], /--limit applies to "bot claim" only/],
    [['bot', 'claim', '--room', 'ABC123'], /--room is not supported here: the bot mailbox belongs to the bot connection/],
    [['bot', 'claim', '--wait'], /Unknown option: --wait/],
  ];
  for (const [argv, message] of cases) {
    const { status, stderr } = run([...argv, '--token', 'bot-key']);
    assert.equal(status, 2, argv.join(' '));
    assert.match(stderr, message);
  }
});

test('bot needs a credential', () => {
  const { status, stderr } = run(['bot', 'claim']);
  assert.equal(status, 2);
  assert.match(stderr, /an agent token is required/);
});

test('bot --help prints its section, documents the done exit code, and reaches every spelling', () => {
  for (const argv of [['bot', '--help'], ['bot', '-h'], ['bot', 'claim', '-h']]) {
    const { status, stdout } = run(argv);
    assert.equal(status, 0, argv.join(' '));
    assert.match(stdout, /^bot <claim\|ack\|extend\|done\|peek> options/);
    assert.match(stdout, /exits 5/);
    assert.match(stdout, /PingRoom bot connection/);
  }
  assert.match(run(['--help']).stdout, /^ {2}bot {6}Read and answer the Grok Bot mailbox/m);
});
