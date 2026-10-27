import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync, readFileSync, statSync } from 'node:fs';
import {
  run, runAsync, newHome, seedCredential, ACTIVE_PAIR, flakyPairingServer, reconnectServer,
} from './helpers.mjs';

// ---------------------------------------------------------------------------
// pair — headless pairing. The contract that matters is what it must NOT do:
// no QR, no prompt, no stdin attachment, and exactly one round.

test('pair prints the approval URL and pairs with no TTY, no QR, and no prompt', async () => {
  const home = newHome();
  const { server, baseUrl, received } = await reconnectServer();
  try {
    // Deliberately no COLUMNS: an unset width reads as "wide enough" inside
    // renderQr, so this is the case where a daemon would get block art.
    const { status, stdout } = await runAsync(
      ['pair', '--api', baseUrl],
      { PINGROOM_HOME: home },
      { stdin: '', timeoutMs: 20000 },
    );
    assert.equal(status, 0);
    assert.match(stdout, /Open: https:\/\/api\.pingroom\.io\/pair/);
    assert.doesNotMatch(stdout, /[█▄▀]/, 'no QR may be drawn without a terminal');
    assert.doesNotMatch(stdout, /Choose \[1\]|fresh QR/, 'nothing may prompt');

    const saved = JSON.parse(readFileSync(join(home, 'credentials.json'), 'utf8'));
    assert.equal(saved.token, 'active_jwt');
    assert.equal(saved.api_url, baseUrl);
    assert.equal(statSync(join(home, 'credentials.json')).mode & 0o777, 0o600);

    const register = received.find((r) => r.path === '/api/agent/auth');
    const start = received.find((r) => r.path === '/api/agent/auth/pair/start');
    assert.equal(Object.hasOwn(JSON.parse(register.body), 'scopes'), false);
    assert.deepEqual(JSON.parse(start.body), {});
    assert.ok(!received.some((r) => r.path === '/api/agent/auth/revoke'), 'nothing to revoke on a first pairing');
  } finally {
    server.close();
  }
});

test('pair saves the new credential BEFORE revoking the old one', async () => {
  const home = newHome();
  const { server, baseUrl, received } = await reconnectServer();
  try {
    seedCredential(home, { token: 'old_tok', handle: 'agt_old', api_url: baseUrl });
    const { status, stdout } = await runAsync(
      ['pair', '--api', baseUrl],
      { PINGROOM_HOME: home },
      { stdin: '', timeoutMs: 20000 },
    );
    assert.equal(status, 0);
    assert.equal(JSON.parse(readFileSync(join(home, 'credentials.json'), 'utf8')).token, 'active_jwt');

    const order = received.map((r) => r.path);
    assert.ok(
      order.indexOf('/api/agent/auth/pair/status') < order.indexOf('/api/agent/auth/revoke'),
      'the replacement must be durable before the old credential dies',
    );
    const revoke = received.find((r) => r.path === '/api/agent/auth/revoke');
    assert.equal(revoke.auth, 'Bearer old_tok');
    assert.match(stdout, /Previous connection revoked/);
  } finally {
    server.close();
  }
});

test('pair keeps the new credential when the revoke fails', async () => {
  const home = newHome();
  const { server, baseUrl } = await reconnectServer({ revokeStatus: 500 });
  try {
    seedCredential(home, { token: 'old_tok', api_url: baseUrl });
    const { status, stdout } = await runAsync(
      ['pair', '--api', baseUrl],
      { PINGROOM_HOME: home },
      { stdin: '', timeoutMs: 20000 },
    );
    assert.equal(status, 0);
    assert.equal(JSON.parse(readFileSync(join(home, 'credentials.json'), 'utf8')).token, 'active_jwt');
    assert.match(stdout, /could not be revoked/);
    assert.match(stdout, /Connected Agents/);
  } finally {
    server.close();
  }
});

test('pair never retries: an expired link exits 3 after exactly one registration', async () => {
  const home = newHome();
  const stub = await flakyPairingServer([{ body: { status: 'expired' } }]);
  try {
    const { status, stdout, timedOut } = await runAsync(
      ['pair', '--api', stub.baseUrl],
      { PINGROOM_HOME: home },
      { stdin: '', timeoutMs: 15000 },
    );
    assert.equal(timedOut, false, 'pair must not block waiting for an answer nobody can give');
    assert.equal(status, 3);
    assert.match(stdout, /That code expired/);
    assert.doesNotMatch(stdout, /Show a fresh QR/);
    assert.equal(stub.registrations, 1, 'one round means one anonymous registration');
    assert.ok(!existsSync(join(home, 'credentials.json')));
  } finally {
    stub.server.close();
  }
});

