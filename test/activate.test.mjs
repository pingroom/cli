import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, rmSync } from 'node:fs';
import {
  run, runAsync, runOnFakeTime, startServer, questionServer, newHome, seedCredential, activationEnsureResponse,
  confirmedActivationResponse, pairingServer, ACTIVE_PAIR,
} from './helpers.mjs';
import { POLL_FLOOR_MS } from '../lib/util.js';

/**
 * Pair, then run `pingroom activate`, and return the activate result.
 *
 * Connecting no longer sends a test Question — the approval the human tapped is
 * the round-trip — so every activation behaviour is now reached through the
 * explicit command. Pairing first is what gives `activate` the saved
 * QR credential (and the origin it is bound to) that it requires.
 */
async function pairThenActivate(home, baseUrl, env = {}, opts = {}, runActivate = runAsync) {
  const paired = await runAsync(
    ['--api', baseUrl],
    { PINGROOM_HOME: home, PINGROOM_INTERNAL_TEST_TTY: '1', NODE_ENV: 'test', COLUMNS: '120' },
    { stdin: '1\n' },
  );
  assert.equal(paired.status, 0, paired.stderr);

  return runActivate(['activate', '--api', baseUrl], { PINGROOM_HOME: home, NODE_ENV: 'test', ...env }, opts);
}

