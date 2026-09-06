import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'bin', 'pingroom.js');
const ACTIVE_TOKEN = 'current-token-must-never-be-revoked';
const OLD_TOKEN = 'previous-token-only-for-revocation';

function newHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'pingroom-recovery-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

function seed(home, apiUrl, pending, overrides = {}) {
  writeFileSync(join(home, 'credentials.json'), JSON.stringify({
    version: 1, token: ACTIVE_TOKEN, handle: 'agt_current', api_url: apiUrl,
    pending_revocations: pending,
    ...overrides,
  }), { mode: 0o600 });
}

function queued(apiUrl, token = OLD_TOKEN, overrides = {}) {
  return { id: randomUUID(), token, api_url: apiUrl, ...overrides };
}

function state(home) {
  return JSON.parse(readFileSync(join(home, 'credentials.json'), 'utf8'));
}

function pending(home) {
  return state(home).pending_revocations ?? [];
}

function makeDue(home) {
  const saved = state(home);
  for (const record of saved.pending_revocations ?? []) delete record.next_attempt_at;
  writeFileSync(join(home, 'credentials.json'), JSON.stringify(saved), { mode: 0o600 });
}

function childEnv(home, overrides = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('PINGROOM_')) delete env[key];
  delete env.NODE_OPTIONS;
  delete env.NODE_ENV;
  return { ...env, PINGROOM_HOME: home, PINGROOM_NO_UPDATE_CHECK: '1', ...overrides };
}

function runNode(home, args, { env = {}, timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, args, { cwd: ROOT, env: childEnv(home, env) });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr, timedOut, elapsedMs: Date.now() - startedAt });
    });
    child.stdin.end();
  });
}

function run(home, args = [], options = {}) {
  return runNode(home, [...(options.execArgs ?? []), CLI, ...args], options);
}

function recover(home, { report = false, ...options } = {}) {
  const moduleUrl = pathToFileURL(join(ROOT, 'lib', 'credential-recovery.js')).href;
  return runNode(home, ['--input-type=module', '-e',
    `import { retryPendingRevocations } from ${JSON.stringify(moduleUrl)}; await retryPendingRevocations({ report: ${report} });`], options);
}

function assertSucceeded(result) {
  assert.equal(result.timedOut, false, result.stderr);
  assert.equal(result.status, 0, result.stderr);
}

function assertNoTokens(result, tokens = [ACTIVE_TOKEN, OLD_TOKEN]) {
  for (const token of tokens) {
    assert.ok(!`${result.stdout}${result.stderr}`.includes(token), 'credential leaked into CLI output');
  }
}