test('pair leaves a stored credential untouched when the link expires', async () => {
  const home = newHome();
  const stub = await flakyPairingServer([{ body: { status: 'expired' } }]);
  try {
    seedCredential(home, { token: 'old_tok', api_url: stub.baseUrl });
    const { status, stdout } = await runAsync(
      ['pair', '--api', stub.baseUrl],
      { PINGROOM_HOME: home },
      { stdin: '', timeoutMs: 15000 },
    );
    assert.equal(status, 3);
    assert.equal(JSON.parse(readFileSync(join(home, 'credentials.json'), 'utf8')).token, 'old_tok');
    assert.match(stdout, /Kept your current connection/);
    assert.ok(!stub.received.some((r) => r.path === '/api/agent/auth/revoke'));
  } finally {
    stub.server.close();
  }
});

test('an unapproved pairing reports expiry, not an auth error', async () => {
  // Observed live 2026-09-02: nobody approved inside the window, and the last
  // poll 401'd because the pre-claim credential this loop authenticates with
  // expires on the same 900s clock as the pairing token. That surfaced as
  // "pairing failed: Bearer credential is missing or invalid", exit 1, plus a
  // hint to run reconnect — three wrong things for "nobody tapped it yet".
  const home = newHome();
  // One pending poll, then the 401 — with a 2s window and the 1s minimum poll
  // interval, the rejection lands in the second half, which is where a real
  // unapproved pairing 401s (the pre-claim credential ages out with the link).
  const stub = await flakyPairingServer(
    [
      { body: { status: 'pending' } },
      { httpStatus: 401, body: { message: 'Bearer credential is missing or invalid.' } },
    ],
    { pairStart: { expires_in: 2, poll_interval_ms: 1000 } },
  );
  try {
    const { status, stdout, stderr } = await runAsync(
      ['pair', '--api', stub.baseUrl],
      { PINGROOM_HOME: home },
      { stdin: '', timeoutMs: 15000 },
    );
    assert.equal(status, 3, 'an expired link is exit 3, not a generic failure');
    assert.match(stdout, /That code expired/);
    assert.match(stdout, /pingroom pair" again/);
    assert.doesNotMatch(stderr, /Bearer credential/, 'the raw auth error must not surface');
    assert.doesNotMatch(stderr, /reconnect/, 'there is no stored credential to reconnect');
    assert.ok(!existsSync(join(home, 'credentials.json')));
  } finally {
    stub.server.close();
  }
});

test('pair --json reports a lapsed window as an expired event', async () => {
  const home = newHome();
  // One pending poll, then the 401 — with a 2s window and the 1s minimum poll
  // interval, the rejection lands in the second half, which is where a real
  // unapproved pairing 401s (the pre-claim credential ages out with the link).
  const stub = await flakyPairingServer(
    [
      { body: { status: 'pending' } },
      { httpStatus: 401, body: { message: 'Bearer credential is missing or invalid.' } },
    ],
    { pairStart: { expires_in: 2, poll_interval_ms: 1000 } },
  );
  try {
    const { status, stdout } = await runAsync(
      ['pair', '--api', stub.baseUrl, '--json'],
      { PINGROOM_HOME: home },
      { stdin: '', timeoutMs: 15000 },
    );
    assert.equal(status, 3);
    const events = stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(events.at(-1).event, 'expired');
  } finally {
    stub.server.close();
  }
});

test('pair exits once paired even if stdin is never closed', async () => {
  const home = newHome();
  const { server, baseUrl } = await reconnectServer();
  try {
    // A daemon inherits an stdin that stays open forever. Attaching a prompter
    // (stdin.resume()) would hang the process here rather than exiting.
    const { status, timedOut } = await runAsync(
      ['pair', '--api', baseUrl],
      { PINGROOM_HOME: home },
      { holdStdin: true, timeoutMs: 15000 },
    );
    assert.equal(timedOut, false, 'an open stdin must not hold pair open');
    assert.equal(status, 0);
  } finally {
    server.close();
  }
});

test('pair --json streams pair_url first and connected last, and never the token', async () => {
  const home = newHome();
  const { server, baseUrl } = await reconnectServer();
  try {
    const { status, stdout } = await runAsync(
      ['pair', '--api', baseUrl, '--json'],
      { PINGROOM_HOME: home },
      { stdin: '', timeoutMs: 20000 },
    );
    assert.equal(status, 0);
    const lines = stdout.trim().split('\n').filter(Boolean);
    const events = lines.map((line) => JSON.parse(line)); // every line must parse
    assert.equal(events[0].event, 'pair_url');
    assert.match(events[0].pair_url, /^https:\/\/api\.pingroom\.io\/pair/);
    assert.equal(typeof events[0].expires_in, 'number');
    assert.equal(events[0].flow_version, 2);
    assert.equal(events[0].claim_mode, 'agent_identity');
    assert.equal(events[0].agent.profile.display_name, 'PingRoom CLI');
    assert.equal(events[0].agent.profile.handle, 'agt_ab12cd34ef');
    assert.deepEqual(events[0].links, { install_app: 'https://pingroom.io/i' });
    const connected = events.at(-1);
    assert.equal(connected.event, 'connected');
    assert.equal(connected.handle, 'agt_ab12cd34ef');
    assert.equal(connected.api_url, baseUrl);
    assert.deepEqual(connected.links, ACTIVE_PAIR.links);
    assert.deepEqual(connected.owner, { name: 'Mahdi' });
    assert.deepEqual(connected.home_room, ACTIVE_PAIR.home_room);
    assert.equal(connected.room_membership.status, 'active');
    assert.equal(connected.agent.profile.avatar_id, 'bot-7');
    assert.equal(Object.hasOwn(connected, 'scopes'), false);
    // The credential is what this whole flow protects; it must never reach a log.
    assert.doesNotMatch(stdout, /active_jwt/);
  } finally {
    server.close();
  }
});

test('pair --json reports an expired link as an event and exits 3', async () => {
  const home = newHome();
  const stub = await flakyPairingServer([{ body: { status: 'expired' } }]);
  try {
    const { status, stdout } = await runAsync(
      ['pair', '--api', stub.baseUrl, '--json'],
      { PINGROOM_HOME: home },
      { stdin: '', timeoutMs: 15000 },
    );
    assert.equal(status, 3);
    const events = stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(events.at(-1).event, 'expired');
    assert.equal(events.at(-1).reason, 'expired');
  } finally {
    stub.server.close();
  }
});

test('pair --json keeps transient notices off stdout', async () => {
  const home = newHome();
  const stub = await flakyPairingServer([
    { httpStatus: 502 }, { httpStatus: 502 }, { httpStatus: 502 }, { body: ACTIVE_PAIR },
  ]);
  try {
    const { status, stdout, stderr } = await runAsync(
      ['pair', '--api', stub.baseUrl, '--json'],
      { PINGROOM_HOME: home },
      { stdin: '', timeoutMs: 20000 },
    );
    assert.equal(status, 0);
    for (const line of stdout.trim().split('\n').filter(Boolean)) {
      JSON.parse(line); // throws if a human-readable notice leaked into the stream
    }
    assert.match(stderr, /still trying/);
  } finally {
    stub.server.close();
  }
});

test('pair refuses an env token rather than pairing into a shadowed credential', async () => {
  const { status, stderr } = await runAsync(
    ['pair'],
    { PINGROOM_HOME: newHome(), PINGROOM_TOKEN: 'x'.repeat(40) },
    { stdin: '' },
  );
  assert.equal(status, 2);
  assert.match(stderr, /PINGROOM_TOKEN is set/);
});

test('pair refuses to send a stored credential to another origin before any request', async () => {
  const home = newHome();
  const stub = await flakyPairingServer([{ body: ACTIVE_PAIR }]);
  try {
    seedCredential(home, { token: 'old_tok', api_url: 'https://api.pingroom.io' });
    const { status, stderr } = await runAsync(
      ['pair', '--api', stub.baseUrl],
      { PINGROOM_HOME: home },
      { stdin: '', timeoutMs: 15000 },
    );
    assert.equal(status, 2);
    assert.match(stderr, /origin/i);
    assert.equal(stub.received.length, 0, 'nothing may be sent at all');
  } finally {
    stub.server.close();
  }
});

test('pair rejects positionals and credential flags', async () => {
  const extra = await runAsync(['pair', 'extra'], { PINGROOM_HOME: newHome() }, { stdin: '' });
  assert.equal(extra.status, 2);
  assert.match(extra.stderr, /usage: pingroom pair/);

  const token = await runAsync(['pair', '--token', 'x'.repeat(40)], { PINGROOM_HOME: newHome() }, { stdin: '' });
  assert.equal(token.status, 2);
  assert.match(token.stderr, /Unknown option: --token/);
});

test('pair is in the top-level help and its own help omits credential flags', () => {
  const top = run(['--help']);
  assert.equal(top.status, 0);
  assert.match(top.stdout, /^ {2}pair {5}Pair without a terminal/m);

  const own = run(['pair', '--help']);
  assert.equal(own.status, 0);
  assert.match(own.stdout, /--json/);
  assert.doesNotMatch(own.stdout, /--token/);
});

test('the non-TTY hints point at pingroom pair', async () => {
  const home = newHome();
  const stub = await flakyPairingServer([{ body: ACTIVE_PAIR }]);
  try {
    // reconnect still refuses without a terminal, but now names the way out.
    seedCredential(home, { token: 'old_tok', api_url: stub.baseUrl });
    const { status, stderr } = await runAsync(
      ['reconnect', '--api', stub.baseUrl],
      { PINGROOM_HOME: home },
      { stdin: '', timeoutMs: 15000 },
    );
    assert.equal(status, 2);
    assert.match(stderr, /pingroom pair/);
    assert.equal(stub.registrations, 0, 'the refusal must precede any network call');
  } finally {
    stub.server.close();
  }
});
