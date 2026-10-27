import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, rmSync, statSync } from 'node:fs';
import { pairingBrowserUrl, pairingInstallUrl, pairingLinks, pairingQrUrl } from '../lib/commands/connect.js';
import {
  run, runAsync, questionServer, newHome, pairingServer, ACTIVE_PAIR, flakyPairingServer, ttyEnv,
} from './helpers.mjs';

test('pairing QR prefers the native app URL and falls back for older servers', () => {
  const browserUrl = `https://api.pingroom.io/pair?token=${'p'.repeat(64)}`;
  const appUrl = `https://pingroom.io/app/agents/pair?token=${'p'.repeat(64)}`;

  assert.equal(pairingQrUrl({ pair_url: browserUrl, pair_qr_url: appUrl }), appUrl);
  assert.equal(pairingQrUrl({ pair_url: browserUrl }), browserUrl);
  assert.equal(pairingQrUrl({ pair_url: browserUrl, pair_qr_url: '' }), browserUrl);
  assert.doesNotMatch(
    pairingQrUrl({ pair_url: browserUrl, pair_qr_url: `${appUrl}\u001b[2J` }),
    /\u001b/,
  );
});

test('browser pairing prefers the additive browser URL without changing the QR', () => {
  const appUrl = 'https://pingroom.io/app/agents/pair?token=p';
  const browserUrl = 'https://api.pingroom.io/pair?token=p';
  const pairing = { pair_url: appUrl, pair_qr_url: appUrl, pair_browser_url: browserUrl };
  assert.equal(pairingBrowserUrl(pairing), browserUrl);
  assert.equal(pairingQrUrl(pairing), appUrl);
  assert.equal(pairingBrowserUrl({ pair_url: appUrl }), appUrl);
  assert.equal(pairingBrowserUrl({ pair_url: appUrl, pair_browser_url: '  ' }), appUrl);
  assert.equal(pairingBrowserUrl({ ...pairing, pair_browser_url: `${browserUrl}\u001b[2J` }), `${browserUrl}[2J`);
});

test('pairing links keep safe read/install URLs and derive old-server fallbacks', () => {
  assert.deepEqual(
    pairingLinks({
      latest_pings: 'https://api.pingroom.io/api/agent/notifications?limit=25',
      install_app: 'https://pingroom.io/i',
    }, 'https://api.pingroom.io'),
    {
      latest_pings: 'https://api.pingroom.io/api/agent/notifications?limit=25',
      install_app: 'https://pingroom.io/i',
    },
  );
  assert.deepEqual(
    pairingLinks(undefined, 'https://self-hosted.example.test/base'),
    {
      latest_pings: 'https://self-hosted.example.test/base/api/agent/notifications?limit=25&page=1',
      install_app: 'https://pingroom.io/i',
    },
  );
  for (const latest_pings of [
    '',
    'javascript:alert(1)',
    'https://secret@safe.example/pings',
    'https://safe.example/pings\u001b[2J',
  ]) {
    assert.deepEqual(
      pairingLinks({ latest_pings }, 'https://api.pingroom.io'),
      {
        latest_pings: 'https://api.pingroom.io/api/agent/notifications?limit=25&page=1',
        install_app: 'https://pingroom.io/i',
      },
    );
  }
});

test('the pairing install handoff is canonical and never carries a claim token', () => {
  assert.equal(
    pairingInstallUrl({ app_install_url: 'https://pingroom.io/i' }),
    'https://pingroom.io/i',
  );
  assert.equal(
    pairingInstallUrl({ mobile_app: { install_url: 'https://pingroom.io/i' } }),
    'https://pingroom.io/i',
  );
  for (const install_app of [
    `https://pingroom.io/i?token=${'p'.repeat(64)}`,
    'https://evil.example/install',
    'javascript:alert(1)',
    'https://pingroom.io/i\u001b[2J',
  ]) {
    const selected = pairingInstallUrl({ links: { install_app } });
    assert.equal(selected, 'https://pingroom.io/i');
    assert.doesNotMatch(selected, /token=|p{64}|evil|\u001b/);
  }
});

