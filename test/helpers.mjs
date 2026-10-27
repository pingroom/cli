import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const CLI = join(__dirname, '..', 'bin', 'pingroom.js');

/**
 * Run the CLI as a real subprocess and capture its exit code + streams.
 * Pass `env` overrides for credential/endpoint config. PINGROOM_* env vars
 * are stripped by default so the host machine's config can't leak in.
 */
// A throwaway PINGROOM_HOME shared by every run that doesn't ask for its own,
// so the developer's real ~/.pingroom (paired credential, default_room) can
// never change what a test sees.
export const EMPTY_HOME = mkdtempSync(join(tmpdir(), 'pingroom-empty-'));

// The API base every spawned CLI gets unless a test names its own. Loopback,
// and port 9 is on fetch's blocked-port list, so a request fails at once
// without opening a socket. Without it, a test that forgets --api falls
// through to the built-in https://api.pingroom.io and sends real traffic to
// production. A test that needs the built-in default (or a config/credential
// api_url to win) passes PINGROOM_API_URL: undefined, which spawn drops.
export const UNROUTABLE_API = 'http://127.0.0.1:9';

/** Strip every PINGROOM_* input and pin the local state at an empty directory. */
export function baseEnv() {
  const cleanEnv = { ...process.env };
  delete cleanEnv.PINGROOM_WEBHOOK_URL;
  delete cleanEnv.PINGROOM_TOKEN;
  cleanEnv.PINGROOM_API_URL = UNROUTABLE_API;
  delete cleanEnv.PINGROOM_ROOM;
  delete cleanEnv.PINGROOM_INTERNAL_TEST_TTY;
  delete cleanEnv.PINGROOM_INTERNAL_ACTIVATION_TIMEOUT_MS;
  delete cleanEnv.NODE_ENV;
  cleanEnv.PINGROOM_HOME = EMPTY_HOME;
  // No test may reach the npm registry. Spawned tests already have piped stdio
  // (so the TTY gate suppresses the check), but a belt-and-braces opt-out keeps
  // the suite hermetic if that gate is ever loosened.
  cleanEnv.PINGROOM_NO_UPDATE_CHECK = '1';
  return cleanEnv;
}

export function run(args, env = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    env: { ...baseEnv(), ...env },
    encoding: 'utf8',
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/**
 * Async variant for tests that need an in-process stub server: spawnSync would
 * block the event loop and deadlock against a localhost server running in the
 * same process, so use async spawn and resolve on close.
 *
 * `stdin` feeds the interactive prompts (the connect picker, email, OTP); it is
 * written as one blob and the pipe is closed, which is enough because every
 * prompt is answered in order.
 *
 * `timeoutMs` kills the child and reports `timedOut`. Tests that assert a loop
 * terminates need it: without a kill, a regression that reintroduces the loop
 * hangs the whole suite instead of failing one test.
 *
 * `execPath` / `execArgs` let a test start node differently (a umask wrapper, a
 * --import preload) while keeping the same env scrubbing and capture.
 */
export function runAsync(args, env = {}, { stdin, timeoutMs, execPath, execArgs = [], holdStdin = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(execPath ?? process.execPath, [...execArgs, CLI, ...args], {
      env: { ...baseEnv(), ...env },
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = timeoutMs
      ? setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs)
      : null;
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', (err) => { if (timer) clearTimeout(timer); reject(err); });
    child.on('close', (status) => {
      if (timer) clearTimeout(timer);
      resolve({ status, stdout, stderr, timedOut });
    });
    if (stdin !== undefined) child.stdin.write(stdin);
    // holdStdin leaves the pipe OPEN for the child's whole life, the way a
    // daemon's inherited stdin behaves. A command that attaches a prompter
    // (stdin.resume()) never exits under this, which is the point.
    if (!holdStdin) child.stdin.end();
  });
}

/** Start a one-shot localhost stub server. Resolves once it's listening. */
export function startServer(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

/** Route a stub server by "METHOD /pathname". Each handler returns { status, body }. */
export function questionServer(routes) {
  const received = [];
  return startServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const path = req.url.split('?')[0];
      received.push({ method: req.method, path, query: req.url.split('?')[1] ?? '', auth: req.headers['authorization'], idempotency: req.headers['idempotency-key'], body });
      const handler = routes[`${req.method} ${path}`];
      const out = handler ? handler(body) : { status: 404, body: { message: 'no route' } };
      res.writeHead(out.status ?? 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out.body ?? {}));
    });
  }).then((s) => ({ ...s, received }));
}

export function parseGitHubOutputFile(raw) {
  const lines = raw.split('\n');
  const outputs = {};
  for (let i = 0; i < lines.length;) {
    if (lines[i] === '') {
      i += 1;
      continue;
    }
    const header = /^([A-Za-z0-9_-]+)<<(.+)$/.exec(lines[i]);
    assert.ok(header, `invalid GitHub output header: ${lines[i]}`);
    const [, name, delimiter] = header;
    i += 1;
    const valueLines = [];
    while (i < lines.length && lines[i] !== delimiter) {
      valueLines.push(lines[i]);
      i += 1;
    }
    assert.equal(lines[i], delimiter, `missing delimiter for ${name}`);
    i += 1;
    outputs[name] = valueLines.join('\n');
  }
  return outputs;
}

