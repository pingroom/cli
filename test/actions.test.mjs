import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { run, runAsync, startServer, questionServer } from './helpers.mjs';

test('a refusal the operator can fix carries the fix, not just the code', async () => {
  const cases = [
    {
      status: 403,
      body: {
        code: 'room_not_granted',
        message: 'This agent was not given access to that room.',
      },
      expect: /Connected Agents in the PingRoom app/,
      reject: /pingroom reconnect/,
    },
    {
      status: 403,
      body: { code: 'insufficient_scope', message: 'This credential lacks the required scope.' },
      expect: /legacy partial credential.*reconnect" once.*full-access connection/,
    },
  ];

  for (const { status: httpStatus, body, expect, reject } of cases) {
    const { server, baseUrl } = await startServer((req, res) => {
      res.writeHead(httpStatus, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });
    try {
      const { status, stderr } = await runAsync([
        'ping', '-m', 'hi', '--token', 'tok', '--room', 'AB12', '--api', baseUrl,
      ]);
      assert.equal(status, 1);
      // The server's own wording still leads.
      assert.match(stderr, new RegExp(body.message.slice(0, 24).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.match(stderr, expect);
      if (reject) assert.doesNotMatch(stderr, reject);
    } finally {
      server.close();
    }
  }
});

test('quick ping page slots reach ping, live, action, and webhook endpoints unchanged', async () => {
  const slots = [4, 5, 8, 9, 12, 13, 16];
  const routes = {
    'POST /hook': () => ({ body: { success: true } }),
    'POST /api/agent/rooms/AB12/notifications': () => ({ body: { success: true } }),
    'POST /api/agent/rooms/AB12/live': () => ({ body: { state: 'running' } }),
    'POST /api/agent/rooms/AB12/webhooks': () => ({ body: { id: 'hook' } }),
    'PUT /api/agent/rooms/AB12/webhooks/hook': () => ({ body: { id: 'hook' } }),
  };
  for (const slot of slots) {
    routes[`PUT /api/agent/rooms/AB12/actions/${slot}`] = () => ({ body: { action_number: slot } });
    routes[`POST /api/agent/rooms/AB12/actions/${slot}/trigger`] = () => ({ body: { success: true } });
  }
  const { server, baseUrl, received } = await questionServer(routes);
  try {
    for (const slot of slots) {
      const auth = ['--token', 'tok', '--api', baseUrl, '--room', 'AB12'];
      for (const args of [
        ['ping', '-w', `${baseUrl}/hook`, '-m', 'Ready', '-a', String(slot)],
        ['ping', ...auth, '-m', 'Ready', '-a', String(slot)],
        ['actions', 'set', String(slot), ...auth, '--label', '', '--icon', '✅'],
        ['actions', 'trigger', String(slot), ...auth],
        ['live', 'start', ...auth, '-c', 'stream', '-a', String(slot)],
        ['live', 'start', '-w', `${baseUrl}/hook`, '-c', 'stream', '-a', String(slot)],
        ['webhooks', 'create', ...auth, '--name', 'Build', '--action', String(slot)],
        ['webhooks', 'update', 'hook', ...auth, '--action', String(slot)],
      ]) {
        const result = await runAsync(args);
        assert.equal(result.status, 0, result.stderr);
      }
      const requests = received.slice(-8);
      assert.equal(JSON.parse(requests[0].body).action, slot);
      assert.equal(JSON.parse(requests[1].body).action_number, slot);
      assert.equal(requests[2].path, `/api/agent/rooms/AB12/actions/${slot}`);
      assert.deepEqual(JSON.parse(requests[2].body), { label: '', icon: '✅' });
      assert.equal(requests[3].path, `/api/agent/rooms/AB12/actions/${slot}/trigger`);
      assert.equal(JSON.parse(requests[4].body).action, slot);
      assert.equal(JSON.parse(requests[5].body).action, slot);
      assert.equal(JSON.parse(requests[6].body).action_number, slot);
      assert.equal(JSON.parse(requests[7].body).action_number, slot);
    }
    assert.equal(received.length, slots.length * 8);
  } finally {
    server.close();
  }
});

test('actions set-all preserves four-slot and full 16-slot batches in one request', async () => {
  const { server, baseUrl, received } = await questionServer({
    'PUT /api/agent/rooms/AB12/actions': (body) => ({ body: JSON.parse(body).actions }),
  });
  try {
    for (const count of [4, 16]) {
      const actions = Array.from({ length: count }, (_, i) => ({ action_number: i + 1, label: '', icon: '✅' }));
      const result = await runAsync(['actions', 'set-all', '--token', 'tok', '--api', baseUrl, '--room', 'AB12', '--actions', JSON.stringify(actions)]);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(received.at(-1).body), { actions });
      assert.deepEqual(JSON.parse(result.stdout), actions);
    }
    assert.equal(received.length, 2);
  } finally {
    server.close();
  }
});

test('extra quick ping pages retain server plan errors and reject invalid slots locally', async () => {
  const { server, baseUrl, received } = await questionServer({
    'POST /api/agent/rooms/AB12/actions/5/trigger': () => ({ status: 403, body: { code: 'pro_required', message: 'This Quick Ping page requires Pro.' } }),
  });
  try {
    const result = await runAsync(['actions', 'trigger', '5', '--token', 'tok', '--api', baseUrl, '--room', 'AB12']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /requires Pro/);
    assert.equal(received.length, 1);
    for (const slot of ['0', '17', '1.5', '01', 'NaN']) {
      const invalid = await runAsync(['ping', '-w', `${baseUrl}/hook`, '-m', 'Ready', '-a', slot]);
      assert.equal(invalid.status, 2);
      assert.match(invalid.stderr, /integer 1–16/);
    }
    assert.equal(received.length, 1);
  } finally {
    server.close();
  }
});

test('actions set validates the slot and required fields locally', () => {
  const badSlot = run(['actions', 'set', '17', '--token', 'x'.repeat(40), '--room', 'ABC123']);
  assert.equal(badSlot.status, 2);
  assert.match(badSlot.stderr, /actions set <1-16>/);

  const missing = run(['actions', 'set', '2', '--token', 'x'.repeat(40), '--room', 'ABC123']);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /needs --label \(may be empty\) and --icon/);

  // A Ping's title is optional — the emoji can be the whole name — so an empty
  // --label is a value, not a missing flag. Only the icon is still mandatory.
  const noIcon = run([
    'actions', 'set', '2', '--token', 'x'.repeat(40), '--room', 'ABC123', '--label', '',
  ]);
  assert.equal(noIcon.status, 2);
  assert.match(noIcon.stderr, /needs --label \(may be empty\) and --icon/);
});

test('actions set-all validates the batch locally before spending a request', async () => {
  const token = ['--token', 'x'.repeat(40), '--room', 'ABC123'];

  const empty = run(['actions', 'set-all', ...token]);
  assert.equal(empty.status, 2);
  assert.match(empty.stderr, /needs --set <json> \(repeatable\) or --actions <json array>/);

  const badJson = run(['actions', 'set-all', ...token, '--set', '{nope']);
  assert.equal(badJson.status, 2);
  assert.match(badJson.stderr, /--set must be valid JSON/);

  const badSlot = run(['actions', 'set-all', ...token, '--set', '{"action_number":17,"label":"x","icon":"y"}']);
  assert.equal(badSlot.status, 2);
  assert.match(badSlot.stderr, /action_number must be 1-16/);

  // Two entries for one slot would let the last silently win, and the caller
  // would never learn which of its two definitions was stored.
  const dupe = run([
    'actions', 'set-all', ...token,
    '--set', '{"action_number":2,"label":"a","icon":"1"}',
    '--set', '{"action_number":2,"label":"b","icon":"2"}',
  ]);
  assert.equal(dupe.status, 2);
  assert.match(dupe.stderr, /action_number 2 appears twice/);

  const noIcon = run(['actions', 'set-all', ...token, '--set', '{"action_number":1,"label":"x"}']);
  assert.equal(noIcon.status, 2);
  assert.match(noIcon.stderr, /needs label \(may be empty\) and icon/);

  // An emoji-only Ping is valid here exactly as it is for `actions set`, so an
  // empty label must survive local validation rather than reading as missing.
  // It goes out, so it goes to a local stub: this case used to fall through to
  // the built-in https://api.pingroom.io on every run.
  const { server, baseUrl, received } = await questionServer({
    'PUT /api/agent/rooms/ABC123/actions': () => ({ status: 200, body: { actions: [] } }),
  });
  try {
    const emojiOnly = await runAsync([
      'actions', 'set-all', ...token, '--api', baseUrl, '--set', '{"action_number":1,"label":"","icon":"🔥"}',
    ]);
    assert.equal(emojiOnly.status, 0, emojiOnly.stderr);
    assert.equal(received.length, 1);
    assert.deepEqual(JSON.parse(received[0].body), { actions: [{ action_number: 1, label: '', icon: '🔥' }] });
  } finally {
    server.close();
  }

  const tooMany = run([
    'actions', 'set-all', ...token,
    '--actions', JSON.stringify(Array.from({ length: 17 }, (_, i) => ({ action_number: i + 1, label: 'Ready', icon: '✅' }))),
  ]);
  assert.equal(tooMany.status, 2);
  assert.match(tooMany.stderr, /at most 16 action slots/);

  const notArray = run(['actions', 'set-all', ...token, '--actions', '{"action_number":1}']);
  assert.equal(notArray.status, 2);
  assert.match(notArray.stderr, /--actions must be a JSON array/);
});

test('actions trigger forwards independent acknowledgement and urgency modifiers', async () => {
  const { server, baseUrl, received } = await questionServer({
    'POST /api/agent/rooms/ab12cd/actions/1/trigger': () => ({ body: { id: 'n1' } }),
  });
  try {
    for (const [flags, expected] of [
      [[], {}],
      [['--require-ack'], { requires_ack: true }],
      [['--urgent'], { is_urgent: true }],
      [['--require-ack', '--urgent'], { requires_ack: true, is_urgent: true }],
    ]) {
      const { status, stderr } = await runAsync([
        'actions', 'trigger', '1', '--room', 'ab12cd', '--token', 'test-token',
        '--api', baseUrl, '--idempotency-key', 'press-42', ...flags,
      ]);
      assert.equal(status, 0, stderr);
      assert.deepEqual(JSON.parse(received.at(-1).body), expected);
      assert.equal(received.at(-1).idempotency, 'press-42');
    }
  } finally {
    server.close();
  }
});

for (const mode of ['any', 'all']) {
  test(`ping and quick action forward confirmation mode ${mode}`, async () => {
    const bodies = [];
    const server = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      bodies.push(JSON.parse(body));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, id: 'ping' }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      for (const args of [
        ['ping', '-w', `${base}/hook`, '-m', 'Confirm', '--require-ack'],
        ['ping', '--token', 'test', '--api', base, '--room', 'room12', '-m', 'Confirm', '--require-ack'],
        ['actions', 'trigger', '1', '--token', 'test', '--api', base, '--room', 'room12', '--require-ack'],
      ]) {
        const result = await runAsync([...args, '--ack-mode', mode, '--json']);
        assert.equal(result.status, 0, result.stderr);
      }
      assert.equal(bodies.length, 3);
      for (const body of bodies) {
        assert.equal(body.ack_mode, mode);
        assert.equal(body.requires_ack, true);
        assert.equal(body.is_urgent, undefined);
      }
    } finally { server.close(); }
  });
}