test('activate explains an all-rooms grant with no home room instead of blaming the pairing', () => {
  const home = newHome();
  seedCredential(home, {
    token: 'stored_tok',
    handle: 'agt_ab12cd34ef',
    room: null,
    rooms: [],
    room_access: 'all',
    scopes: ['pingroom:handoffs:create'],
    api_url: 'https://api.pingroom.io',
  });
  try {
    const { status, stderr } = run(['activate'], { PINGROOM_HOME: home });
    assert.equal(status, 2);
    assert.match(stderr, /granted all rooms but has no home room/);
    assert.match(stderr, /Connected Agents/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('activate keeps the saved connection when Agent Inbox activation cannot start', async () => {
  const home = newHome();
  const { server, baseUrl, received } = await pairingServer([ACTIVE_PAIR], {
    ensureResponses: [{
      status: 409,
      body: { code: 'no_room_configured', message: 'Choose a delivery room in PingRoom.' },
    }],
  });
  try {
    const { status, stdout, stderr } = await pairThenActivate(home, baseUrl);
    assert.equal(status, 1, stderr);
    assert.match(stdout, /Agent Inbox activation is not complete: Choose a delivery room in PingRoom/);
    assert.match(stdout, /connection is saved and usable/);
    assert.match(stdout, /Run "pingroom activate"/);
    assert.equal(JSON.parse(readFileSync(join(home, 'credentials.json'), 'utf8')).token, 'active_jwt');
    assert.equal(received.filter((r) => r.path === '/api/agent/inbox/ensure').length, 1);
    assert.equal(received.filter((r) => r.path.includes('/handoffs/')).length, 0);
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('activate keeps server guidance and gives recipient_not_ready a concrete mobile recovery', async () => {
  const home = newHome();
  const { server, baseUrl } = await pairingServer([ACTIVE_PAIR], {
    ensureResponses: [{
      status: 409,
      body: {
        code: 'recipient_not_ready',
        message: 'No supported phone has registered for this account yet.',
      },
    }],
  });
  try {
    const { status, stdout, stderr } = await pairThenActivate(home, baseUrl);
    assert.equal(status, 1, stderr);
    assert.match(stdout, /No supported phone has registered for this account yet/);
    assert.match(stdout, /Install or update PingRoom: https:\/\/pingroom\.io\/i/);
    assert.match(stdout, /Open it, sign in, and enable notifications/);
    assert.match(stdout, /run "pingroom activate" again/);
    assert.match(stdout, /connection is saved and usable/);
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('pingroom activate retries a failed activation with the saved credential', async () => {
  const home = newHome();
  const { server, baseUrl, received } = await pairingServer([ACTIVE_PAIR], {
    ensureResponses: [
      { status: 409, body: { code: 'temporarily_unavailable', message: 'Try again shortly.' } },
      activationEnsureResponse(),
    ],
  });
  try {
    const incomplete = await pairThenActivate(home, baseUrl);
    assert.equal(incomplete.status, 1, incomplete.stderr);
    assert.match(incomplete.stdout, /Run "pingroom activate"/);
    assert.doesNotMatch(incomplete.stdout, /Agent Inbox is ready/);

    const retried = await runAsync(
      ['activate', '--api', baseUrl],
      { PINGROOM_HOME: home, PINGROOM_TOKEN: 'must-not-be-used' },
    );
    assert.equal(retried.status, 0, retried.stderr);
    assert.match(retried.stdout, /Robot @agt_ab12cd34ef is connected/);
    assert.match(retried.stdout, /Agent Inbox is ready/);

    const ensureCalls = received.filter((request) => request.path === '/api/agent/inbox/ensure');
    assert.equal(ensureCalls.length, 2);
    assert.equal(ensureCalls[0].auth, 'Bearer active_jwt');
    assert.equal(ensureCalls[1].auth, 'Bearer active_jwt');
    assert.deepEqual(JSON.parse(ensureCalls[0].body), {});
    assert.equal(received.filter((request) => request.path === '/api/agent/handoffs/q-onboard/wait').length, 1);
    assert.equal(received.filter((request) => request.path === '/api/agent/auth').length, 1);
    assert.equal(JSON.parse(readFileSync(join(home, 'credentials.json'), 'utf8')).token, 'active_jwt');
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('pingroom activate rejects missing-home or originless saved credentials before HTTP', async () => {
  let requests = 0;
  const { server, baseUrl } = await startServer((req, res) => {
    requests += 1;
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  const homes = [];
  try {
    const noCredentialHome = newHome();
    homes.push(noCredentialHome);
    const noCredential = await runAsync(['activate', '--api', baseUrl], { PINGROOM_HOME: noCredentialHome });
    assert.equal(noCredential.status, 2);
    assert.match(noCredential.stderr, /no saved robot credential/);

    const emailHome = newHome();
    homes.push(emailHome);
    seedCredential(emailHome, {
      token: 'email-token', api_url: baseUrl, room: null, scopes: ['pingroom:handoffs:create'],
    });
    const email = await runAsync(['activate', '--api', baseUrl], { PINGROOM_HOME: emailHome });
    assert.equal(email.status, 2);
    assert.match(email.stderr, /saved robot has no home room/);

    const unboundHome = newHome();
    homes.push(unboundHome);
    seedCredential(unboundHome, {
      token: 'unbound-token', room: { invite_code: 'ABC123' }, scopes: ['pingroom:handoffs:create'],
    });
    const unbound = await runAsync(['activate', '--api', baseUrl], { PINGROOM_HOME: unboundHome });
    assert.equal(unbound.status, 2);
    assert.match(unbound.stderr, /no trusted API origin/);

    const wrongOriginHome = newHome();
    homes.push(wrongOriginHome);
    seedCredential(wrongOriginHome, {
      token: 'issuer-token', api_url: 'https://issuer.example.test',
      room: { invite_code: 'ABC123' }, scopes: ['pingroom:handoffs:create'],
    });
    const wrongOrigin = await runAsync(
      ['activate', '--api', baseUrl],
      { PINGROOM_HOME: wrongOriginHome, PINGROOM_TOKEN: 'explicit-env-token' },
    );
    assert.equal(wrongOrigin.status, 2);
    assert.match(wrongOrigin.stderr, /stored credential is bound to https:\/\/issuer\.example\.test/);

    assert.equal(requests, 0);
  } finally {
    server.close();
    for (const home of homes) rmSync(home, { recursive: true, force: true });
  }
});

test('pingroom activate lets the server decide access instead of rejecting saved scope metadata', async () => {
  const home = newHome();
  const { server, baseUrl, received } = await questionServer({
    'POST /api/agent/inbox/ensure': () => ({
      status: 403,
      body: { code: 'insufficient_scope', message: 'This credential cannot activate Agent Inbox.' },
    }),
  });
  try {
    seedCredential(home, {
      token: 'old-token', api_url: baseUrl, room: { invite_code: 'ABC123' }, scopes: [],
    });
    const result = await runAsync(['activate', '--api', baseUrl], { PINGROOM_HOME: home });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /This credential cannot activate Agent Inbox/);
    assert.equal(received.length, 1, 'the server, not stale local scope metadata, owns access');
    assert.equal(received[0].path, '/api/agent/inbox/ensure');
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('activate does not claim readiness when an answer lacks confirmed activation', async () => {
  for (const completion of [false, 'missing']) {
    const home = newHome();
    const terminal = {
      id: 'q-onboard',
      kind: 'question',
      state: 'answered',
      answer: {
        value: 'yes', label: 'Yes', text: null,
        responder: { id: 'u1', display_name: 'Mahdi' }, answered_at: '2026-08-09T00:01:00Z',
      },
    };
    if (completion !== 'missing') terminal.activation_completed = completion;
    const { server, baseUrl, received } = await pairingServer([ACTIVE_PAIR], {
      waitResponses: [{ status: 200, body: terminal }],
    });
    try {
      const { status, stdout, stderr } = await pairThenActivate(
        home,
        baseUrl,
        { PINGROOM_INTERNAL_ACTIVATION_TIMEOUT_MS: '2600' },
        { timeoutMs: 7_000 },
      );
      assert.equal(status, 1, stderr);
      assert.match(stdout, /answered without verified phone receipt before the answer/);
      assert.match(stdout, /connection is saved and usable/);
      assert.match(stdout, /run "pingroom activate" to send a fresh test with this saved connection/i);
      assert.doesNotMatch(stdout, /Agent Inbox is ready/);
      assert.equal(JSON.parse(readFileSync(join(home, 'credentials.json'), 'utf8')).token, 'active_jwt');
      const waits = received.filter((request) => request.path === '/api/agent/handoffs/q-onboard/wait');
      assert.equal(waits.length, 1, 'a terminal unverified sequence must not be polled as if history can change');
    } finally {
      server.close();
      rmSync(home, { recursive: true, force: true });
    }
  }
});

test('activate rejects malformed or mismatched activation envelopes without losing credentials', async () => {
  const invalidCases = [
    {
      ensureResponses: [{
        status: 201,
        body: {
          onboarded: true,
          replayed: false,
          room: { id: 'room-1', name: 'Project X', invite_code: 'ABC123', is_agent_inbox: false },
          question: {
            id: '', kind: 'question', prompt: 'Test', state: 'pending', options: [],
            expires_at: null, created_at: null,
          },
        },
      }],
      expected: /incomplete Agent Inbox ensure response/,
    },
    {
      waitResponses: [{
        status: 200,
        body: { id: 'wrong-id', kind: 'question', state: 'pending', answer: null },
      }],
      expected: /mismatched Agent Inbox wait response/,
    },
    {
      waitResponses: [{
        status: 200,
        body: {
          id: 'q-onboard', kind: 'question', state: 'answered',
          answer: { value: 'yes' }, activation_completed: true,
        },
      }],
      expected: /answered activation without a valid answer/,
    },
  ];

  for (const invalid of invalidCases) {
    const home = newHome();
    const { server, baseUrl } = await pairingServer([ACTIVE_PAIR], invalid);
    try {
      const { status, stdout, stderr } = await pairThenActivate(home, baseUrl);
      assert.equal(status, 1, stderr);
      assert.match(stdout, invalid.expected);
      assert.match(stdout, /connection is saved and usable/);
      assert.match(stdout, /Run "pingroom activate"/);
      assert.doesNotMatch(stdout, /Agent Inbox is ready/);
      assert.equal(JSON.parse(readFileSync(join(home, 'credentials.json'), 'utf8')).token, 'active_jwt');
    } finally {
      server.close();
      rmSync(home, { recursive: true, force: true });
    }
  }
});

test('activate honors Retry-After for ensure and wait 429s, then completes activation', async () => {
  const home = newHome();
  const successEnsure = activationEnsureResponse();
  const { server, baseUrl, received } = await pairingServer([ACTIVE_PAIR], {
    ensureResponses: [
      {
        status: 429,
        headers: { 'Retry-After': '0' },
        body: { code: 'rate_limited', message: 'Try again.' },
      },
      successEnsure,
    ],
    waitResponses: [
      {
        status: 429,
        headers: { 'Retry-After': '3' },
        body: { code: 'rate_limited', message: 'Try again.' },
      },
      confirmedActivationResponse(),
    ],
  });
  try {
    // Pair first, on the real clock, then run only the activation on virtual time.
    const paired = await runAsync(
      ['--api', baseUrl],
      { PINGROOM_HOME: home, PINGROOM_INTERNAL_TEST_TTY: '1', NODE_ENV: 'test', COLUMNS: '120' },
      { stdin: '1\n' },
    );
    assert.equal(paired.status, 0, paired.stderr);

    const { status, stdout, stderr, sleeps } = await runOnFakeTime(
      ['activate', '--api', baseUrl],
      { PINGROOM_HOME: home, NODE_ENV: 'test' },
      { timeoutMs: 10_000 },
    );
    assert.equal(status, 0, stderr);
    // Retry-After: 0 is floored at 1 s, never an immediate retry; the wait's
    // Retry-After: 3 beats the polling cadence and adds no backoff on top.
    assert.deepEqual(sleeps, [1_000, 3_000]);
    assert.match(stdout, /Agent Inbox is ready/);
    assert.equal(received.filter((r) => r.path === '/api/agent/inbox/ensure').length, 2);
    assert.equal(received.filter((r) => r.path === '/api/agent/handoffs/q-onboard/wait').length, 2);
    assert.equal(JSON.parse(readFileSync(join(home, 'credentials.json'), 'utf8')).token, 'active_jwt');
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('activate stops at the activation deadline without discarding credentials', async () => {
  const home = newHome();
  // Each answer takes 250 real ms, 2.5 times the 100 ms deadline, as a loaded
  // machine's would. The deadline and the request timeouts built from it are on
  // the fake clock, so a slow answer must not read as an outage.
  const { server, baseUrl, received } = await pairingServer([ACTIVE_PAIR], {
    ensureResponses: [{ ...activationEnsureResponse(), delayMs: 250 }],
    waitResponses: [{ status: 200, body: { id: 'q-onboard', kind: 'question', state: 'pending' }, delayMs: 250 }],
  });
  try {
    const { status, stdout, stderr, sleeps } = await pairThenActivate(
      home,
      baseUrl,
      { PINGROOM_INTERNAL_ACTIVATION_TIMEOUT_MS: '100' },
      { timeoutMs: 3000 },
      runOnFakeTime,
    );
    assert.equal(status, 1, stderr);
    assert.match(stdout, /still waiting for the test answer/);
    assert.match(stdout, /connection is saved and usable/);
    assert.match(stdout, /Run "pingroom activate"/);
    assert.equal(received.filter((r) => r.path === '/api/agent/handoffs/q-onboard/wait').length, 1);
    // The pending round would pause for the poll floor, but only 100 ms of the
    // deadline is left, so it sleeps that and stops.
    assert.ok(POLL_FLOOR_MS > 100);
    assert.deepEqual(sleeps, [100]);
    assert.equal(JSON.parse(readFileSync(join(home, 'credentials.json'), 'utf8')).token, 'active_jwt');
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});