/** A fresh, isolated PINGROOM_HOME. */
export function newHome() {
  return mkdtempSync(join(tmpdir(), 'pingroom-home-'));
}

/** Seed a credentials.json the way a completed pairing would have written it. */
export function seedCredential(home, cred) {
  writeFileSync(join(home, 'credentials.json'), `${JSON.stringify({ version: 1, ...cred })}\n`, { mode: 0o600 });
}

export function activationEnsureResponse(expiresAt = '2099-01-01T00:00:00Z') {
  return {
    status: 201,
    body: {
      onboarded: true,
      replayed: false,
      room: { id: 'room-1', name: 'Project X', invite_code: 'ABC123', is_agent_inbox: false },
      question: {
        id: 'q-onboard',
        kind: 'question',
        prompt: 'PingRoom connected. Can you answer this?',
        state: 'pending',
        options: [{ value: 'yes', label: 'Yes' }],
        expires_at: expiresAt,
        created_at: '2026-08-09T00:00:00Z',
      },
    },
  };
}

export function confirmedActivationResponse(overrides = {}) {
  return {
    status: 200,
    body: {
      id: 'q-onboard',
      kind: 'question',
      state: 'answered',
      answer: {
        value: 'yes', label: 'Yes', text: null,
        responder: { id: 'u1', display_name: 'Mahdi' }, answered_at: '2026-08-09T00:01:00Z',
      },
      activation_completed: true,
      ...overrides,
    },
  };
}

export const PROVISIONED_AGENT = {
  id: 'agent-1',
  label: 'PingRoom CLI',
  handle: 'agt_ab12cd34ef',
  profile: {
    display_name: 'PingRoom CLI',
    handle: 'agt_ab12cd34ef',
    avatar_id: 'bot-7',
    avatar_url: 'https://api.pingroom.io/avatars/bot-7.png',
  },
};

/**
 * Stub the pairing endpoints. `statuses` is consumed one entry per poll; the
 * last entry repeats. `rounds` counts how many times pairing was restarted.
 */
export function pairingServer(statuses, { onRegister, ensureResponses, waitResponses } = {}) {
  const received = [];
  let poll = 0;
  let ensureCall = 0;
  let waitCall = 0;
  let provisionedAgent = PROVISIONED_AGENT;
  const ensureSequence = ensureResponses ?? [activationEnsureResponse()];
  const waitSequence = waitResponses ?? [confirmedActivationResponse()];
  return startServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const path = req.url.split('?')[0];
      received.push({ method: req.method, path, auth: req.headers['authorization'], body, at: Date.now() });
      let out;
      if (path === '/api/agent/auth') {
        if (onRegister) onRegister();
        const requestedLabel = JSON.parse(body).agent_label;
        provisionedAgent = {
          ...PROVISIONED_AGENT,
          label: requestedLabel,
          profile: { ...PROVISIONED_AGENT.profile, display_name: requestedLabel },
        };
        out = {
          status: 200,
          body: {
            flow_version: 2,
            claim_mode: 'agent_identity',
            agent: provisionedAgent,
            credential: 'pre_claim_jwt',
            credential_type: 'pre_claim',
            expires_in: 900,
            scopes: [],
          },
        };
      } else if (path === '/api/agent/auth/pair/start') {
        out = {
          status: 200,
          body: {
            flow_version: 2,
            claim_mode: 'agent_identity',
            agent: provisionedAgent,
            pair_token: 'p'.repeat(64),
            pair_url: `https://pingroom.io/app/agents/pair?token=${'p'.repeat(64)}`,
            pair_browser_url: `https://api.pingroom.io/pair?token=${'p'.repeat(64)}`,
            pair_qr_url: `https://pingroom.io/app/agents/pair?token=${'p'.repeat(64)}`,
            app_install_url: 'https://pingroom.io/i',
            expires_in: 900,
            poll_interval_ms: 10,
          },
        };
      } else if (path === '/api/agent/auth/pair/status') {
        const pairingStatus = statuses[Math.min(poll++, statuses.length - 1)];
        out = {
          status: 200,
          body: pairingStatus.status === 'active'
            ? { ...pairingStatus, agent: provisionedAgent }
            : pairingStatus,
        };
      } else if (path === '/api/agent/inbox/ensure') {
        out = ensureSequence[Math.min(ensureCall++, ensureSequence.length - 1)];
      } else if (path === '/api/agent/handoffs/q-onboard/wait') {
        out = waitSequence[Math.min(waitCall++, waitSequence.length - 1)];
      } else {
        out = { status: 404, body: { message: 'no route' } };
      }
      res.writeHead(out.status, { 'Content-Type': 'application/json', ...out.headers });
      res.end(JSON.stringify(out.body));
    });
  }).then((s) => ({ ...s, received }));
}

