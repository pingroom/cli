import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, rmSync } from 'node:fs';
import { runAsync, newHome, seedCredential, flakyPairingServer, reconnectServer } from './helpers.mjs';

test('reconnect also reports a lapsed window as expiry, keeping the old credential', async () => {
  // Same root cause on the interactive path, which shares connectByPairing.
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
    seedCredential(home, { token: 'old_tok', api_url: stub.baseUrl });
    const { status, stdout } = await runAsync(
      ['reconnect', '--api', stub.baseUrl],
      { PINGROOM_HOME: home, PINGROOM_INTERNAL_TEST_TTY: '1', NODE_ENV: 'test', COLUMNS: '120' },
      { stdin: 'n\n', timeoutMs: 20000 },
    );
    assert.equal(status, 3);
    assert.match(stdout, /Kept your current connection/);
    assert.equal(JSON.parse(readFileSync(join(home, 'credentials.json'), 'utf8')).token, 'old_tok');
    assert.ok(!stub.received.some((r) => r.path === '/api/agent/auth/revoke'));
  } finally {
    stub.server.close();
  }
});

test('reconnect refuses an env token rather than revoking someone else\'s credential', async () => {
  const { status, stderr } = await runAsync(['reconnect'], { PINGROOM_TOKEN: 'x'.repeat(40) });
  assert.equal(status, 2);
  assert.match(stderr, /PINGROOM_TOKEN is set/);
  assert.match(stderr, /revoke whatever credential it names/);
});

test('reconnect without a stored credential points at pairing, not at itself', async () => {
  const { status, stderr } = await runAsync(['reconnect']);
  assert.equal(status, 2);
  assert.match(stderr, /not connected/);
  assert.match(stderr, /Run "pingroom" to pair/);
});

// --- reconnect, end to end --------------------------------------------------
//
// The command replaces a live credential and then revokes the old one, so the
// ORDER is the whole design: nothing may be written or revoked until the human
// has approved, and the revoke must carry the OLD bearer, after the new
// credential is already durable on disk.