test('pairing renders a QR, polls to active, and stores a 0600 credential', async () => {
  const home = newHome();
  const { server, baseUrl, received } = await pairingServer([
    { status: 'pending' },
    { status: 'pending' },
    ACTIVE_PAIR,
  ]);
  try {
    const { status, stdout } = await runAsync(
      ['--api', baseUrl],
      { PINGROOM_HOME: home, PINGROOM_INTERNAL_TEST_TTY: '1', NODE_ENV: 'test', COLUMNS: '120' },
      { stdin: '\n' }, // accept the default picker choice (QR)
    );
    assert.equal(status, 0);
    // The robot identity leads; then the QR, URL fallback, and claim receipt.
    assert.match(stdout, /Install or open PingRoom on your phone and sign in: https:\/\/pingroom\.io\/i/);
    assert.match(stdout, /urgent Pings, questions, approvals, handoffs, and live progress/);
    assert.match(stdout, /Installing the app does not claim a robot or grant it access/);
    assert.ok(stdout.indexOf('Install or open PingRoom') < stdout.indexOf('Created robot:'));
    assert.match(stdout, /Created robot: PingRoom CLI \(@agt_ab12cd34ef\)/);
    assert.match(stdout, /Claim this robot in PingRoom/);
    assert.ok(stdout.indexOf('Created robot:') < stdout.indexOf('Or open:'));
    assert.match(stdout, /[█▄▀]{4}/);
    assert.match(stdout, /Or open: https:\/\/api\.pingroom\.io\/pair\?token=p{64}/);
    assert.match(stdout, /Waiting for claim…/);
    assert.match(stdout, /✓ PingRoom CLI \(@agt_ab12cd34ef\) was claimed by Mahdi and joined #Project X/);
    assert.doesNotMatch(stdout, /Latest pings API:/, 'the claim receipt should lead to an action, not an inbox endpoint');
    // Connecting is the whole ceremony: the approval the human just tapped IS
    // the round-trip, so nothing else is sent to their phone.
    assert.doesNotMatch(stdout, /test question/i);

    const paths = received.map((r) => r.path);
    assert.equal(paths[0], '/api/agent/auth');
    assert.equal(paths[1], '/api/agent/auth/pair/start');
    assert.deepEqual(paths.slice(2), Array(3).fill('/api/agent/auth/pair/status'));

    // The server owns the full pairing grant. Neither client request carries a
    // locally-maintained scope array that can go stale.
    const register = JSON.parse(received[0].body);
    assert.deepEqual(register, { type: 'anonymous', agent_label: 'PingRoom CLI' });
    // pair/start and every poll present the pre-claim credential.
    assert.equal(received[1].auth, 'Bearer pre_claim_jwt');
    assert.deepEqual(JSON.parse(received[1].body), {});
    for (const poll of received.slice(2, 5)) assert.equal(poll.auth, 'Bearer pre_claim_jwt');

    const credPath = join(home, 'credentials.json');
    const cred = JSON.parse(readFileSync(credPath, 'utf8'));
    assert.equal(cred.token, 'active_jwt');
    assert.equal(cred.handle, 'agt_ab12cd34ef');
    assert.deepEqual(cred.room, { invite_code: 'ABC123', name: 'Project X' });
    assert.deepEqual(cred.links, ACTIVE_PAIR.links);
    assert.equal(Object.hasOwn(cred, 'scopes'), false);
    assert.equal(cred.version, 1, 'the established credential file format stays v1');
    assert.equal(Object.hasOwn(cred, 'agent'), false, 'display metadata does not change the v1 file');
    assert.equal(Object.hasOwn(cred, 'owner'), false);
    assert.equal(Object.hasOwn(cred, 'home_room'), false);
    assert.equal(statSync(credPath).mode & 0o777, 0o600);
    assert.equal(statSync(home).mode & 0o777, 0o700);

    // The paired room is the last-resort fallback for --room.
    assert.equal(run(['config', 'get', 'default_room'], { PINGROOM_HOME: home }).stdout, '');
    assert.match(run([], { PINGROOM_HOME: home }).stdout, /Default room: ABC123/);
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('--agent-label names the robot before claim without changing pairing contracts', async () => {
  const home = newHome();
  const { server, baseUrl, received } = await pairingServer([ACTIVE_PAIR]);
  try {
    const { status, stdout, stderr } = await runAsync(
      ['pair', '--api', baseUrl, '--agent-label', 'OpenClaw on studio-mac'],
      { PINGROOM_HOME: home },
      { stdin: '', timeoutMs: 20_000 },
    );
    assert.equal(status, 0, stderr);
    assert.match(stdout, /Created robot: OpenClaw on studio-mac \(@agt_ab12cd34ef\)/);
    assert.match(stdout, /Keep this pairing running; after installing, return to the same claim link before it expires/);
    assert.match(stdout, /✓ OpenClaw on studio-mac \(@agt_ab12cd34ef\) was claimed/);
    const register = received.find((request) => request.path === '/api/agent/auth');
    assert.equal(JSON.parse(register.body).agent_label, 'OpenClaw on studio-mac');
    assert.equal(JSON.parse(readFileSync(join(home, 'credentials.json'), 'utf8')).version, 1);
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('bare connect accepts --agent-label while unrelated commands reject it', async () => {
  const home = newHome();
  const { server, baseUrl, received } = await pairingServer([ACTIVE_PAIR]);
  try {
    const connected = await runAsync(
      ['--api', baseUrl, '--agent-label', 'Local coding robot'],
      {
        PINGROOM_HOME: home,
        PINGROOM_INTERNAL_TEST_TTY: '1',
        NODE_ENV: 'test',
        COLUMNS: '120',
      },
      { stdin: '\n', timeoutMs: 20_000 },
    );
    assert.equal(connected.status, 0, connected.stderr);
    assert.match(connected.stdout, /Created robot: Local coding robot \(@agt_ab12cd34ef\)/);
    const register = received.find((request) => request.path === '/api/agent/auth');
    assert.equal(JSON.parse(register.body).agent_label, 'Local coding robot');

    const unrelated = await runAsync([
      'ask', '--agent-label', 'ignored', '--token', 'tok', '--room', 'ABC123',
      '--prompt', 'Ship?', '--api', baseUrl,
    ]);
    assert.equal(unrelated.status, 2);
    assert.match(unrelated.stderr, /Unknown option: --agent-label/);
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('--agent-label rejects blank or control-marked names before provisioning', async () => {
  for (const label of [' ', 'robot\u001b[2J']) {
    const home = newHome();
    try {
      const result = await runAsync(
        ['pair', '--agent-label', label],
        { PINGROOM_HOME: home },
        { stdin: '' },
      );
      assert.equal(result.status, 2);
      assert.match(result.stderr, /--agent-label must be non-empty text without control characters/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
});

test('pairing offers a fresh QR when the pre-claim window expires', async () => {
  const home = newHome();
  let rounds = 0;
  // First poll expires; after the user accepts a restart the new round is live.
  const { server, baseUrl, received } = await pairingServer(
    [{ status: 'expired' }, ACTIVE_PAIR],
    { onRegister: () => { rounds += 1; } },
  );
  try {
    const { status, stdout } = await runAsync(
      ['--api', baseUrl],
      { PINGROOM_HOME: home, PINGROOM_INTERNAL_TEST_TTY: '1', NODE_ENV: 'test', COLUMNS: '120' },
      { stdin: '1\ny\n' },
    );
    assert.equal(status, 0);
    assert.match(stdout, /That code expired\./);
    assert.match(stdout, /Show a fresh QR code\?/);
    assert.match(stdout, /✓ PingRoom CLI \(@agt_ab12cd34ef\) was claimed/);
    assert.equal(rounds, 2, 'a restart must mint a brand new pre-claim registration');
    assert.equal(received.filter((r) => r.path === '/api/agent/auth/pair/start').length, 2);
    assert.equal(JSON.parse(readFileSync(join(home, 'credentials.json'), 'utf8')).token, 'active_jwt');
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('declining a fresh QR exits 3 and writes no credential', async () => {
  const home = newHome();
  const { server, baseUrl } = await pairingServer([{ status: 'expired' }]);
  try {
    const { status, stdout } = await runAsync(
      ['--api', baseUrl],
      { PINGROOM_HOME: home, PINGROOM_INTERNAL_TEST_TTY: '1', NODE_ENV: 'test', COLUMNS: '120' },
      { stdin: '1\nn\n' },
    );
    assert.equal(status, 3);
    assert.match(stdout, /That code expired\./);
    assert.throws(() => readFileSync(join(home, 'credentials.json'), 'utf8'));
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('a narrow terminal degrades to the pair URL alone', async () => {
  const home = newHome();
  const { server, baseUrl } = await pairingServer([ACTIVE_PAIR]);
  try {
    const { status, stdout } = await runAsync(
      ['--api', baseUrl],
      { PINGROOM_HOME: home, PINGROOM_INTERNAL_TEST_TTY: '1', NODE_ENV: 'test', COLUMNS: '20' },
      { stdin: '1\n' },
    );
    assert.equal(status, 0);
    assert.doesNotMatch(stdout, /[█▄▀]/);
    assert.match(stdout, /Open: https:\/\/api\.pingroom\.io\/pair/);
    assert.match(stdout, /was claimed by Mahdi and joined #Project X/);
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('the email fallback claims over the unchanged claim/* endpoints', async () => {
  const home = newHome();
  const { server, baseUrl, received } = await questionServer({
    'POST /api/agent/auth': () => ({
      status: 200,
      body: { credential: 'pre_claim_jwt', credential_type: 'pre_claim', expires_in: 900 },
    }),
    'POST /api/agent/auth/claim/start': () => ({
      status: 200,
      body: { message: 'Claim email sent.', expires_in: 900 },
    }),
    'POST /api/agent/auth/claim/complete': (body) => (JSON.parse(body).otp === '040176'
      ? {
        status: 200,
        body: {
          credential: 'active_jwt',
          credential_type: 'active',
          expires_in: 0,
          handle: 'agt_email01',
          scopes: ['pingroom:full'],
          room: { invite_code: 'INBOX42', name: 'Private Inbox' },
          room_access: 'all',
          rooms: [],
        },
      }
      : { status: 400, body: { error: 'invalid_otp', message: 'Invalid or expired code.' } }),
  });
  try {
    const { status, stdout, stderr } = await runAsync(
      ['--api', baseUrl],
      { PINGROOM_HOME: home, PINGROOM_INTERNAL_TEST_TTY: '1', NODE_ENV: 'test' },
      { stdin: '2\nme@example.com\n111111\n040176\n' }, // one wrong code, then the right one
    );
    assert.equal(status, 0, stderr);
    assert.match(stdout, /Email me a code/);
    assert.match(stdout, /the page shows a 6-digit code/);
    assert.match(stderr, /Invalid or expired code/);
    assert.match(stdout, /✓ PingRoom CLI \(@agt_email01\) was claimed and joined #Private Inbox/);
    assert.doesNotMatch(stdout, /Latest pings API:/);
    assert.doesNotMatch(stdout, /pingroom config set default_room|reconnect with QR pairing/);

    const start = received.find((r) => r.path === '/api/agent/auth/claim/start');
    assert.equal(start.auth, 'Bearer pre_claim_jwt');
    assert.equal(JSON.parse(start.body).email, 'me@example.com');
    // Never draws a QR on this branch.
    assert.doesNotMatch(stdout, /[█▄▀]/);
    const saved = JSON.parse(readFileSync(join(home, 'credentials.json'), 'utf8'));
    assert.equal(saved.token, 'active_jwt');
    assert.deepEqual(saved.room, { invite_code: 'INBOX42', name: 'Private Inbox' });
    assert.equal(saved.room_access, 'all');
    assert.deepEqual(saved.rooms, []);
    assert.equal(saved.links.latest_pings, `${baseUrl}/api/agent/notifications?limit=25&page=1`);
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Regressions from the adversarial audit
//
// Every test below was written against a deliberately broken build first: each
// one fails if its fix is reverted. Several replace earlier tests that passed
// under mutation (a fresh-file-only permission check, a poll loop with no
// interval floor) and therefore proved nothing.
// ---------------------------------------------------------------------------

test('EOF on stdin ends pairing instead of restarting it forever', async () => {
  // The bug: ask() resolved '' at EOF, '' is falsy, and the restart guard read
  // falsy as "yes". Ctrl-D (or any pipe) then looped the for(;;) minting a fresh
  // anonymous registration every cycle — thousands of them per minute.
  const home = newHome();
  const stub = await flakyPairingServer([{ body: { status: 'expired' } }]);
  try {
    const { status, stdout, timedOut } = await runAsync(
      ['--api', stub.baseUrl],
      ttyEnv(home, { COLUMNS: '120' }),
      { stdin: '', timeoutMs: 15_000 }, // stdin closed immediately == Ctrl-D
    );
    assert.equal(timedOut, false, 'pairing must terminate on EOF, not spin');
    assert.equal(status, 3);
    assert.equal(stub.registrations, 1, 'EOF must not mint a second registration');
    assert.equal(
      stub.received.filter((r) => r.path === '/api/agent/auth/pair/start').length,
      1,
      'EOF must not start a second pairing round',
    );
    assert.match(stdout, /That code expired\./);
    // And it must not have written a half-formed credential on the way out.
    assert.throws(() => readFileSync(join(home, 'credentials.json'), 'utf8'));
  } finally {
    stub.server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('an explicit "n" still declines, and "y" still restarts, after the EOF fix', async () => {
  // The EOF fix must not have collapsed the empty-line-means-yes default.
  const home = newHome();
  const stub = await flakyPairingServer([{ body: { status: 'expired' } }, { body: ACTIVE_PAIR }]);
  try {
    const { status, stdout } = await runAsync(
      ['--api', stub.baseUrl],
      ttyEnv(home, { COLUMNS: '120' }),
      { stdin: '1\n\n', timeoutMs: 15_000 }, // bare Enter at the restart prompt
    );
    assert.equal(status, 0, stdout);
    assert.equal(stub.registrations, 2, 'an empty line is still "yes, show another"');
    assert.match(stdout, /✓ PingRoom CLI \(@agt_ab12cd34ef\) was claimed/);
  } finally {
    stub.server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('a transient 502, 429 or dropped connection does not abandon the pairing wait', async () => {
  for (const flake of [{ httpStatus: 502, body: { message: 'bad gateway' } }, { httpStatus: 429, body: {} }, { drop: true }]) {
    const home = newHome();
    const stub = await flakyPairingServer([flake, { body: ACTIVE_PAIR }]);
    try {
      const { status, stdout } = await runAsync(
        ['--api', stub.baseUrl],
        ttyEnv(home, { COLUMNS: '20' }),
        { stdin: '1\n', timeoutMs: 20_000 },
      );
      assert.equal(status, 0, `${JSON.stringify(flake)}: ${stdout}`);
      assert.match(stdout, /✓ PingRoom CLI \(@agt_ab12cd34ef\) was claimed/);
      assert.equal(stub.registrations, 1, 'a retry must reuse the same pre-claim, not re-register');
    } finally {
      stub.server.close();
      rmSync(home, { recursive: true, force: true });
    }
  }
});

test('401/403/404 EARLY in the pairing poll still fail immediately', async () => {
  // A credential minted seconds ago being rejected means the request is wrong
  // (bad --api, not a PingRoom host) — not that the window lapsed. Reporting
  // that as "expired" would hide a real fault behind an unwinnable retry.
  for (const httpStatus of [401, 403, 404]) {
    const home = newHome();
    const stub = await flakyPairingServer([{ httpStatus, body: { message: 'gone' } }]);
    try {
      const { status, stderr } = await runAsync(
        ['--api', stub.baseUrl],
        ttyEnv(home, { COLUMNS: '20' }),
        { stdin: '1\n', timeoutMs: 15_000 },
      );
      assert.equal(status, 1, `HTTP ${httpStatus} must not be retried`);
      assert.match(stderr, /pairing failed/);
      const polls = stub.received.filter((r) => r.path === '/api/agent/auth/pair/status').length;
      assert.equal(polls, 1, `HTTP ${httpStatus} must not be polled twice`);
    } finally {
      stub.server.close();
      rmSync(home, { recursive: true, force: true });
    }
  }
});

test('a persistent outage stops at the deadline and says so, rather than retrying silently', async () => {
  const home = newHome();
  // expires_in 4s is the whole pairing window here, so the retry loop has to be
  // bounded by it. Without the bound this test hangs and the timeout fires.
  const stub = await flakyPairingServer([{ httpStatus: 503, body: { message: 'unavailable' } }], {
    pairStart: { expires_in: 4 },
  });
  try {
    const { status, stdout, timedOut } = await runAsync(
      ['--api', stub.baseUrl],
      ttyEnv(home, { COLUMNS: '20' }),
      { stdin: '1\n', timeoutMs: 25_000 },
    );
    assert.equal(timedOut, false, 'a persistent outage must terminate at the deadline');
    assert.equal(status, 3);
    // It retried rather than dying on the first 503 …
    const polls = stub.received.filter((r) => r.path === '/api/agent/auth/pair/status').length;
    assert.ok(polls >= 3, `expected several retries within the window, saw ${polls}`);
    // … told the user it was still trying …
    assert.match(stdout, /still trying/);
    // … and reported the outage instead of pretending the code expired.
    assert.match(stdout, /Gave up waiting — the server kept failing \(last: HTTP 503\)/);
    assert.doesNotMatch(stdout, /That code expired/);
  } finally {
    stub.server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('the pairing poll never runs faster than the documented 1/second throttle', async () => {
  // AGENT_PAIRING_SPEC.md throttles GET pair/status at `60,1`. The stub asks for
  // 10ms; the floor must override it, or the pairing window is spent on 429s.
  const home = newHome();
  const stub = await flakyPairingServer([
    { body: { status: 'pending' } },
    { body: { status: 'pending' } },
    { body: ACTIVE_PAIR },
  ]);
  try {
    const { status } = await runAsync(
      ['--api', stub.baseUrl],
      ttyEnv(home, { COLUMNS: '20' }),
      { stdin: '1\n', timeoutMs: 20_000 },
    );
    assert.equal(status, 0);
    assert.equal(stub.statusTimes.length, 3);
    const gaps = stub.statusTimes.slice(1).map((t, i) => t - stub.statusTimes[i]);
    for (const gap of gaps) {
      // setTimeout never fires early, so a small tolerance only covers clock
      // granularity — a 250ms floor lands at ~250 and fails this.
      assert.ok(gap >= 950, `polls were ${gap}ms apart; the floor is 1000ms`);
      assert.ok(gap < 6000, `polls were ${gap}ms apart; the floor is not a stall`);
    }
  } finally {
    stub.server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('a negative expires_in is clamped instead of producing a deadline in the past', async () => {
  // Math.max(1, …) is what stops `expires_in: -5` becoming a -5000ms lifetime,
  // which makes `Date.now() < deadline` false before the first poll and reports
  // "expired" without ever having asked the server anything.
  const home = newHome();
  const stub = await flakyPairingServer([{ body: ACTIVE_PAIR }], { pairStart: { expires_in: -5 } });
  try {
    const { status, stdout } = await runAsync(
      ['--api', stub.baseUrl],
      ttyEnv(home, { COLUMNS: '20' }),
      { stdin: '1\n', timeoutMs: 15_000 },
    );
    assert.equal(status, 0, stdout);
    assert.ok(
      stub.received.some((r) => r.path === '/api/agent/auth/pair/status'),
      'the clamp must leave at least one poll inside the window',
    );
    assert.match(stdout, /was claimed by Mahdi and joined #Project X/);
  } finally {
    stub.server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('an "active" status with no credential fails loudly and writes nothing', async () => {
  // Dropping this guard writes `token: undefined` into credentials.json: the
  // file then exists, the CLI says "Connected", and every later command fails
  // with an unrelated auth error.
  for (const body of [{ status: 'active' }, { status: 'active', credential: '' }]) {
    const home = newHome();
    const stub = await flakyPairingServer([{ body }]);
    try {
      const { status, stderr } = await runAsync(
        ['--api', stub.baseUrl],
        ttyEnv(home, { COLUMNS: '20' }),
        { stdin: '1\n', timeoutMs: 15_000 },
      );
      assert.equal(status, 1, JSON.stringify(body));
      assert.match(stderr, /pairing succeeded but the server returned no credential/);
      assert.throws(() => readFileSync(join(home, 'credentials.json'), 'utf8'));
    } finally {
      stub.server.close();
      rmSync(home, { recursive: true, force: true });
    }
  }
});

test('a hostile pair_url cannot write ANSI escapes to the terminal', async () => {
  const home = newHome();
  const stub = await flakyPairingServer([{ body: { status: 'expired' } }], {
    pairStart: { pair_url: 'https://evil.test/p\u001b[2J\u001b[1;1H  ✓ Connected as @root\u0007' },
  });
  try {
    const { stdout } = await runAsync(
      ['--api', stub.baseUrl],
      ttyEnv(home, { COLUMNS: '20' }), // narrow: no QR, just the URL line
      { stdin: '1\nn\n', timeoutMs: 15_000 },
    );
    assert.ok(!stdout.includes('\u001b'), 'no ESC may reach the terminal');
    assert.ok(!stdout.includes('\u0007'), 'no BEL may reach the terminal');
    // The printable part still shows, so the user can see where they are going.
    assert.match(stdout, /Open: https:\/\/evil\.test\/p\[2J\[1;1H/);
  } finally {
    stub.server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('pairing and email-claim errors print the server text through apiDetail', async () => {
  const hostile = { message: 'Nope\x1b]0;pwned\x07\x1b[2J', code: 'nope' };
  const { server, baseUrl } = await questionServer({
    'POST /api/agent/auth': () => ({ status: 200, body: { credential: 'pre_claim_jwt', credential_type: 'pre_claim', expires_in: 900 } }),
    'POST /api/agent/auth/pair/start': () => ({ status: 422, body: hostile }),
    'POST /api/agent/auth/claim/start': () => ({ status: 422, body: hostile }),
  });
  const homes = [newHome(), newHome()];
  try {
    const paired = await runAsync(['pair', '--api', baseUrl], { PINGROOM_HOME: homes[0] });
    assert.equal(paired.status, 1);
    assert.match(paired.stderr, /could not start pairing: Nope\]0;pwned\[2J/);

    const emailed = await runAsync(
      ['--api', baseUrl],
      { PINGROOM_HOME: homes[1], PINGROOM_INTERNAL_TEST_TTY: '1', NODE_ENV: 'test' },
      { stdin: '2\nme@example.com\n' },
    );
    assert.equal(emailed.status, 1);
    assert.match(emailed.stderr, /could not send the email: Nope/);
    for (const output of [paired.stdout, paired.stderr, emailed.stdout, emailed.stderr]) {
      // eslint-disable-next-line no-control-regex
      assert.doesNotMatch(output, /\x1b|\x07/);
    }
  } finally {
    server.close();
    for (const home of homes) rmSync(home, { recursive: true, force: true });
  }
});
