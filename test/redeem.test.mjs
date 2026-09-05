import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../bin/pingroom.js', import.meta.url));
const CODE = 'ABCD1234EFGH';
const RECEIPT = {
  message: 'Gift redeemed!', kind: 'gift', reward_days: null, package: 'monthly',
  lifetime: false, plan: 'pro', plan_expires_at: '2026-10-05T00:00:00Z',
};

function run(args, env = {}) {
  const home = mkdtempSync(join(tmpdir(), 'pingroom-redeem-'));
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PINGROOM_')));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, 'redeem', ...args], {
      env: { ...cleanEnv, PINGROOM_HOME: home, PINGROOM_NO_UPDATE_CHECK: '1', ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => {
      rmSync(home, { recursive: true, force: true });
      resolve({ status, stdout, stderr });
    });
    child.stdin.end();
  });
}

async function serverFor(t, reply) {
  const requests = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      requests.push({ method: req.method, path: req.url, authorization: req.headers.authorization, body: JSON.parse(raw || '{}') });
      reply(req, res);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, requests };
}

function respond(res, json, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(json));
}

test('redeem help describes account ownership, full access, and secret input without auth', async () => {
  const result = await run(['--help']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /human account that connected this agent/);
  assert.match(result.stdout, /PINGROOM_REDEEM_CODE/);
  assert.match(result.stdout, /Full-access connections include redemption/);
});

test('redeem normalizes a code, uses agent auth without a room, and returns the receipt', async (t) => {
  const { baseUrl, requests } = await serverFor(t, (_req, res) => respond(res, RECEIPT));
  const result = await run(['  abcd1234efgh  ', '--token', 'agent-token', '--api', baseUrl, '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), RECEIPT);
  assert.deepEqual(requests, [{
    method: 'POST', path: '/api/agent/redeem-code', authorization: 'Bearer agent-token', body: { code: CODE },
  }]);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(CODE, 'i'));
});

test('redeem accepts --code and a secret environment variable; explicit input wins', async (t) => {
  const { baseUrl, requests } = await serverFor(t, (_req, res) => respond(res, {
    ...RECEIPT, kind: 'redeem', package: null, reward_days: 30,
  }));
  const env = { PINGROOM_TOKEN: 'agent-token', PINGROOM_API_URL: baseUrl, PINGROOM_REDEEM_CODE: 'aaaa0000zzzz' };
  for (const args of [[], ['--code', CODE], [CODE]]) {
    const result = await run(args, env);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Code redeemed for the connected account\. Pro is active until 2026-10-05T00:00:00Z/);
  }
  assert.deepEqual(requests.map((req) => req.body.code), ['AAAA0000ZZZZ', CODE, CODE]);
});

test('redeem supports a paired credential with no home room and lifetime gifts', async (t) => {
  const { baseUrl, requests } = await serverFor(t, (_req, res) => respond(res, {
    ...RECEIPT, lifetime: true, package: 'lifetime', plan_expires_at: null,
  }));
  const home = mkdtempSync(join(tmpdir(), 'pingroom-paired-redeem-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  writeFileSync(join(home, 'credentials.json'), JSON.stringify({ version: 1, token: 'paired-token', api_url: baseUrl, room: null }));
  const result = await run([CODE], { PINGROOM_HOME: home });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Lifetime Pro is active/);
  assert.equal(requests[0].authorization, 'Bearer paired-token');
});

test('redeem rejects malformed or ambiguous input before auth without echoing codes', async () => {
  for (const args of [[], ['short'], [CODE.repeat(2)], ['ABCD1234-EFG'], ['abcdefghi0ß'], [CODE, CODE], [CODE, '--code', CODE], ['--secretCODE12']]) {
    const result = await run(args);
    assert.equal(result.status, 2, JSON.stringify(result));
    assert.equal(result.stdout, '');
    assert.doesNotMatch(result.stderr, /ABCD1234|short|abcdefghi0|secretCODE12/);
    assert.doesNotMatch(result.stderr, /agent token is required/);
  }
});

test('redeem requires auth and enforces the existing API transport and issuer boundaries', async (t) => {
  const unauthenticated = await run([CODE]);
  assert.equal(unauthenticated.status, 2);
  assert.match(unauthenticated.stderr, /agent token is required/);
  const cleartext = await run([CODE, '--token', 'token', '--api', 'http://example.com']);
  assert.equal(cleartext.status, 2);
  assert.match(cleartext.stderr, /must use https/);
  const home = mkdtempSync(join(tmpdir(), 'pingroom-bound-redeem-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  writeFileSync(join(home, 'credentials.json'), JSON.stringify({ version: 1, token: 'paired-token', api_url: 'https://api.pingroom.io' }));
  const redirected = await run([CODE, '--api', 'https://example.com'], { PINGROOM_HOME: home });
  assert.equal(redirected.status, 2);
  assert.match(redirected.stderr, /stored credential is bound/);
});

test('redeem reports eligibility, validation, rate limits and legacy scopes as errors without exposing the code', async (t) => {
  const responses = [
    [401, { message: 'Unauthenticated.' }, /pingroom reconnect/],
    [403, { code: 'insufficient_scope', message: 'Insufficient scope.' }, /pingroom reconnect/],
    [403, { code: 'gifting_disabled', message: 'Gifting is unavailable.' }, /Gifting is unavailable/],
    [422, { code: 'already_lifetime', message: 'You already have lifetime Pro.' }, /already have lifetime Pro/],
    [422, { message: 'Validation failed.', errors: { code: [`${CODE.toLowerCase()} is invalid or already redeemed.`] } }, /invalid or already redeemed/],
    [429, { message: 'Too many attempts.' }, /Too many attempts/],
  ];
  let index = 0;
  const { baseUrl, requests } = await serverFor(t, (_req, res) => {
    const [status, body] = responses[index++];
    respond(res, body, status);
  });
  for (const [, , message] of responses) {
    const result = await run([CODE, '--json'], { PINGROOM_TOKEN: 'token', PINGROOM_API_URL: baseUrl });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, message);
    assert.doesNotMatch(result.stderr, new RegExp(CODE, 'i'));
  }
  assert.equal(requests.length, responses.length);
});

test('redeem omits code echoes and control characters from successful JSON receipts', async (t) => {
  const { baseUrl } = await serverFor(t, (_req, res) => respond(res, {
    ...RECEIPT, message: `Redeemed ${CODE.toLowerCase()}\u001b`, code: CODE, extra: { code: CODE },
  }));
  const result = await run([CODE, '--json'], { PINGROOM_TOKEN: 'token', PINGROOM_API_URL: baseUrl });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).message, 'Redeemed [redacted]');
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(CODE, 'i'));
  assert.equal(JSON.parse(result.stdout).code, undefined);
  assert.equal(JSON.parse(result.stdout).extra, undefined);
});

test('redeem rejects unconfirmed, malformed, dropped and redirected responses without retries', async (t) => {
  for (const reply of [
    (_req, res) => respond(res, { message: 'OK' }),
    (_req, res) => { res.writeHead(200); res.end(`invalid JSON ${CODE}`); },
    (req) => req.socket.destroy(),
    (_req, res) => { res.writeHead(307, { Location: '/do-not-follow' }); res.end(); },
  ]) {
    const { baseUrl, requests } = await serverFor(t, reply);
    const result = await run([CODE, '--json'], { PINGROOM_TOKEN: 'token', PINGROOM_API_URL: baseUrl });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Check your account plan before retrying/);
    assert.doesNotMatch(result.stderr, new RegExp(CODE, 'i'));
    assert.equal(requests.length, 1);
  }
});
