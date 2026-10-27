import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { HELP } from '../lib/help.js';
import { CLI, run, runAsync, startServer, questionServer, newHome, flakyPairingServer } from './helpers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

test('the published tarball carries every directory the entry point imports', () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
  // A tarball missing `lib` installs a bin/ that cannot resolve its own imports,
  // which only shows up after publish. Fail here instead.
  assert.ok(pkg.files.includes('bin'), 'package.json files must include bin');
  assert.ok(pkg.files.includes('lib'), 'package.json files must include lib');
});

// ---------------------------------------------------------------------------
// Exit 0 — help / no-command
// ---------------------------------------------------------------------------

test('exit 0: no command prints help', () => {
  const { status, stdout } = run([]);
  assert.equal(status, 0);
  assert.match(stdout, /pingroom — send a ping/);
});

test('exit 0: --help prints help', () => {
  // HELP names the default API, which a PINGROOM_API_URL in the child changes.
  const { status, stdout } = run(['--help'], { PINGROOM_API_URL: undefined });
  assert.equal(status, 0);
  assert.equal(stdout, `${HELP}\n`, 'piped help must be flushed in full before exiting');
});

test('exit 0: -h prints help', () => {
  const { status } = run(['-h']);
  assert.equal(status, 0);
});

test('exit 0: "help" command prints help', () => {
  const { status, stdout } = run(['help']);
  assert.equal(status, 0);
  assert.match(stdout, /Usage:/);
});

test('exit 0: --version and -v print the package version', () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
  for (const flag of ['--version', '-v']) {
    const { status, stdout, stderr } = run([flag]);
    assert.equal(status, 0);
    assert.equal(stdout, `${pkg.version}\n`);
    assert.equal(stderr, '');
  }
});

// ---------------------------------------------------------------------------
// Exit 2 — bad usage
// ---------------------------------------------------------------------------

test('exit 2: unknown command', () => {
  const { status, stderr } = run(['frobnicate']);
  assert.equal(status, 2);
  assert.match(stderr, /unknown command: frobnicate/);
});

test('exit 2: unknown option', () => {
  const { status, stderr } = run(['ping', '--bogus', 'x']);
  assert.equal(status, 2);
  assert.match(stderr, /Unknown option: --bogus/);
});

test('a failing command still flushes everything it already wrote to a pipe', async () => {
  // fail() used to call process.exit() straight away, and piped stdout is
  // asynchronous on macOS: everything past the first 64 KiB was dropped.
  const receipt = JSON.stringify({ success: false, message: 'Rejected', data: 'x'.repeat(256 * 1024) });
  const { server, baseUrl } = await startServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(422, { 'Content-Type': 'application/json' });
      res.end(receipt);
    });
  });
  try {
    const { status, stdout, stderr } = await runAsync(['ping', '-w', `${baseUrl}/hook`, '-m', 'hello', '--json']);
    assert.equal(status, 1);
    assert.match(stderr, /delivery failed: Rejected/);
    assert.equal(stdout, `${receipt}\n`);
  } finally {
    server.close();
  }
});

test('a test that forgets --api fails fast on loopback instead of reaching production', () => {
  // baseEnv() pins PINGROOM_API_URL; without it this would PUT to the built-in
  // https://api.pingroom.io with a dummy bearer on every run.
  const { status, stderr } = run(['ping', '--token', 'tok', '--room', 'ab12cd', '-m', 'hi']);
  assert.equal(status, 1);
  assert.match(stderr, /network error \(http:\/\/127\.0\.0\.1:9\)/);
  assert.doesNotMatch(stderr, /api\.pingroom\.io/);
});

test('exit 1: duplicate JSON keys from the API are rejected before command parsing', async () => {
  const { server, baseUrl } = await startServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"id":"safe","id":"attacker","state":"pending"}');
  });
  try {
    const { status, stderr } = await runAsync(
      ['ask', '--token', 't', '--room', 'ab12cd', '--prompt', 'Approve?', '--json'],
      { PINGROOM_API_URL: baseUrl },
    );
    assert.equal(status, 1);
    assert.match(stderr, /untrusted JSON response.*duplicate object key/i);
  } finally {
    server.close();
  }
});