async function mockServer(t, handler) {
  const received = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (data) => { body += data; });
    req.on('end', () => {
      received.push({ method: req.method, path: req.url, auth: req.headers.authorization, body });
      handler(req, res, received.length);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { server, received, url: `http://127.0.0.1:${server.address().port}` };
}

function respond(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(body === undefined ? '' : JSON.stringify(body));
}

function assertOnlyOldRevoke(request, token = OLD_TOKEN, path = '/api/agent/auth/revoke') {
  assert.equal(request.method, 'POST');
  assert.equal(request.path, path);
  assert.equal(request.auth, `Bearer ${token}`);
}

function pairingIssuer(t) {
  const agent = { id: 'agent-new', label: 'PingRoom CLI', handle: 'agt_new',
    profile: { display_name: 'PingRoom CLI', handle: 'agt_new', avatar_id: 'bot-7' } };
  return mockServer(t, (req, res) => {
    if (req.url === '/api/agent/auth') {
      respond(res, 200, { flow_version: 2, claim_mode: 'agent_identity', agent,
        credential: 'pre-claim-token', credential_type: 'pre_claim', expires_in: 900, scopes: [] });
    } else if (req.url === '/api/agent/auth/pair/start') {
      respond(res, 200, { flow_version: 2, claim_mode: 'agent_identity', agent,
        pair_token: 'p'.repeat(64), pair_url: `https://pingroom.io/pair?token=${'p'.repeat(64)}`,
        expires_in: 900, poll_interval_ms: 1000 });
    } else if (req.url === '/api/agent/auth/pair/status') {
      respond(res, 200, { status: 'active', flow_version: 2, claim_mode: 'agent_identity', agent,
        credential: ACTIVE_TOKEN, credential_type: 'active', handle: 'agt_new',
        account: { name: 'Test owner' }, room_access: 'all', rooms: [], scopes: [] });
    } else if (req.url === '/api/agent/auth/revoke') respond(res, 204);
    else respond(res, 404, { code: 'unexpected_request' });
  });
}

test('a process killed before committing its replacement retains the original credential', async (t) => {
  const home = newHome(t);
  const issuer = await pairingIssuer(t);
  seed(home, issuer.url, [], { token: OLD_TOKEN, handle: 'agt_previous' });
  const preload = join(home, 'crash-before-replacement.mjs');
  writeFileSync(preload, `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const originalRename = fs.renameSync;
fs.renameSync = (from, to) => {
  if (String(to).endsWith('/credentials.json')) process.kill(process.pid, 'SIGKILL');
  return originalRename(from, to);
};
syncBuiltinESMExports();
`);
  const killed = await run(home, ['pair', '--json', '--api', issuer.url], {
    execArgs: ['--import', pathToFileURL(preload).href],
  });
  assert.equal(killed.timedOut, false, killed.stderr);
  assert.equal(killed.signal, 'SIGKILL', killed.stderr);
  assert.equal(state(home).token, OLD_TOKEN);
  assert.deepEqual(pending(home), []);
  assertNoTokens(killed, [ACTIVE_TOKEN, OLD_TOKEN, 'pre-claim-token']);
  assert.ok(!issuer.received.some((request) => request.path.endsWith('/revoke')));
  const lock = join(home, 'credentials.json.lock');
  if (existsSync(lock)) utimesSync(lock, new Date(0), new Date(0));
  issuer.received.length = 0;
  assertSucceeded(await run(home));
  assert.equal(issuer.received.length, 0);
  assert.equal(state(home).token, OLD_TOKEN);
});

test('a process killed after saving its replacement recovers revocation on the next CLI run', async (t) => {
  const home = newHome(t);
  const issuer = await pairingIssuer(t);
  seed(home, issuer.url, [], { token: OLD_TOKEN, handle: 'agt_previous' });
  const preload = join(home, 'crash-before-revoke.mjs');
  writeFileSync(preload, `
const originalFetch = globalThis.fetch;
globalThis.fetch = (...args) => {
  const url = String(args[0]?.url ?? args[0]);
  if (new URL(url).pathname.endsWith('/api/agent/auth/revoke')) {
    process.kill(process.pid, 'SIGKILL');
    return new Promise(() => {});
  }
  return originalFetch(...args);
};
`);
  const killed = await run(home, ['pair', '--json', '--api', issuer.url], {
    execArgs: ['--import', pathToFileURL(preload).href],
  });
  assert.equal(killed.timedOut, false, killed.stderr);
  assert.equal(killed.signal, 'SIGKILL', killed.stderr);
  assert.equal(state(home).token, ACTIVE_TOKEN);
  assert.equal(pending(home).length, 1);
  assert.equal(pending(home)[0].token, OLD_TOKEN);
  assert.equal(pending(home)[0].api_url, issuer.url);
  assert.equal(statSync(join(home, 'credentials.json')).mode & 0o777, 0o600);
  assert.ok(!issuer.received.some((request) => request.path.endsWith('/revoke')));
  assertNoTokens(killed, [ACTIVE_TOKEN, OLD_TOKEN, 'pre-claim-token']);

  // The child is dead. Age its abandoned lock to exercise normal stale-lock recovery.
  const lock = join(home, 'credentials.json.lock');
  if (existsSync(lock)) utimesSync(lock, new Date(0), new Date(0));
  issuer.received.length = 0;
  const next = await run(home);
  assertSucceeded(next);
  assertNoTokens(next);
  assert.equal(issuer.received.length, 1);
  assertOnlyOldRevoke(issuer.received[0]);
  assert.equal(state(home).token, ACTIVE_TOKEN);
  assert.deepEqual(pending(home), []);
});

test('a lost revoke response is retried safely and a structured invalid-credential response completes recovery', async (t) => {
  const home = newHome(t);
  let alreadyRevoked = false;
  const issuer = await mockServer(t, (_req, res) => {
    if (!alreadyRevoked) {
      alreadyRevoked = true;
      res.destroy();
    } else respond(res, 401, { code: 'invalid_credential' });
  });
  seed(home, issuer.url, [queued(issuer.url)]);
  const first = await run(home);
  assertSucceeded(first);
  assert.equal(alreadyRevoked, true);
  assert.equal(pending(home).length, 1);
  assert.equal(state(home).token, ACTIVE_TOKEN);
  makeDue(home);
  const retry = await run(home);
  assertSucceeded(retry);
  assertNoTokens(first);
  assertNoTokens(retry);
  assert.equal(issuer.received.length, 2);
  for (const request of issuer.received) assertOnlyOldRevoke(request);
  assert.deepEqual(pending(home), []);
});

test('failed cleanup survives and immediate invocations respect its persisted backoff', async (t) => {
  const home = newHome(t);
  const issuer = await mockServer(t, (_req, res) => respond(res, 500, { message: 'temporarily unavailable' }));
  seed(home, issuer.url, [queued(issuer.url)]);
  const before = Date.now();
  const first = await run(home);
  assertSucceeded(first);
  assertNoTokens(first);
  assert.equal(pending(home).length, 1);
  assert.ok(pending(home)[0].next_attempt_at >= before + 60_000);
  const immediate = await run(home);
  assertSucceeded(immediate);
  assert.equal(issuer.received.length, 1);
  assert.equal(state(home).token, ACTIVE_TOKEN);
});

test('rate limiting preserves the queue and honors Retry-After', async (t) => {
  const home = newHome(t);
  const issuer = await mockServer(t, (_req, res) => respond(res, 429, { code: 'rate_limited' }, { 'Retry-After': '120' }));
  seed(home, issuer.url, [queued(issuer.url)]);
  const before = Date.now();
  const result = await run(home);
  assertSucceeded(result);
  assert.ok(pending(home)[0].next_attempt_at >= before + 120_000);
  assertOnlyOldRevoke(issuer.received[0]);
});

test('queued credentials stay bound to their own API base despite every current endpoint override', async (t) => {
  const home = newHome(t);
  const issuer = await mockServer(t, (_req, res) => respond(res, 204));
  const other = await mockServer(t, (_req, res) => respond(res, 500));
  const oldBase = `${issuer.url}/old-issuer`;
  seed(home, other.url, [queued(oldBase)]);
  writeFileSync(join(home, 'config.json'), JSON.stringify({ api_url: `${other.url}/config` }));
  const result = await run(home, ['--api', `${other.url}/flag`], {
    env: { PINGROOM_API_URL: `${other.url}/environment`, PINGROOM_TOKEN: 'external-environment-token' },
  });
  assertSucceeded(result);
  assertNoTokens(result, [ACTIVE_TOKEN, OLD_TOKEN, 'external-environment-token']);
  assert.equal(other.received.length, 0);
  assert.equal(issuer.received.length, 1);
  assertOnlyOldRevoke(issuer.received[0], OLD_TOKEN, '/old-issuer/api/agent/auth/revoke');
  assert.deepEqual(pending(home), []);
});

test('missing and unsafe saved origins require manual cleanup without using the current API', async (t) => {
  const home = newHome(t);
  const current = await mockServer(t, (_req, res) => respond(res, 204));
  const override = await mockServer(t, (_req, res) => respond(res, 204));
  const records = [
    queued(null),
    queued(undefined, `${OLD_TOKEN}-missing`),
    queued(current.url.replace('http:', 'ftp:'), `${OLD_TOKEN}-unsafe`),
    queued('not a URL', `${OLD_TOKEN}-malformed`),
  ];
  seed(home, current.url, records);
  writeFileSync(join(home, 'config.json'), JSON.stringify({ api_url: `${override.url}/config` }));
  const original = pending(home);
  const env = { PINGROOM_API_URL: `${override.url}/environment` };
  const ordinary = await run(home, ['--api', `${override.url}/flag`], { env });
  assertSucceeded(ordinary);
  assertNoTokens(ordinary);
  assert.deepEqual(pending(home), original);

  const reported = await recover(home, { report: true, env });
  assertSucceeded(reported);
  assertNoTokens(reported);
  assert.match(reported.stdout, /manual removal is required/);
  assert.match(reported.stdout, /Remove the previous connection.*Connected Agents/);
  assert.doesNotMatch(reported.stdout, /will retry/);
  assert.equal(current.received.length, 0);
  assert.equal(override.received.length, 0);
  assert.equal(state(home).token, ACTIVE_TOKEN);
  assert.deepEqual(pending(home), original);
});

test('revocation never follows a redirect and retains the queued work', async (t) => {
  const home = newHome(t);
  const destination = await mockServer(t, (_req, res) => respond(res, 204));
  const issuer = await mockServer(t, (_req, res) => respond(res, 307, undefined, {
    Location: `${destination.url}/api/agent/auth/revoke`,
  }));
  seed(home, issuer.url, [queued(issuer.url)]);
  assertSucceeded(await run(home));
  assert.equal(destination.received.length, 0);
  assert.equal(issuer.received.length, 1);
  assertOnlyOldRevoke(issuer.received[0]);
  assert.equal(pending(home).length, 1);
});

test('ambiguous authorization and success responses do not discard unfinished revocations', async (t) => {
  for (const [status, body] of [
    [401, { message: 'Unauthenticated' }],
    [401, { code: 'other_auth_error' }],
    [403, { code: 'invalid_credential' }],
    [404, { code: 'not_found' }],
    [200, { ok: true }],
  ]) {
    await t.test(`HTTP ${status} ${JSON.stringify(body)}`, async (sub) => {
      const home = newHome(sub);
      const issuer = await mockServer(sub, (_req, res) => respond(res, status, body));
      seed(home, issuer.url, [queued(issuer.url)]);
      assertSucceeded(await run(home));
      assert.equal(pending(home).length, 1);
      assert.equal(state(home).token, ACTIVE_TOKEN);
      assertOnlyOldRevoke(issuer.received[0]);
    });
  }
});

test('a queued record matching the active credential never revokes that credential', async (t) => {
  const home = newHome(t);
  const issuer = await mockServer(t, (_req, res) => respond(res, 204));
  seed(home, issuer.url, [queued(issuer.url, ACTIVE_TOKEN), queued(issuer.url)]);
  assertSucceeded(await run(home));
  assert.equal(state(home).token, ACTIVE_TOKEN);
  assert.equal(issuer.received.length, 1);
  assertOnlyOldRevoke(issuer.received[0]);
});

test('recovery limits successful work per run and preserves the rest for a later command', async (t) => {
  const home = newHome(t);
  const issuer = await mockServer(t, (_req, res) => respond(res, 204));
  const records = Array.from({ length: 5 }, (_, index) => queued(issuer.url, `old-token-${index}`));
  seed(home, issuer.url, records);
  assertSucceeded(await run(home));
  assert.equal(issuer.received.length, 3);
  assert.equal(pending(home).length, 2);
  assertSucceeded(await run(home));
  assert.equal(issuer.received.length, 5);
  assert.deepEqual(pending(home), []);
  assert.equal(new Set(issuer.received.map((request) => request.auth)).size, 5);
});

test('an unresponsive issuer cannot indefinitely delay an ordinary CLI invocation', async (t) => {
  const home = newHome(t);
  const issuer = await mockServer(t, () => {});
  seed(home, issuer.url, [queued(issuer.url)]);
  const result = await run(home, [], { timeoutMs: 5000 });
  assertSucceeded(result);
  assert.ok(result.elapsedMs < 4000, `recovery took ${result.elapsedMs}ms`);
  assert.equal(issuer.received.length, 1);
  assert.equal(pending(home).length, 1);
  assert.equal(state(home).token, ACTIVE_TOKEN);
});

test('help, version, config and logout perform no revocation network requests', async (t) => {
  const issuer = await mockServer(t, (_req, res) => respond(res, 204));
  for (const args of [['--help'], ['help'], ['--version'], ['pair', '--help'], ['config', 'list'], ['logout']]) {
    await t.test(args.join(' '), async (sub) => {
      const home = newHome(sub);
      seed(home, issuer.url, [queued(issuer.url)]);
      const result = await run(home, args);
      assertSucceeded(result);
      assertNoTokens(result);
      assert.equal(issuer.received.length, 0);
      assert.equal(pending(home).length, 1);
      if (args[0] === 'logout') assert.ok(!state(home).token);
    });
  }
});

test('logout preserves cleanup work which a later recovery can finish without an active credential', async (t) => {
  const home = newHome(t);
  const issuer = await mockServer(t, (_req, res) => respond(res, 204));
  seed(home, issuer.url, [queued(issuer.url)]);
  assertSucceeded(await run(home, ['logout']));
  assert.equal(issuer.received.length, 0);
  assert.ok(!state(home).token);
  assert.equal(pending(home).length, 1);
  const result = await recover(home);
  assertSucceeded(result);
  assertNoTokens(result);
  assert.equal(issuer.received.length, 1);
  assertOnlyOldRevoke(issuer.received[0]);
  if (existsSync(join(home, 'credentials.json'))) {
    assert.ok(!state(home).token);
    assert.deepEqual(pending(home), []);
  }
});
