import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { chmodSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import {
  CLI, baseEnv, run, runAsync, questionServer, newHome, seedCredential, ACTIVE_PAIR, flakyPairingServer,
  ttyEnv,
} from './helpers.mjs';

test('exit 0: logout --help prints its focused help without flags it rejects', () => {
  const { status, stdout } = run(['logout', '--help']);
  assert.equal(status, 0);
  assert.match(stdout, /^logout:/);
  assert.match(stdout, /-h, --help/);
  // logout rejects --token/--api/--json, so its help must not advertise them.
  assert.doesNotMatch(stdout, /--token/);
  assert.doesNotMatch(stdout, /--json/);
});

// ---------------------------------------------------------------------------
// Connecting: credential store, config, pairing, logout
// ---------------------------------------------------------------------------

test('stored credential supplies the token and the room when no env/flag does', async () => {
  const home = newHome();
  seedCredential(home, { token: 'stored_tok', handle: 'agt_x', room: { invite_code: 'ABC123', name: 'Project X' } });
  const { server, baseUrl, received } = await questionServer({
    'POST /api/agent/rooms/ABC123/notifications': () => ({ status: 201, body: { id: 'n1' } }),
  });
  try {
    const { status, stdout } = await runAsync(['ping', '--api', baseUrl, '-m', 'hi'], { PINGROOM_HOME: home });
    assert.equal(status, 0);
    assert.match(stdout, /ping sent/);
    assert.equal(received[0].path, '/api/agent/rooms/ABC123/notifications');
    assert.equal(received[0].auth, 'Bearer stored_tok');
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('PINGROOM_TOKEN always wins over the stored credential (CI is unaffected)', async () => {
  const home = newHome();
  seedCredential(home, { token: 'stored_tok', handle: 'agt_x', room: { invite_code: 'ABC123', name: 'Project X' } });
  const { server, baseUrl, received } = await questionServer({
    'POST /api/agent/rooms/ABC123/notifications': () => ({ status: 201, body: { id: 'n1' } }),
  });
  try {
    const { status } = await runAsync(['ping', '--api', baseUrl, '-m', 'hi'], { PINGROOM_HOME: home, PINGROOM_TOKEN: 'env_tok' });
    assert.equal(status, 0);
    assert.equal(received[0].auth, 'Bearer env_tok');
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('--token outranks both the env var and the stored credential', async () => {
  const home = newHome();
  seedCredential(home, { token: 'stored_tok', room: { invite_code: 'ABC123' } });
  const { server, baseUrl, received } = await questionServer({
    'POST /api/agent/rooms/ABC123/notifications': () => ({ status: 201, body: { id: 'n1' } }),
  });
  try {
    const { status } = await runAsync(
      ['ping', '--api', baseUrl, '-m', 'hi', '--token', 'flag_tok'],
      { PINGROOM_HOME: home, PINGROOM_TOKEN: 'env_tok' },
    );
    assert.equal(status, 0);
    assert.equal(received[0].auth, 'Bearer flag_tok');
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('ping and both live paths refuse to redirect a stored credential to another origin', async () => {
  const home = newHome();
  seedCredential(home, {
    token: 'paired_tok',
    api_url: 'https://issuer.example.test',
    room: { invite_code: 'ABC123' },
  });
  const { server, baseUrl, received } = await questionServer({
    'POST /api/agent/rooms/ABC123/notifications': () => ({ status: 201, body: { id: 'n-never' } }),
    'POST /api/agent/rooms/ABC123/live': () => ({ status: 201, body: { success: true, state: 'running' } }),
    'GET /api/agent/rooms/ABC123/live/stream-1': () => ({ status: 200, body: { state: 'running' } }),
  });

  try {
    const commands = [
      ['ping', '--api', baseUrl, '-m', 'hi'],
      ['live', 'start', '--api', baseUrl, '-c', 'stream-1'],
      ['live', 'get', '--api', baseUrl, '-c', 'stream-1'],
    ];
    for (const command of commands) {
      const result = await runAsync(command, { PINGROOM_HOME: home });
      assert.equal(result.status, 2, command.join(' '));
      assert.match(result.stderr, /stored credential is bound/);
      assert.match(result.stderr, /--token or PINGROOM_TOKEN/);
    }
    assert.equal(received.length, 0, 'no direct bearer path may reach the override origin');
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('a corrupt credentials.json degrades to "not connected" instead of crashing', () => {
  const home = newHome();
  try {
    writeFileSync(join(home, 'credentials.json'), 'not json at all');
    const { status, stderr } = run(['ask', '--room', 'ab12cd', '-p', 'Deploy?'], { PINGROOM_HOME: home });
    assert.equal(status, 2);
    assert.match(stderr, /agent token is required/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('config set/get/list round-trips and rejects unknown keys and bad values', () => {
  const home = newHome();
  try {
    assert.match(run(['config', 'list'], { PINGROOM_HOME: home }).stdout, /no settings stored/);

    const set = run(['config', 'set', 'default_room', 'ab12cd'], { PINGROOM_HOME: home });
    assert.equal(set.status, 0);
    assert.match(set.stdout, /^default_room=ab12cd$/m);

    assert.equal(run(['config', 'get', 'default_room'], { PINGROOM_HOME: home }).stdout, 'ab12cd\n');
    // Unset keys print nothing and still exit 0, so `$(pingroom config get …)` is safe.
    const unset = run(['config', 'get', 'api_url'], { PINGROOM_HOME: home });
    assert.equal(unset.status, 0);
    assert.equal(unset.stdout, '');

    run(['config', 'set', 'api_url', 'https://api.example.test'], { PINGROOM_HOME: home });
    const listed = run(['config', 'list'], { PINGROOM_HOME: home });
    assert.match(listed.stdout, /^default_room=ab12cd$/m);
    assert.match(listed.stdout, /^api_url=https:\/\/api\.example\.test$/m);

    const unknown = run(['config', 'set', 'nope', 'x'], { PINGROOM_HOME: home });
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /unknown config key/);

    const cleartext = run(['config', 'set', 'api_url', 'http://evil.example'], { PINGROOM_HOME: home });
    assert.equal(cleartext.status, 2);
    assert.match(cleartext.stderr, /must use https/);

    // An empty value clears the key rather than storing "".
    assert.match(run(['config', 'set', 'api_url', ''], { PINGROOM_HOME: home }).stdout, /api_url cleared/);
    assert.equal(run(['config', 'get', 'api_url'], { PINGROOM_HOME: home }).stdout, '');

    const noSub = run(['config'], { PINGROOM_HOME: home });
    assert.equal(noSub.status, 2);
    assert.match(noSub.stderr, /config needs a subcommand/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('config default_room fills in for --room, and the flag/env still outrank it', async () => {
  const home = newHome();
  run(['config', 'set', 'default_room', 'cfgroom'], { PINGROOM_HOME: home });
  const { server, baseUrl, received } = await questionServer({
    'POST /api/agent/rooms/cfgroom/questions': () => ({ status: 201, body: { id: 'q_cfg', state: 'pending' } }),
    'POST /api/agent/rooms/envroom/questions': () => ({ status: 201, body: { id: 'q_env', state: 'pending' } }),
    'POST /api/agent/rooms/flagroom/questions': () => ({ status: 201, body: { id: 'q_flag', state: 'pending' } }),
  });
  try {
    const cfg = await runAsync(['ask', '--api', baseUrl, '--token', 't', '-p', 'Go?'], { PINGROOM_HOME: home });
    assert.equal(cfg.status, 0);
    assert.equal(cfg.stdout.trim(), 'q_cfg');

    const env = await runAsync(['ask', '--api', baseUrl, '--token', 't', '-p', 'Go?'], { PINGROOM_HOME: home, PINGROOM_ROOM: 'envroom' });
    assert.equal(env.stdout.trim(), 'q_env');

    const flag = await runAsync(
      ['ask', '--api', baseUrl, '--token', 't', '--room', 'flagroom', '-p', 'Go?'],
      { PINGROOM_HOME: home, PINGROOM_ROOM: 'envroom' },
    );
    assert.equal(flag.stdout.trim(), 'q_flag');
    assert.deepEqual(received.map((r) => r.path), [
      '/api/agent/rooms/cfgroom/questions',
      '/api/agent/rooms/envroom/questions',
      '/api/agent/rooms/flagroom/questions',
    ]);
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('config api_url becomes the API base when no flag or env var is given', async () => {
  const home = newHome();
  const { server, baseUrl, received } = await questionServer({
    'POST /api/agent/rooms/ab12cd/questions': () => ({ status: 201, body: { id: 'q_cfgapi', state: 'pending' } }),
  });
  try {
    // A loopback http base is the one cleartext exception, for local dev.
    run(['config', 'set', 'api_url', baseUrl], { PINGROOM_HOME: home });
    const { status, stdout } = await runAsync(
      ['ask', '--token', 't', '--room', 'ab12cd', '-p', 'Go?'],
      { PINGROOM_HOME: home, PINGROOM_API_URL: undefined },
    );
    assert.equal(status, 0);
    assert.equal(stdout.trim(), 'q_cfgapi');
    assert.equal(received.length, 1);
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('logout clears the credential, and says so when there was none', () => {
  const home = newHome();
  try {
    const empty = run(['logout'], { PINGROOM_HOME: home });
    assert.equal(empty.status, 0);
    assert.match(empty.stdout, /no stored credential/);

    seedCredential(home, { token: 'stored_tok', handle: 'agt_ab12cd34ef' });
    const out = run(['logout'], { PINGROOM_HOME: home });
    assert.equal(out.status, 0);
    assert.match(out.stdout, /logged out \(@agt_ab12cd34ef\)/);
    assert.throws(() => readFileSync(join(home, 'credentials.json'), 'utf8'));

    // After logout the tool is back to "not connected", not half-authenticated.
    const after = run(['ask', '--room', 'ab12cd', '-p', 'Deploy?'], { PINGROOM_HOME: home });
    assert.equal(after.status, 2);
    assert.match(after.stderr, /agent token is required/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('logout warns that PINGROOM_TOKEN keeps overriding it', () => {
  const home = newHome();
  seedCredential(home, { token: 'stored_tok' });
  try {
    const { stdout } = run(['logout'], { PINGROOM_HOME: home, PINGROOM_TOKEN: 'env_tok' });
    assert.match(stdout, /PINGROOM_TOKEN is still set/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('the credential is only ever presented to the host it was paired against', async () => {
  // saveCredential records api_url but resolveApiBase used to ignore it, so a
  // token minted by a staging/self-hosted server was sent to api.pingroom.io on
  // the very next command.
  const home = newHome();
  const { server, baseUrl, received } = await questionServer({
    'POST /api/agent/rooms/ABC123/questions': () => ({ status: 201, body: { id: 'q_paired', state: 'pending' } }),
  });
  try {
    seedCredential(home, {
      token: 'paired_tok',
      handle: 'agt_paired',
      room: { invite_code: 'ABC123' },
      api_url: baseUrl,
    });
    // No --api, no PINGROOM_API_URL, no config.api_url: only the credential says
    // where this token belongs.
    const { status, stdout } = await runAsync(['ask', '-p', 'Go?'], { PINGROOM_HOME: home, PINGROOM_API_URL: undefined });
    assert.equal(status, 0, stdout);
    assert.equal(stdout.trim(), 'q_paired');
    assert.equal(received.length, 1, 'the request must have reached the paired host');
    assert.equal(received[0].auth, 'Bearer paired_tok');
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('pairing writes the api_url the credential was minted at', async () => {
  const home = newHome();
  const stub = await flakyPairingServer([{ body: ACTIVE_PAIR }]);
  try {
    const { status } = await runAsync(
      ['--api', stub.baseUrl],
      ttyEnv(home, { COLUMNS: '20' }),
      { stdin: '1\n', timeoutMs: 15_000 },
    );
    assert.equal(status, 0);
    const cred = JSON.parse(readFileSync(join(home, 'credentials.json'), 'utf8'));
    assert.equal(cred.api_url, stub.baseUrl);
  } finally {
    stub.server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('config and env API overrides cannot redirect a stored credential to another origin', async () => {
  const home = newHome();
  const issuer = await questionServer({});
  const target = await questionServer({
    'POST /api/agent/rooms/ABC123/questions': () => ({ status: 201, body: { id: 'q_never', state: 'pending' } }),
  });
  try {
    seedCredential(home, { token: 'paired_tok', room: { invite_code: 'ABC123' }, api_url: issuer.baseUrl });

    run(['config', 'set', 'api_url', target.baseUrl], { PINGROOM_HOME: home });
    const viaConfig = await runAsync(['ask', '-p', 'Go?'], { PINGROOM_HOME: home });
    assert.equal(viaConfig.status, 2);
    assert.match(viaConfig.stderr, /stored credential is bound/);

    run(['config', 'set', 'api_url', ''], { PINGROOM_HOME: home });
    const viaEnv = await runAsync(['ask', '-p', 'Go?'], { PINGROOM_HOME: home, PINGROOM_API_URL: target.baseUrl });
    assert.equal(viaEnv.status, 2);
    assert.match(viaEnv.stderr, /--token or PINGROOM_TOKEN/);

    assert.equal(issuer.received.length, 0);
    assert.equal(target.received.length, 0, 'the stored bearer must not reach config/env override origins');
  } finally {
    issuer.server.close();
    target.server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('an explicit flag or env token permits an intentional custom-origin override', async () => {
  const home = newHome();
  const target = await questionServer({
    'POST /api/agent/rooms/ABC123/questions': () => ({ status: 201, body: { id: 'q_override', state: 'pending' } }),
  });
  seedCredential(home, {
    token: 'stored_tok',
    room: { invite_code: 'ABC123' },
    api_url: 'https://issuer.example.test',
  });

  try {
    const viaFlag = await runAsync(
      ['ask', '--api', target.baseUrl, '--token', 'flag_tok', '-p', 'Go?'],
      { PINGROOM_HOME: home },
    );
    assert.equal(viaFlag.status, 0, viaFlag.stderr);

    const viaEnv = await runAsync(['ask', '-p', 'Go?'], {
      PINGROOM_HOME: home,
      PINGROOM_API_URL: target.baseUrl,
      PINGROOM_TOKEN: 'env_tok',
    });
    assert.equal(viaEnv.status, 0, viaEnv.stderr);
    assert.deepEqual(target.received.map((request) => request.auth), ['Bearer flag_tok', 'Bearer env_tok']);
  } finally {
    target.server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('a same-origin API path override may use the stored credential', async () => {
  const home = newHome();
  const target = await questionServer({
    'POST /proxy/api/agent/rooms/ABC123/questions': () => ({ status: 201, body: { id: 'q_same_origin', state: 'pending' } }),
  });
  seedCredential(home, {
    token: 'paired_tok',
    room: { invite_code: 'ABC123' },
    api_url: `${target.baseUrl}/paired-path`,
  });

  try {
    const result = await runAsync(
      ['ask', '--api', `${target.baseUrl}/proxy`, '-p', 'Go?'],
      { PINGROOM_HOME: home },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'q_same_origin');
    assert.equal(target.received[0].auth, 'Bearer paired_tok');
  } finally {
    target.server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

// --- local state permissions ----------------------------------------------

/** Run the CLI under a specific umask, so mode assertions can't be vacuous. */
function runUmask(umask, args, env = {}) {
  const r = spawnSync('/bin/sh', ['-c', `umask ${umask}; exec "$0" "$@"`, process.execPath, CLI, ...args], {
    env: { ...baseEnv(), ...env },
    encoding: 'utf8',
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

test('a fresh state directory and file are created 0700/0600 even under a permissive umask', () => {
  // umask 000 is what makes this assertion mean something: without the explicit
  // mode/chmod the directory would land at 0777 and the file at 0666.
  const parent = newHome();
  const home = join(parent, 'state');
  try {
    const { status } = runUmask('000', ['config', 'set', 'default_room', 'ab12cd'], { PINGROOM_HOME: home });
    assert.equal(status, 0);
    assert.equal(statSync(home).mode & 0o777, 0o700);
    assert.equal(statSync(join(home, 'config.json')).mode & 0o777, 0o600);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('a pre-existing world-readable state file is tightened to 0600 on the next write', () => {
  // The original test only ever wrote a brand new file, so it passed with both
  // chmods deleted: `mode` on writeFileSync is ignored for an existing file.
  const home = newHome();
  const path = join(home, 'config.json');
  try {
    writeFileSync(path, '{"default_room":"old"}\n');
    chmodSync(path, 0o666);
    assert.equal(statSync(path).mode & 0o777, 0o666, 'precondition: the file starts loose');

    const { status } = runUmask('000', ['config', 'set', 'default_room', 'ab12cd'], { PINGROOM_HOME: home });
    assert.equal(status, 0);
    assert.equal(statSync(path).mode & 0o777, 0o600, '0666 -> 0600 is the tightening under test');
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).default_room, 'ab12cd');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a pre-existing state directory keeps the mode its owner chose', () => {
  // The directory is the user's, not ours: narrowing a deliberate 0755 to 0700
  // breaks anything else the user pointed at PINGROOM_HOME. Only a directory
  // this call created gets the 0700 treatment.
  const home = newHome();
  try {
    chmodSync(home, 0o755);
    const { status } = runUmask('022', ['config', 'set', 'default_room', 'ab12cd'], { PINGROOM_HOME: home });
    assert.equal(status, 0);
    assert.equal(statSync(home).mode & 0o777, 0o755, 'a pre-existing directory must be left alone');
    // The file inside is still ours to protect.
    assert.equal(statSync(join(home, 'config.json')).mode & 0o777, 0o600);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a config write replaces the file rather than truncating it in place', () => {
  // Writing in place means a crash or a full disk between truncate and write
  // leaves an unparseable file, and readConfigFile degrades that to {} — so the
  // next `config set` silently discards every other setting. rename() means a
  // reader only ever sees the whole old file or the whole new one.
  const home = newHome();
  const path = join(home, 'config.json');
  try {
    run(['config', 'set', 'default_room', 'ab12cd'], { PINGROOM_HOME: home });
    const firstInode = statSync(path).ino;

    run(['config', 'set', 'api_url', 'https://api.example.test'], { PINGROOM_HOME: home });
    const secondInode = statSync(path).ino;

    // A rename swaps in a different file; an in-place write keeps the inode.
    assert.notEqual(secondInode, firstInode, 'the write must be a rename, not a truncate');

    const stored = JSON.parse(readFileSync(path, 'utf8'));
    assert.deepEqual(stored, { default_room: 'ab12cd', api_url: 'https://api.example.test' });

    const leftovers = readdirSync(home).filter((f) => f.endsWith('.tmp'));
    assert.deepEqual(leftovers, [], 'the temp file must be renamed away, not left in place');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('config set api_url refuses URL user credentials', () => {
  const home = newHome();
  try {
    const { status, stderr } = run(['config', 'set', 'api_url', 'https://u:p@api.example.com'], { PINGROOM_HOME: home });
    assert.equal(status, 2);
    assert.match(stderr, /api_url must not contain URL user credentials/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