test('exit 1: invalid UTF-8 from the API is rejected before command parsing', async () => {
  const { server, baseUrl } = await startServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(Buffer.from([0xff]));
  });
  try {
    const { status, stderr } = await runAsync(
      ['ask', '--token', 't', '--room', 'ab12cd', '--prompt', 'Approve?', '--json'],
      { PINGROOM_API_URL: baseUrl },
    );
    assert.equal(status, 1);
    assert.match(stderr, /untrusted JSON response.*UTF-8/i);
  } finally {
    server.close();
  }
});

test('help documents the credential store, the precedence, and the absence of a login command', () => {
  const { stdout } = run(['--help']);
  assert.match(stdout, /~\/\.pingroom\/credentials\.json/);
  assert.match(stdout, /PINGROOM_HOME/);
  // The paired credential is a real layer, not a dead field: resolveApiBase and
  // resolveRoom both consult it, so the documented chain has to name it.
  assert.match(stdout, /explicit flag\s+>\s+env var\s+>\s+~\/\.pingroom\/config\.json\s+>\s+the paired\s+credential\s+>\s+built-in default/);
  assert.match(stdout, /There is no "login" command/);
  assert.match(stdout, /^  activate /m);
  // Connecting sends nothing to the phone, and the help has to say so — the
  // optional test Question is what "activate" is for.
  assert.match(stdout, /connecting sends nothing to your phone/);
  assert.match(stdout, /Run "pingroom activate" if you want to prove the round-trip/);
  assert.match(stdout, /https:\/\/pingroom\.io\/i/);
  assert.match(stdout, /urgent Pings, questions, approvals, handoffs, and live progress/);
  assert.match(stdout, /Installing the app does not claim a robot or grant it access/);
  assert.match(stdout, /keep it running and reuse its claim link/);
  assert.match(stdout, /^  config   /m);
  assert.match(stdout, /^  logout   /m);
  assert.match(stdout, /stored credential is bound to the origin it was paired\s+against/);
  assert.match(stdout, /provide that host's token with --token or PINGROOM_TOKEN/);
});

// --- argument parsing -------------------------------------------------------

test('inherited Object properties in flag position are not treated as options', async () => {
  // `alias[token]` walked the prototype chain, so `constructor` resolved to a
  // truthy value, was parsed as an option, and ate the argument after it —
  // here, the entire `-m hi` pair.
  const { server, baseUrl, received } = await startServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    });
  }).then((s) => ({ ...s, received: [] }));
  try {
    for (const poison of ['constructor', 'toString', '__proto__', 'valueOf', 'hasOwnProperty']) {
      const { status, stderr } = await runAsync(['ping', '-w', `${baseUrl}/hook`, poison, '-m', 'hi']);
      assert.equal(status, 0, `${poison} swallowed the message: ${stderr}`);
    }
    // And they are still rejected when they arrive as an actual flag.
    const { status, stderr } = await runAsync(['ping', '-w', `${baseUrl}/hook`, '--constructor', '-m', 'hi']);
    assert.equal(status, 2);
    assert.match(stderr, /Unknown option: --constructor/);
  } finally {
    server.close();
  }
});

test('config, logout, and handoffs reject flags they never read', () => {
  // These three shared parseQArgs, so `logout --wait --prompt x` parsed fine
  // and the flags were silently ignored — inconsistent with the strict
  // unknown-flag rejection every other command applies.
  const cases = [
    ['config', 'list', '--wait'],
    ['config', 'set', 'default_room', 'ab12cd', '--prompt', 'x'],
    ['logout', '--wait'],
    ['logout', '--prompt', 'x'],
    ['handoffs', '--prompt', 'x'],
    ['handoffs', '--wait'],
  ];
  for (const argv of cases) {
    const { status, stderr } = run(argv);
    assert.equal(status, 2, `${argv.join(' ')} should be a usage error`);
    assert.match(stderr, /Unknown option: --(wait|prompt)/);
  }
});

test('handoffs still accepts its own flags after the strict table', () => {
  // --state validation fires after parsing, so reaching its message proves
  // --state/--token parsed; --json and --api are covered by the API tests.
  const { status, stderr } = run(['handoffs', '--token', 'tok', '--state', 'answered']);
  assert.equal(status, 2);
  assert.match(stderr, /--state must be 'open' or 'all'/);
});

// --- the interactive gate ---------------------------------------------------