test('reconnect saves the new credential BEFORE revoking the old one', async () => {
  const home = newHome();
  seedCredential(home, { token: 'old_tok', handle: 'agt_old', api_url: 'PLACEHOLDER' });
  const { server, baseUrl, received } = await reconnectServer();
  // The stored credential is origin-bound, so it has to name this stub.
  seedCredential(home, { token: 'old_tok', handle: 'agt_old', api_url: baseUrl });
  try {
    const { status, stdout, stderr } = await runAsync(
      ['reconnect', '--api', baseUrl],
      { PINGROOM_HOME: home, PINGROOM_INTERNAL_TEST_TTY: '1', NODE_ENV: 'test', COLUMNS: '120' },
      { stdin: '', timeoutMs: 20000 },
    );
    assert.equal(status, 0, stderr);

    // The replacement is on disk...
    const saved = JSON.parse(readFileSync(join(home, 'credentials.json'), 'utf8'));
    assert.equal(saved.token, 'active_jwt');

    // ...and the revoke went out with the OLD bearer, after the pairing completed.
    const revoke = received.find((r) => r.path === '/api/agent/auth/revoke');
    assert.ok(revoke, 'the old credential must be revoked');
    assert.equal(revoke.auth, 'Bearer old_tok');
    const order = received.map((r) => r.path);
    assert.ok(
      order.indexOf('/api/agent/auth/pair/status') < order.indexOf('/api/agent/auth/revoke'),
      'revoke must come after the human approved',
    );
    assert.match(stdout, /Previous connection revoked/);
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('reconnect keeps the new credential when the revoke fails', async () => {
  const home = newHome();
  const { server, baseUrl } = await reconnectServer({ revokeStatus: 500 });
  seedCredential(home, { token: 'old_tok', handle: 'agt_old', api_url: baseUrl });
  try {
    const { status, stdout } = await runAsync(
      ['reconnect', '--api', baseUrl],
      { PINGROOM_HOME: home, PINGROOM_INTERNAL_TEST_TTY: '1', NODE_ENV: 'test', COLUMNS: '120' },
      { stdin: '', timeoutMs: 20000 },
    );
    // A failed revoke is untidy, not dangerous: the new credential is already
    // durable, so exiting non-zero would imply the reconnect did not happen.
    assert.equal(status, 0);
    assert.equal(JSON.parse(readFileSync(join(home, 'credentials.json'), 'utf8')).token, 'active_jwt');
    assert.match(stdout, /could not be revoked/);
    assert.match(stdout, /Connected Agents/);
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('reconnect leaves the old credential untouched when pairing lapses', async () => {
  const home = newHome();
  const { server, baseUrl, received } = await reconnectServer({ statuses: [{ status: 'expired' }] });
  seedCredential(home, { token: 'old_tok', handle: 'agt_old', api_url: baseUrl });
  try {
    const { status } = await runAsync(
      ['reconnect', '--api', baseUrl],
      { PINGROOM_HOME: home, PINGROOM_INTERNAL_TEST_TTY: '1', NODE_ENV: 'test', COLUMNS: '120' },
      { stdin: 'n\n', timeoutMs: 20000 },
    );
    assert.equal(status, 3, 'a lapsed pairing is EXIT.EXPIRED');
    // The whole promise of the command: declining changes nothing.
    assert.equal(JSON.parse(readFileSync(join(home, 'credentials.json'), 'utf8')).token, 'old_tok');
    assert.ok(
      !received.some((r) => r.path === '/api/agent/auth/revoke'),
      'nothing may be revoked when the human never approved',
    );
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('reconnect leaves the full pairing grant to the server', async () => {
  const home = newHome();
  const { server, baseUrl, received } = await reconnectServer();
  seedCredential(home, { token: 'old_tok', handle: 'agt_old', api_url: baseUrl });
  try {
    await runAsync(
      ['reconnect', '--api', baseUrl, '--agent-label', 'Replacement robot'],
      { PINGROOM_HOME: home, PINGROOM_INTERNAL_TEST_TTY: '1', NODE_ENV: 'test', COLUMNS: '120' },
      { stdin: '', timeoutMs: 20000 },
    );
    const register = received.find((r) => r.path === '/api/agent/auth');
    const start = received.find((r) => r.path === '/api/agent/auth/pair/start');
    assert.equal(JSON.parse(register.body).agent_label, 'Replacement robot');
    assert.equal(Object.hasOwn(JSON.parse(register.body), 'scopes'), false);
    assert.deepEqual(JSON.parse(start.body), {});
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('reconnect refuses to send the stored credential to another origin', async () => {
  // The revoke leg carries the OLD, still-valid bearer. Without the origin
  // binding every other stored-bearer command obeys, `--api` (or a stale
  // config.json api_url) redirects a live production credential to any host
  // that happens to satisfy the https/loopback check.
  const home = newHome();
  const { server, baseUrl, received } = await reconnectServer();
  try {
    // Paired against a DIFFERENT origin than the one we are about to name.
    seedCredential(home, { token: 'live_prod_tok', handle: 'agt_old', api_url: 'https://api.pingroom.io' });

    const { status, stderr } = await runAsync(
      ['reconnect', '--api', baseUrl],
      { PINGROOM_HOME: home, PINGROOM_INTERNAL_TEST_TTY: '1', NODE_ENV: 'test', COLUMNS: '120' },
      { stdin: '', timeoutMs: 20000 },
    );

    assert.equal(status, 2, 'a cross-origin reconnect is a usage error');
    assert.match(stderr, /stored credential is bound to https:\/\/api\.pingroom\.io/);
    assert.ok(
      !received.some((r) => r.auth === 'Bearer live_prod_tok'),
      'the live credential must never reach the other host',
    );
    // And it must refuse BEFORE minting anything against the wrong host.
    assert.equal(received.length, 0, 'nothing may be sent at all');
    assert.equal(
      JSON.parse(readFileSync(join(home, 'credentials.json'), 'utf8')).token,
      'live_prod_tok',
      'the stored credential is untouched',
    );
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});