test('confirmation flags fail locally for invalid modes and unsupported commands', () => {
  for (const args of [
    ['ping', '-m', 'Confirm', '--require-ack', '--ack-mode', 'majority'],
    ['ping', '-m', 'Confirm', '--ack-mode', 'all'],
    ['actions', 'trigger', '1', '--ack-mode', 'majority'],
    ['actions', 'set', '1', '--ack-mode', 'all'],
  ]) {
    const result = run(args);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--ack-mode/);
  }
});

// ---------------------------------------------------------------------------
// Quick ping input requirements (CLI 0.12.0): a slot whose input_type is not
// none refuses a press without its detail, so `actions trigger` must be able to
// carry a location, a link, or attachments — with the same spellings `ping`
// already uses — and `actions set` must be able to configure the requirement.

test('actions trigger carries location, link and quick-action-id details in the closed data object', async () => {
  const { server, baseUrl, received } = await questionServer({
    'POST /api/agent/rooms/ab12cd/actions/2/trigger': () => ({ body: { id: 'n1' } }),
  });
  try {
    const base = ['actions', 'trigger', '2', '--room', 'ab12cd', '--token', 'test-token', '--api', baseUrl];
    const located = await runAsync([...base, '--location', '25.2048,55.2708', '--location-label', 'Dubai Mall',
      '--quick-action-id', '3f2c9c1e-6d1a-4f0e-9a7b-2b8c1d2e3f40', '--urgent']);
    assert.equal(located.status, 0, located.stderr);
    assert.deepEqual(JSON.parse(received.at(-1).body), {
      is_urgent: true,
      data: { location: { latitude: 25.2048, longitude: 55.2708, label: 'Dubai Mall' } },
      quick_action_id: '3f2c9c1e-6d1a-4f0e-9a7b-2b8c1d2e3f40',
    });

    const linked = await runAsync([...base, '--url', 'https://ci.example.com/run/42']);
    assert.equal(linked.status, 0, linked.stderr);
    assert.deepEqual(JSON.parse(received.at(-1).body), { data: { url: 'https://ci.example.com/run/42' } });
  } finally {
    server.close();
  }
});