test('interactivity needs BOTH streams to be a TTY, not just stdin', async () => {
  // Dropping the `stdout.isTTY` half passed every existing test, because the
  // suite only ever runs with both piped. This forces stdin.isTTY on via a
  // preload while stdout stays a pipe: the CLI must still refuse to prompt,
  // because a QR rendered into a pipe is unscannable garbage.
  const preloadDir = mkdtempSync(join(tmpdir(), 'pingroom-preload-'));
  const stdinOnly = join(preloadDir, 'stdin-tty.mjs');
  const bothTty = join(preloadDir, 'both-tty.mjs');
  writeFileSync(stdinOnly, 'process.stdin.isTTY = true;\n');
  writeFileSync(bothTty, 'process.stdin.isTTY = true;\nprocess.stdout.isTTY = true;\n');

  const home = newHome();
  const stub = await flakyPairingServer([{ body: { status: 'expired' } }]);
  try {
    // stdin is a TTY, stdout is not -> non-interactive.
    const piped = await runAsync(['--api', stub.baseUrl], { PINGROOM_HOME: home }, {
      execArgs: ['--import', pathToFileURL(stdinOnly).href],
      timeoutMs: 15_000,
    });
    assert.equal(piped.status, 0);
    assert.match(piped.stderr, /not connected/);
    assert.doesNotMatch(piped.stdout, /Choose \[1\]/);
    assert.equal(stub.registrations, 0, 'a non-interactive run must not start pairing');

    // Both TTYs -> the picker runs, with no PINGROOM_INTERNAL_TEST_TTY at all.
    const tty = await runAsync(['--api', stub.baseUrl], { PINGROOM_HOME: home, COLUMNS: '20' }, {
      execArgs: ['--import', pathToFileURL(bothTty).href],
      stdin: '1\nn\n',
      timeoutMs: 15_000,
    });
    assert.match(tty.stdout, /Choose \[1\]/);
    assert.equal(stub.registrations, 1);
  } finally {
    stub.server.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(preloadDir, { recursive: true, force: true });
  }
});

test('the TTY override is double-locked so it cannot fire in a normal install', async () => {
  // A single well-known env var in the shipped binary is one stray `export`
  // away from making a CI job prompt into the void for the full pairing window.
  const home = newHome();
  const stub = await flakyPairingServer([{ body: { status: 'expired' } }]);
  try {
    // The retired name does nothing at all.
    const retired = await runAsync(['--api', stub.baseUrl], { PINGROOM_HOME: home, PINGROOM_FORCE_TTY: '1' }, { timeoutMs: 15_000 });
    assert.match(retired.stderr, /not connected/);

    // Neither half is sufficient on its own.
    const onlyFlag = await runAsync(['--api', stub.baseUrl], { PINGROOM_HOME: home, PINGROOM_INTERNAL_TEST_TTY: '1' }, { timeoutMs: 15_000 });
    assert.match(onlyFlag.stderr, /not connected/);

    const onlyEnv = await runAsync(['--api', stub.baseUrl], { PINGROOM_HOME: home, NODE_ENV: 'test' }, { timeoutMs: 15_000 });
    assert.match(onlyEnv.stderr, /not connected/);

    assert.equal(stub.registrations, 0, 'none of these may reach the pairing flow');
  } finally {
    stub.server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('the shipped binary does not advertise the TTY override', () => {
  const source = readFileSync(CLI, 'utf8');
  assert.doesNotMatch(source, /PINGROOM_FORCE_TTY/);
  // It must not be documented as a supported knob either.
  const { stdout } = run(['--help']);
  assert.doesNotMatch(stdout, /FORCE_TTY|INTERNAL_TEST_TTY/);
});

test('over-long fields fail locally with the limit named, not as a 422', async () => {
  let requests = 0;
  const { server, baseUrl } = await startServer((req, res) => {
    requests += 1;
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end('{"id":"n1"}');
  });

  const cases = [
    { argv: ['ping', '-m', 'x'.repeat(161)], expect: /--message must be at most 160 characters \(got 161\)/ },
    { argv: ['ping', '-m', 'ok', '-t', 'x'.repeat(41)], expect: /--title must be at most 40 characters/ },
    { argv: ['ask', '-p', 'x'.repeat(501)], expect: /--prompt must be at most 500 characters/ },
    { argv: ['ask', '-p', 'ok', '-c', 'x'.repeat(41)], expect: /--context must be at most 40 characters/ },
    // Live status is a structured payload with its own 256-character contract.
    { argv: ['live', 'start', '-c', 'x', '-m', 'x'.repeat(257)], expect: /--message must be at most 256 characters/ },
  ];

  try {
    for (const { argv, expect } of cases) {
      const { status, stderr } = await runAsync([...argv, '--token', 'tok', '--room', 'AB12', '--api', baseUrl]);
      assert.equal(status, 2, argv.join(' '));
      assert.match(stderr, expect);
    }
    assert.equal(requests, 0, 'a local usage error must not reach the network');
  } finally {
    server.close();
  }
});

test('an unexpected error prints one line, not a stack trace', async () => {
  // A body that is not JSON at all, on a 200, drives the parser off its
  // expected shape — whatever escapes must still read like a CLI error.
  const { server, baseUrl } = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"notifications": "not-an-array", "cursor": 5}');
  });

  try {
    const { status, stderr } = await runAsync(
      ['listen', '--once', '--from', 'n1', '--token', 'tok', '--api', baseUrl],
      {},
      { timeoutMs: 8000 },
    );
    // Either it copes (0) or it fails cleanly (1) — never a raw stack.
    assert.ok(status === 0 || status === 1, `unexpected exit ${status}`);
    assert.doesNotMatch(stderr, /at .*bin\/pingroom\.js:\d+/);
  } finally {
    server.close();
  }
});