export const ACTIVE_PAIR = {
  status: 'active',
  flow_version: 2,
  claim_mode: 'agent_identity',
  agent: PROVISIONED_AGENT,
  owner: { name: 'Mahdi' },
  credential: 'active_jwt',
  credential_type: 'active',
  expires_in: 0,
  handle: 'agt_ab12cd34ef',
  scopes: ['pingroom:broadcast:send', 'pingroom:handoffs:create'],
  account: { name: 'Mahdi' },
  room: { invite_code: 'ABC123', name: 'Project X' },
  home_room: { invite_code: 'ABC123', name: 'Project X' },
  room_access: 'selected',
  rooms: [{ id: 'room-1', invite_code: 'ABC123', name: 'Project X' }],
  room_membership: {
    status: 'active',
    joined_at: '2026-09-03T08:00:00Z',
    removed_at: null,
    room: { invite_code: 'ABC123', name: 'Project X' },
  },
  links: {
    latest_pings: 'https://api.pingroom.io/api/agent/notifications?limit=25&page=1',
    install_app: 'https://pingroom.io/i',
  },
};

/**
 * Pairing stub whose /pair/status responses are scripted as raw HTTP results,
 * so a test can inject a 502, a 429 or a dropped socket. `drop: true` destroys
 * the connection, which is what the CLI sees as a network error. The last entry
 * repeats. `pairStart` overrides the pair/start body.
 */
export function flakyPairingServer(responses, { pairStart = {} } = {}) {
  const received = [];
  const statusTimes = [];
  let poll = 0;
  let registrations = 0;
  return startServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const path = req.url.split('?')[0];
      received.push({ method: req.method, path, auth: req.headers['authorization'], body });
      if (path === '/api/agent/auth') {
        registrations += 1;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ credential: 'pre_claim_jwt', credential_type: 'pre_claim', expires_in: 900, scopes: [] }));
        return;
      }
      if (path === '/api/agent/auth/pair/start') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          pair_token: 'p'.repeat(64),
          pair_url: `https://pingroom.io/app/agents/pair?token=${'p'.repeat(64)}`,
          expires_in: 900,
          poll_interval_ms: 10,
          ...pairStart,
        }));
        return;
      }
      if (path === '/api/agent/auth/pair/status') {
        statusTimes.push(Date.now());
        const spec = responses[Math.min(poll++, responses.length - 1)];
        if (spec.drop) { req.socket.destroy(); return; }
        res.writeHead(spec.httpStatus ?? 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(spec.body ?? {}));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  }).then((s) => ({
    ...s,
    received,
    statusTimes,
    get registrations() { return registrations; },
  }));
}

/** The env every interactive test needs, now that the TTY override is double-locked. */
export function ttyEnv(home, extra = {}) {
  return { PINGROOM_HOME: home, PINGROOM_INTERNAL_TEST_TTY: '1', NODE_ENV: 'test', ...extra };
}

/** Pairing endpoints plus a revoke route, so reconnect can be driven end to end. */
export function reconnectServer({ revokeStatus = 204, statuses = [ACTIVE_PAIR] } = {}) {
  const received = [];
  let poll = 0;
  return startServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const path = req.url.split('?')[0];
      received.push({ method: req.method, path, auth: req.headers['authorization'], body });
      let out;
      if (path === '/api/agent/auth') {
        out = {
          status: 200,
          body: {
            flow_version: 2,
            claim_mode: 'agent_identity',
            agent: PROVISIONED_AGENT,
            credential: 'pre_claim_jwt',
            credential_type: 'pre_claim',
            expires_in: 900,
            scopes: [],
          },
        };
      } else if (path === '/api/agent/auth/pair/start') {
        out = {
          status: 200,
          body: {
            flow_version: 2,
            claim_mode: 'agent_identity',
            agent: PROVISIONED_AGENT,
            pair_token: 'p'.repeat(64),
            pair_url: `https://api.pingroom.io/pair?token=${'p'.repeat(64)}`,
            pair_qr_url: `https://pingroom.io/app/agents/pair?token=${'p'.repeat(64)}`,
            expires_in: 900,
            poll_interval_ms: 10,
          },
        };
      } else if (path === '/api/agent/auth/pair/status') {
        out = { status: 200, body: statuses[Math.min(poll++, statuses.length - 1)] };
      } else if (path === '/api/agent/auth/revoke') {
        // 204 No Content is the real shape; the CLI must not read it as failure.
        out = { status: revokeStatus, body: revokeStatus === 204 ? null : { message: 'nope' } };
      } else {
        out = { status: 404, body: { message: 'no route' } };
      }
      res.writeHead(out.status, { 'Content-Type': 'application/json' });
      res.end(out.body === null ? '' : JSON.stringify(out.body));
    });
  }).then((s) => ({ ...s, received }));
}

/** A stub that answers both transports and records which one was used. */
export function transportServer() {
  return questionServer({
    'POST /webhooks/room/HOOKSECRET': () => ({ status: 200, body: { success: true } }),
    'POST /api/agent/rooms/ab12cd/notifications': () => ({ status: 201, body: { id: 'n1' } }),
    'POST /api/agent/rooms/ab12cd/live': () => ({ status: 200, body: { state: 'running' } }),
    'POST /api/agent/attachments': () => ({ status: 201, body: { attachment: { id: 'att-1' } } }),
  });
}