test('actions trigger uploads --attach files first and sends only their ids', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pingroom-trigger-attach-'));
  const file = join(dir, 'receipt.pdf');
  writeFileSync(file, '%PDF-1.4 test');
  const { server, baseUrl, received } = await questionServer({
    'POST /api/agent/attachments': () => ({ body: { attachment: { id: 'att-1' } } }),
    'POST /api/agent/rooms/ab12cd/actions/3/trigger': () => ({ body: { id: 'n1' } }),
  });
  try {
    const { status, stderr } = await runAsync([
      'actions', 'trigger', '3', '--room', 'ab12cd', '--token', 'test-token', '--api', baseUrl, '--attach', file,
    ]);
    assert.equal(status, 0, stderr);
    assert.equal(received[0].path, '/api/agent/attachments');
    assert.equal(received[1].path, '/api/agent/rooms/ab12cd/actions/3/trigger');
    assert.deepEqual(JSON.parse(received[1].body), { attachment_ids: ['att-1'] });
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('actions trigger validates its detail flags locally and refuses them on other subcommands', () => {
  const base = ['actions', 'trigger', '2', '--room', 'ab12cd', '--token', 'x'.repeat(40)];
  for (const [flags, message] of [
    [['--url', 'javascript:alert(1)'], /--url must be an absolute http\(s\) URL/],
    [['--location', '91,0'], /latitude must be between/],
    [['--location-label', 'Mall'], /--location-label requires --location/],
    [['--quick-action-id', 'nope'], /--quick-action-id must be the action's uuid/],
  ]) {
    const { status, stderr } = run([...base, ...flags]);
    assert.equal(status, 2, stderr);
    assert.match(stderr, message);
  }
  const misplaced = run(['actions', 'list', '--room', 'ab12cd', '--token', 'x'.repeat(40), '--url', 'https://x.example']);
  assert.equal(misplaced.status, 2);
  assert.match(misplaced.stderr, /--url is only supported by actions trigger/);
  const inputOnTrigger = run([...base, '--input-type', 'location']);
  assert.equal(inputOnTrigger.status, 2);
  assert.match(inputOnTrigger.stderr, /--input-type is only supported by actions set/);
});

test('actions set forwards --input-type, reserves disabled slots, and still requires an icon with a label', async () => {
  const { server, baseUrl, received } = await questionServer({
    'PUT /api/agent/rooms/ab12cd/actions/2': () => ({ body: { action_number: 2 } }),
    'PUT /api/agent/rooms/ab12cd/actions': () => ({ body: [] }),
  });
  try {
    const base = ['--room', 'ab12cd', '--token', 'test-token', '--api', baseUrl];
    const typed = await runAsync(['actions', 'set', '2', ...base, '--label', 'Where?', '--icon', '📍', '--input-type', 'location']);
    assert.equal(typed.status, 0, typed.stderr);
    assert.deepEqual(JSON.parse(received.at(-1).body), { label: 'Where?', icon: '📍', input_type: 'location' });

    const disabled = await runAsync(['actions', 'set', '2', ...base, '--label', '', '--icon', '']);
    assert.equal(disabled.status, 0, disabled.stderr);
    assert.deepEqual(JSON.parse(received.at(-1).body), { label: '', icon: '' });

    const batch = await runAsync(['actions', 'set-all', ...base,
      '--set', '{"action_number":5,"label":"Receipt","icon":"📄","input_type":"pdf"}',
      '--set', '{"action_number":6,"label":"","icon":""}']);
    assert.equal(batch.status, 0, batch.stderr);
    assert.deepEqual(JSON.parse(received.at(-1).body).actions.map((a) => a.input_type ?? null), ['pdf', null]);
    assert.equal(received.length, 3);
  } finally {
    server.close();
  }
  const badType = run(['actions', 'set', '2', '--room', 'ab12cd', '--token', 'x'.repeat(40), '--label', 'x', '--icon', 'y', '--input-type', 'video']);
  assert.equal(badType.status, 2);
  assert.match(badType.stderr, /--input-type must be one of none, location, link, file, photo, pdf/);
  const noIcon = run(['actions', 'set', '2', '--room', 'ab12cd', '--token', 'x'.repeat(40), '--label', 'Named', '--icon', '']);
  assert.equal(noIcon.status, 2);
  assert.match(noIcon.stderr, /--icon is required when a label is set/);
  const badBatch = run(['actions', 'set-all', '--room', 'ab12cd', '--token', 'x'.repeat(40), '--set', '{"action_number":1,"label":"x","icon":"y","input_type":"video"}']);
  assert.equal(badBatch.status, 2);
  assert.match(badBatch.stderr, /input_type must be one of/);
});

test('actions list marks disabled slots and input requirements', async () => {
  const { server, baseUrl } = await questionServer({
    'GET /api/agent/rooms/ab12cd/actions': () => ({ body: [
      { action_number: 1, label: 'Deployed', icon: '✅', input_type: 'none' },
      { action_number: 2, label: 'Where?', icon: '📍', input_type: 'location' },
      { action_number: 3, label: '', icon: '' },
    ] }),
  });
  try {
    const { status, stdout, stderr } = await runAsync(['actions', 'list', '--room', 'ab12cd', '--token', 'test-token', '--api', baseUrl]);
    assert.equal(status, 0, stderr);
    assert.match(stdout, /1  ✅ Deployed\n/);
    assert.match(stdout, /2  📍 Where\?  \[needs location\]/);
    assert.match(stdout, /3   \(disabled\)/);
  } finally {
    server.close();
  }
});

test('actions layout reads the current pages, renumbers the kept ones and sends the snapshot', async () => {
  const stored = [
    { id: 'id-1', action_number: 1, label: 'One', icon: '1️⃣', requires_ack: true },
    { id: 'id-2', action_number: 2, label: '', icon: '' },
    { id: 'id-3', action_number: 3, label: 'Three', icon: '3️⃣', input_type: 'location', sound: 'ting' },
    { id: 'id-4', action_number: 4, label: 'Four', icon: '4️⃣' },
    { id: 'id-5', action_number: 5, label: 'Five', icon: '5️⃣' },
    { id: 'id-6', action_number: 6, label: 'Six', icon: '6️⃣', input_type: 'pdf' },
    { id: 'id-7', action_number: 7, label: '', icon: '' },
    { id: 'id-8', action_number: 8, label: 'Eight', icon: '8️⃣' },
  ];
  const { server, baseUrl, received } = await questionServer({
    'GET /api/agent/rooms/ab12cd/actions': () => ({ body: stored }),
    'PUT /api/agent/rooms/ab12cd/actions/layout': () => ({ body: stored.slice(0, 4) }),
  });
  try {
    const base = ['actions', 'layout', '--room', 'ab12cd', '--token', 'test-token', '--api', baseUrl];
    const { status, stdout, stderr } = await runAsync([...base, '--page-order', '2,new']);
    assert.equal(status, 0, stderr);
    assert.match(stdout, /layout saved: 2 page\(s\), 8 slots/);
    assert.equal(received[0].method, 'GET');
    const body = JSON.parse(received[1].body);
    assert.deepEqual(body.base_action_ids, ['id-1', 'id-2', 'id-3', 'id-4', 'id-5', 'id-6', 'id-7', 'id-8']);
    assert.deepEqual(body.page_order, [2, null]);
    assert.deepEqual(body.actions, [
      { action_number: 1, label: 'Five', icon: '5️⃣' },
      { action_number: 2, label: 'Six', icon: '6️⃣', input_type: 'pdf' },
      { action_number: 3, label: '', icon: '' },
      { action_number: 4, label: 'Eight', icon: '8️⃣' },
      { action_number: 5, label: '', icon: '' },
      { action_number: 6, label: '', icon: '' },
      { action_number: 7, label: '', icon: '' },
      { action_number: 8, label: '', icon: '' },
    ]);

    const missing = await runAsync([...base, '--page-order', '3']);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /names page 3, but the room has 2 page\(s\)/);
    assert.equal(received.length, 3);
  } finally {
    server.close();
  }
  const noOrder = run(['actions', 'layout', '--room', 'ab12cd', '--token', 'x'.repeat(40)]);
  assert.equal(noOrder.status, 2);
  assert.match(noOrder.stderr, /actions layout needs --page-order/);
  const dup = run(['actions', 'layout', '--room', 'ab12cd', '--token', 'x'.repeat(40), '--page-order', '1,1']);
  assert.equal(dup.status, 2);
  assert.match(dup.stderr, /lists page 1 twice/);
});

test('new quick-action and request-limit error codes get an actionable hint', async () => {
  for (const [status, code, hint] of [
    [422, 'quick_action_input_required', /retry with --location <lat,lng>, --url <https-url>, or --attach <file>/],
    [422, 'quick_action_input_type', /photo takes jpg\/jpeg\/png, pdf takes \.pdf/],
    [404, 'action_not_configured', /reserved but disabled/],
    [403, 'pro_required', /ROOM OWNER on Pro/],
    [409, 'quick_action_layout_changed', /pages changed since they were read/],
    [409, 'quick_action_page_in_use', /time trigger, webhook, agent binding/],
    [413, 'payload_too_large', /5 MiB each and at most 4 per ping/],
  ]) {
    const { server, baseUrl } = await questionServer({
      'POST /api/agent/rooms/ab12cd/actions/2/trigger': () => ({ status, body: { code, message: 'Server says no.' } }),
    });
    try {
      const { status: exit, stderr } = await runAsync(['actions', 'trigger', '2', '--room', 'ab12cd', '--token', 'test-token', '--api', baseUrl]);
      assert.equal(exit, 1);
      assert.match(stderr, /Server says no\./);
      assert.match(stderr, hint);
    } finally {
      server.close();
    }
  }
});