// --- command-to-route scope documentation ----------------------------------
// Pairing policy is server-owned. This map only keeps client commands aligned
// with the protected routes they call; it is never sent during negotiation.

test('every dispatched command declares the scopes it needs', async () => {
  const { COMMAND_SCOPES } = await import('./support/command-scopes.js');
  const source = readFileSync(new URL('../bin/pingroom.js', import.meta.url), 'utf8');

  // Read the dispatch table out of the binary itself rather than restating it,
  // so adding a command to COMMANDS and forgetting this map is a failure here.
  const table = source.slice(source.indexOf('const COMMANDS = {'), source.indexOf('\n};', source.indexOf('const COMMANDS = {')));
  // `[:,]` not `:` — an ES6 shorthand entry (`  mcp,`) is still a dispatched
  // command, and a colon-only pattern gave it, and any future shorthand entry,
  // a free pass through the guard below.
  const dispatched = [...table.matchAll(/^\s{2}([a-z]+)[:,]/gm)].map((m) => m[1]);

  assert.ok(dispatched.length >= 22, `expected the full dispatch table, saw ${dispatched.length}`);
  assert.ok(dispatched.includes('mcp'), 'shorthand entries must be captured');
  for (const command of dispatched) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(COMMAND_SCOPES, command),
      `"${command}" is dispatched but declares no scopes in test/support/command-scopes.js — add it (use [] if it touches no agent route)`,
    );
  }
});

test('the npm package ships no test-only module', () => {
  // `files: ["bin", "lib"]` publishes everything under lib/, so a module only
  // the tests import belongs under test/.
  assert.equal(existsSync(join(__dirname, '..', 'lib', 'scopes.js')), false);
  assert.equal(existsSync(join(__dirname, '..', 'lib', 'continuations.js')), false);
});

test('ask, handoff and live measure --data the way the server does', () => {
  // ~1,500 Persian characters: about 3 KB of UTF-8, but about 9 KB once PHP's
  // json_encode turns each into a 6-byte \uXXXX escape.
  const persian = JSON.stringify({ note: 'ش'.repeat(1500) });
  assert.ok(Buffer.byteLength(persian, 'utf8') < 8 * 1024, 'the old UTF-8 check let this through');
  for (const argv of [
    ['ask', '--token', 'tok', '--room', 'ab12cd', '-p', 'Ship?', '--data', persian],
    ['handoff', '--token', 'tok', '-m', 'Ship?', '--data', persian],
    ['live', 'start', '--token', 'tok', '--room', 'ab12cd', '-c', 'deploy-1', '--data', persian],
  ]) {
    const { status, stderr } = run(argv);
    assert.equal(status, 2, `${argv[0]}: ${stderr}`);
    assert.match(stderr, /--data must serialize to at most 8 KB as the server measures it/);
  }
});

// --- Retry-After bounds -------------------------------------------------------

test('Retry-After is floored at 1 s and capped at 60 s for every caller', async () => {
  const { retryAfterMs } = await import('../lib/http.js');
  const header = (value) => ({ headers: new Headers(value === undefined ? {} : { 'Retry-After': value }) });
  assert.equal(retryAfterMs(header(undefined)), null);
  assert.equal(retryAfterMs(header('soon')), null);
  // 0 and a past HTTP date used to mean "retry immediately".
  assert.equal(retryAfterMs(header('0')), 1000);
  assert.equal(retryAfterMs(header(new Date(Date.now() - 60_000).toUTCString())), 1000);
  assert.equal(retryAfterMs(header('3')), 3000);
  // Past 2^31-1 ms Node's setTimeout fires after 1 ms, so an unbounded value
  // turned "wait a very long time" into "retry back to back".
  assert.equal(retryAfterMs(header('9999999')), 60_000);
  // A persisted schedule (credential cleanup) may opt into a longer ceiling.
  assert.equal(retryAfterMs(header('120'), { max: 24 * 60 * 60 * 1000 }), 120_000);
});

// --- secrets never reach stderr through a fetch error ------------------------

test('a webhook or API URL with user credentials is refused before anything is sent', () => {
  const secretHook = 'https://u:p@127.0.0.1/webhooks/room/WEBHOOKSECRETPATH';
  for (const argv of [
    ['ping', '-m', 'hi', '--webhook', secretHook],
    ['live', 'start', '-c', 'deploy-1', '--webhook', secretHook],
    ['ping', '-m', 'hi', '--token', 'tok', '--room', 'ab12cd', '--api', 'https://u:p@127.0.0.1'],
  ]) {
    const { status, stderr } = run(argv);
    assert.equal(status, 2, `${argv.join(' ')}: ${stderr}`);
    assert.match(stderr, /must not contain URL user credentials/);
    assert.doesNotMatch(stderr, /WEBHOOKSECRETPATH|u:p@/);
  }
  const { status, stderr } = run(['ping', '-m', 'hi'], { PINGROOM_WEBHOOK_URL: secretHook });
  assert.equal(status, 2);
  assert.doesNotMatch(stderr, /WEBHOOKSECRETPATH/);
});

test('a fetch error that quotes the bearer is reported without it', async () => {
  // fetch() refuses a header value with a line break and quotes the whole
  // value in its message — here, the token.
  const { server, baseUrl, received } = await questionServer({});
  try {
    const { status, stderr } = await runAsync(['ping', '-m', 'hi', '--token', 'tok\nTOKENSECRET', '--room', 'ab12cd', '--api', baseUrl]);
    assert.equal(status, 1);
    assert.match(stderr, /network error \(http:\/\/127\.0\.0\.1:\d+\): the request could not be built/);
    assert.doesNotMatch(stderr, /TOKENSECRET/);
    assert.equal(received.length, 0);
  } finally {
    server.close();
  }
});

// --- a create without an id is not a success --------------------------------

test('ask, approval and handoff fail when a 2xx create carries no id', async () => {
  const { server, baseUrl } = await questionServer({
    'POST /api/agent/rooms/ab12cd/questions': () => ({ status: 201, body: {} }),
    'POST /api/agent/handoffs': () => ({ status: 201, body: { state: 'open' } }),
  });
  const dir = mkdtempSync(join(tmpdir(), 'pingroom-noid-'));
  try {
    const outputs = join(dir, 'github-output');
    writeFileSync(outputs, '');
    for (const [argv, what] of [
      [['ask', '--token', 'tok', '--room', 'ab12cd', '-p', 'Ship?', '--github-output', outputs], 'ask'],
      [['ask', '--token', 'tok', '--room', 'ab12cd', '-p', 'Ship?', '--wait'], 'ask'],
      [['approval', '--token', 'tok', '--room', 'ab12cd', '-p', 'Ship?'], 'approval'],
      [['handoff', '--token', 'tok', '-m', 'Ship?', '--github-output', outputs], 'handoff'],
    ]) {
      const { status, stdout, stderr } = await runAsync([...argv, '--api', baseUrl], {}, { timeoutMs: 8000 });
      assert.equal(status, 1, `${argv.join(' ')}: ${stderr}`);
      assert.equal(stdout, '', 'no "undefined" id on stdout');
      assert.match(stderr, new RegExp(`${what} returned no id`));
    }
    assert.equal(readFileSync(outputs, 'utf8'), '', 'no empty question-id/handoff-id reaches the workflow');
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
